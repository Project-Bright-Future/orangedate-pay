import { describe, it, expect } from "vitest";
import {
  resolveKolCode,
  parseCookie,
  serializeCookie,
  formatTpeDate,
  landingView,
  SOLD_OUT_COPY,
} from "../src/kol-checkout.js";

describe("resolveKolCode", () => {
  it("embed > query > cookie", () => {
    expect(resolveKolCode({ embed: "A1", query: "B1", cookie: "C1" })).toBe("A1");
    expect(resolveKolCode({ embed: "", query: "B1", cookie: "C1" })).toBe("B1");
    expect(resolveKolCode({ embed: "", query: "", cookie: "C1" })).toBe("C1");
  });
  it("大寫 + trim；全空回空字串", () => {
    expect(resolveKolCode({ embed: " testkol1 " })).toBe("TESTKOL1");
    expect(resolveKolCode({})).toBe("");
  });
  it("Webflow 未綁定欄位時 embed 會是模板字面值 → 視為空", () => {
    expect(resolveKolCode({ embed: '{{wf {"path":"kol-code"} }}', query: "b1" })).toBe("B1");
  });
});

describe("cookie helpers", () => {
  it("parseCookie 取指定名稱、解碼", () => {
    expect(parseCookie("a=1; od_kol=TEST%20K; b=2", "od_kol")).toBe("TEST K");
    expect(parseCookie("a=1", "od_kol")).toBeNull();
    expect(parseCookie("", "od_kol")).toBeNull();
  });
  it("serializeCookie 30 天、Path=/、SameSite=Lax、Secure", () => {
    expect(serializeCookie("od_kol", "TESTKOL1", { maxAgeSec: 30 * 86400 })).toBe(
      "od_kol=TESTKOL1; Max-Age=2592000; Path=/; SameSite=Lax; Secure"
    );
  });
});

describe("formatTpeDate", () => {
  it("UTC ISO → 台北日期 YYYY/MM/DD", () => {
    expect(formatTpeDate("2026-12-31T15:59:59Z")).toBe("2026/12/31");
    expect(formatTpeDate("2026-12-31T16:00:00Z")).toBe("2027/01/01");
  });
  it("空 / 壞值 → 空字串", () => {
    expect(formatTpeDate(null)).toBe("");
    expect(formatTpeDate("nope")).toBe("");
  });
});

const promoOk = {
  kol_code: "TESTKOL1", kol_display_name: "測試 KOL", product_code: "kol_prestige_3m_2400",
  price_twd: 2400, list_price_twd: 2700, grant_days: 90,
  valid_until: "2026-12-31T15:59:59Z", is_available: true, unavailable_reason: null,
};

describe("landingView", () => {
  it("可用 → CTA 啟用、價格與到期日", () => {
    const v = landingView({ httpStatus: 200, body: promoOk }, "");
    expect(v).toMatchObject({
      available: true, ctaDisabled: false, displayName: "測試 KOL",
      price: "2,400", listPrice: "2,700", validUntil: "2026/12/31", code: "TESTKOL1", notice: null,
    });
  });
  it("sold_out / expired / 404 → 額滿文案（含 display_name）、CTA 停用", () => {
    for (const body of [
      { ...promoOk, is_available: false, unavailable_reason: "sold_out" },
      { ...promoOk, is_available: false, unavailable_reason: "expired" },
    ]) {
      const v = landingView({ httpStatus: 200, body }, "");
      expect(v.ctaDisabled).toBe(true);
      expect(v.notice).toBe(SOLD_OUT_COPY("測試 KOL"));
    }
    const v404 = landingView({ httpStatus: 404, body: { code: "promo_not_found" } }, "嵌入名");
    expect(v404.ctaDisabled).toBe(true);
    expect(v404.notice).toBe(SOLD_OUT_COPY("嵌入名"));
  });
  it("inactive / not_started → CTA 停用、失效文案", () => {
    const v = landingView({ httpStatus: 200, body: { ...promoOk, is_available: false, unavailable_reason: "not_started" } }, "");
    expect(v.ctaDisabled).toBe(true);
    expect(v.notice).toBe("這組優惠碼已經失效了");
  });
  it("display_name 優先用 API，其次 embed", () => {
    expect(landingView({ httpStatus: 200, body: promoOk }, "嵌入名").displayName).toBe("測試 KOL");
    expect(landingView({ httpStatus: 404, body: {} }, "嵌入名").displayName).toBe("嵌入名");
  });
});

// ---- 第二輪：OTP / 步驟二 ----
import {
  otpCreateRoute,
  otpVerifyRoute,
  retryAfterSeconds,
  planView,
  promoCheckRoute,
  BANNED_COPY,
} from "../src/kol-checkout.js";

const hdr = (h = {}) => (k) => h[k.toLowerCase()] ?? null;

describe("otpCreateRoute", () => {
  it("201 → sent + token + phoneMasked", () => {
    expect(otpCreateRoute({ httpStatus: 201, body: { token: "PBFM", phone_masked: "0944***093" }, header: hdr() }))
      .toEqual({ action: "sent", token: "PBFM", phoneMasked: "0944***093" });
  });
  it("400 DRF 欄位錯誤 → 顯示第一則", () => {
    expect(otpCreateRoute({ httpStatus: 400, body: { phone_number: ["僅開放台灣手機號碼"] }, header: hdr() }))
      .toEqual({ action: "error", message: "僅開放台灣手機號碼" });
  });
  it("403 user_banned → banned（分支 e）", () => {
    expect(otpCreateRoute({ httpStatus: 403, body: { code: "user_banned" }, header: hdr() }))
      .toEqual({ action: "banned", message: BANNED_COPY });
  });
  it("429 Retry-After ≥ 3600 → 今天用完；否則稍後再試；reason=rate_limited", () => {
    expect(otpCreateRoute({ httpStatus: 429, body: { code: "otp_rate_limited" }, header: hdr({ "retry-after": "3600" }) }))
      .toEqual({ action: "error", message: "今天的驗證次數用完了，明天再試，或在 LINE 找我們", reason: "rate_limited" });
    expect(otpCreateRoute({ httpStatus: 429, body: { code: "otp_rate_limited" }, header: hdr({ "retry-after": "45" }) }))
      .toEqual({ action: "error", message: "請稍後再試", reason: "rate_limited" });
    expect(otpCreateRoute({ httpStatus: 429, body: {}, header: hdr() }).message).toBe("請稍後再試");
  });
  it("503 / 其他 → detail 或預設", () => {
    expect(otpCreateRoute({ httpStatus: 503, body: { code: "sms_service_error", detail: "簡訊服務暫時無法使用，請稍後再試" }, header: hdr() }))
      .toEqual({ action: "error", message: "簡訊服務暫時無法使用，請稍後再試" });
    expect(otpCreateRoute({ httpStatus: 500, body: {}, header: hdr() }).message).toBe("系統忙線中，請稍後再試");
  });
});

describe("retryAfterSeconds", () => {
  it("秒數字串 / 空 / HTTP-date", () => {
    expect(retryAfterSeconds("3600")).toBe(3600);
    expect(retryAfterSeconds(null)).toBe(0);
    const future = new Date(Date.now() + 7200 * 1000).toUTCString();
    expect(retryAfterSeconds(future)).toBeGreaterThan(7000);
  });
});

const verifyBase = {
  checkout_token: "ct", expires_in: 1800, user_state: "existing", display_name: "小明",
  membership: null, projected_expire_at: "2026-12-14T05:00:00Z",
};

describe("otpVerifyRoute", () => {
  it("existing + membership null → 分支 a", () => {
    const r = otpVerifyRoute({ httpStatus: 200, body: verifyBase });
    expect(r).toMatchObject({ action: "verified", branch: "a", checkoutToken: "ct", userState: "existing", displayName: "小明" });
  });
  it("standard → b；premium → c；new → d", () => {
    expect(otpVerifyRoute({ httpStatus: 200, body: { ...verifyBase, user_state: "active_sub", membership: { entitlement: "standard", expires_at: "2026-10-16T00:00:00Z" } } }).branch).toBe("b");
    expect(otpVerifyRoute({ httpStatus: 200, body: { ...verifyBase, user_state: "active_sub", membership: { entitlement: "premium", expires_at: "2027-03-14T00:00:00Z" } } }).branch).toBe("c");
    expect(otpVerifyRoute({ httpStatus: 200, body: { ...verifyBase, user_state: "new", display_name: null } }).branch).toBe("d");
  });
  it("otp_invalid → wrong；otp_expired → expired + 可重送；otp_max_attempts → 提示重送（無 30 分鎖）", () => {
    expect(otpVerifyRoute({ httpStatus: 400, body: { code: "otp_invalid", detail: "驗證碼錯誤" } }))
      .toEqual({ action: "error", message: "驗證碼錯誤", reason: "wrong", resend: false });
    expect(otpVerifyRoute({ httpStatus: 400, body: { code: "otp_expired", detail: "驗證碼已過期" } }))
      .toEqual({ action: "error", message: "驗證碼已過期，請重新傳送", reason: "expired", resend: true });
    expect(otpVerifyRoute({ httpStatus: 400, body: { code: "otp_max_attempts", detail: "錯誤次數過多" } }))
      .toEqual({ action: "error", message: "錯誤次數過多，請重新傳送驗證碼", reason: "wrong", resend: true });
  });
  it("403 user_banned → banned", () => {
    expect(otpVerifyRoute({ httpStatus: 403, body: { code: "user_banned" } })).toEqual({ action: "banned", message: BANNED_COPY });
  });
});

const promoBody = {
  kol_code: "TESTKOL1", kol_display_name: "測試 KOL", price_twd: 2400, list_price_twd: 2700, grant_days: 90,
  valid_until: "2026-12-31T15:59:59Z", is_available: true, unavailable_reason: null,
};
const today = new Date("2026-09-15T02:00:00Z"); // TPE 2026/09/15

describe("planView", () => {
  it("分支 a：歡迎回來 + 權益期間行", () => {
    const v = planView({ branch: "a", displayName: "小明", projectedExpireAt: "2026-12-13T05:00:00Z" }, promoBody, today);
    expect(v).toMatchObject({
      branchText: "歡迎回來，小明",
      price: "2,400", listPrice: "2,700", discount: "300", code: "TESTKOL1",
      appliedLabel: "✓ 已套用測試 KOL專屬價",
      periodLine: "權益期間 2026/09/15 起算，共 90 天，至 2026/12/13 到期",
    });
  });
  it("分支 a 無 display_name → 歡迎回來（無逗號名字）", () => {
    expect(planView({ branch: "a", displayName: null, projectedExpireAt: "2026-12-13T05:00:00Z" }, promoBody, today).branchText).toBe("歡迎回來");
  });
  it("分支 b：誠心到期日 + 升級說明", () => {
    const v = planView({ branch: "b", membership: { entitlement: "standard", expires_at: "2026-10-16T00:00:00Z" }, projectedExpireAt: "2026-12-13T05:00:00Z" }, promoBody, today);
    expect(v.branchText).toBe("你目前是誠心會員，到期日 2026/10/16。購買後會立即升級尊榮，剩餘的誠心天數會接在尊榮之後繼續使用。");
    expect(v.periodLine).toContain("2026/12/13 到期");
  });
  it("分支 c：尊榮到期 + 延長；不顯示「今天起算」行", () => {
    const v = planView({ branch: "c", membership: { entitlement: "premium", expires_at: "2027-03-14T00:00:00Z" }, projectedExpireAt: "2027-06-12T00:00:00Z" }, promoBody, today);
    expect(v.branchText).toBe("你目前是尊榮會員（到期 2027/03/14）。購買後到期日會延長到 2027/06/12。");
    expect(v.periodLine).toBeNull();
  });
  it("分支 d：無身分文案", () => {
    expect(planView({ branch: "d", projectedExpireAt: "2026-12-13T05:00:00Z" }, promoBody, today).branchText).toBeNull();
  });
});

describe("promoCheckRoute", () => {
  it("200 可用 → ok + promo", () => {
    expect(promoCheckRoute({ httpStatus: 200, body: promoBody })).toEqual({ ok: true, promo: promoBody });
  });
  it("任一 reason / 404 → 失效文案", () => {
    expect(promoCheckRoute({ httpStatus: 200, body: { ...promoBody, is_available: false, unavailable_reason: "inactive" } }))
      .toEqual({ ok: false, message: "這組優惠碼已經失效了" });
    expect(promoCheckRoute({ httpStatus: 404, body: { code: "promo_not_found" } })).toEqual({ ok: false, message: "這組優惠碼已經失效了" });
  });
});

// ---- 第三輪：條款 / 訂單 ----
import { termsRoute, buildOrderPayload, orderRoute, canPay } from "../src/kol-checkout.js";

const terms = {
  tos: { id: 1, version: "2026-09", content_url: "https://t/tos", effective_at: "2026-09-01T00:00:00Z" },
  privacy: { id: 2, version: "2026-09", content_url: "https://t/privacy", effective_at: "2026-09-01T00:00:00Z" },
  cooling_off_waiver: { id: 3, version: "2026-09", content_url: "https://t/waiver", effective_at: "2026-09-01T00:00:00Z" },
};

describe("termsRoute", () => {
  it("200 → ok + terms", () => expect(termsRoute({ httpStatus: 200, body: terms })).toEqual({ ok: true, terms }));
  it("503 terms_not_configured → 整頁不可付款", () =>
    expect(termsRoute({ httpStatus: 503, body: { code: "terms_not_configured" } })).toEqual({ ok: false, message: "條款尚未設定，目前無法付款" }));
});

describe("buildOrderPayload", () => {
  it("組 POST orders/ body（無 email、consents 固定 true、三個版本 id）", () => {
    expect(buildOrderPayload({ checkoutToken: "ct", promoCode: "testkol1", txnToken: "tx", terms })).toEqual({
      checkout_token: "ct",
      promo_code: "testkol1",
      txn_token: "tx",
      consents: { terms_privacy: true, no_cooling_off: true },
      terms_version_ids: { tos: 1, privacy: 2, cooling_off_waiver: 3 },
    });
  });
});

describe("orderRoute", () => {
  const base = { merchant_order_id: "KOL-20260915-001", amount: 2400, user_id: 123 };
  it("200 paid → done", () =>
    expect(orderRoute({ httpStatus: 200, body: { ...base, status: "paid", expire_at: "2026-12-14T05:00:00Z" } }))
      .toEqual({ action: "done", orderId: "KOL-20260915-001", userId: 123 }));
  it("200 pending + redirect_url → redirect（3DS）", () =>
    expect(orderRoute({ httpStatus: 200, body: { ...base, status: "pending_payment", redirect_url: "https://91app/3ds" } }))
      .toEqual({ action: "redirect", url: "https://91app/3ds", orderId: "KOL-20260915-001", userId: 123 }));
  it("200 pending 無 redirect → poll", () =>
    expect(orderRoute({ httpStatus: 200, body: { ...base, status: "pending_payment" } }))
      .toEqual({ action: "poll", orderId: "KOL-20260915-001", userId: 123 }));
  it("401 token 過期/無效 → back_step1", () => {
    for (const code of ["checkout_token_expired", "checkout_token_invalid"]) {
      expect(orderRoute({ httpStatus: 401, body: { code, detail: "d" } })).toEqual({ action: "back_step1", message: "d" });
    }
  });
  it("400 promo_unavailable → promo_dead；terms_outdated → terms_outdated；consent_required → back_step3", () => {
    expect(orderRoute({ httpStatus: 400, body: { code: "promo_unavailable", detail: "x" } })).toEqual({ action: "promo_dead", message: "這組優惠碼已經失效了" });
    expect(orderRoute({ httpStatus: 400, body: { code: "terms_outdated", detail: "條款已更新" } })).toEqual({ action: "terms_outdated", message: "條款已更新" });
    expect(orderRoute({ httpStatus: 400, body: { code: "consent_required", detail: "請勾選" } })).toEqual({ action: "back_step3", message: "請勾選" });
  });
  it("409 order_pending 帶單號 → poll；不帶 → error", () => {
    expect(orderRoute({ httpStatus: 409, body: { code: "order_pending", merchant_order_id: "KOL-1" } })).toEqual({ action: "poll", orderId: "KOL-1", userId: undefined });
    expect(orderRoute({ httpStatus: 409, body: { code: "order_pending", detail: "已有進行中的訂單" } })).toEqual({ action: "error", message: "已有進行中的訂單" });
  });
  it("payment_declined → declined（留步驟三）；payment_error → error 稍後再試", () => {
    expect(orderRoute({ httpStatus: 400, body: { code: "payment_declined" } })).toEqual({ action: "declined", message: "信用卡遭拒絕，請換一張卡或聯繫發卡行" });
    expect(orderRoute({ httpStatus: 400, body: { code: "payment_error", detail: "付款系統忙線，請稍後再試" } })).toEqual({ action: "error", message: "付款系統忙線，請稍後再試" });
    expect(orderRoute({ httpStatus: 500, body: { code: "payment_error" } }).message).toBe("付款系統忙線，請稍後再試");
  });
  it("403 user_banned → banned；503 terms_not_configured → unavailable", () => {
    expect(orderRoute({ httpStatus: 403, body: { code: "user_banned" } })).toEqual({ action: "banned", message: BANNED_COPY });
    expect(orderRoute({ httpStatus: 503, body: { code: "terms_not_configured" } })).toEqual({ action: "unavailable", message: "條款尚未設定，目前無法付款" });
  });
  it("未知錯誤 → error 預設文案", () =>
    expect(orderRoute({ httpStatus: 502, body: {} })).toEqual({ action: "error", message: "系統忙線中，請稍後再試" }));
});

describe("canPay", () => {
  const ok = { consent1: true, consent2: true, termsLoaded: true, promoOk: true, cardOk: true, busy: false };
  it("全部齊 → true", () => expect(canPay(ok)).toBe(true));
  it("缺任一 → false", () => {
    for (const k of ["consent1", "consent2", "termsLoaded", "promoOk", "cardOk"]) expect(canPay({ ...ok, [k]: false })).toBe(false);
    expect(canPay({ ...ok, busy: true })).toBe(false);
  });
});

// ---- 第四輪：render（HTML 字串） ----
import {
  escapeHtml,
  renderLanding,
  renderStep1,
  renderOtpCells,
  renderStep2,
  renderStep3,
  LEGAL_LINE,
  STYLES,
} from "../src/kol-checkout.js";

describe("STYLES", () => {
  it("同意勾選內的 <a> 保持 inline（v1.1.1：Webflow 全站 a 樣式會把它擠成獨立行）", () => {
    expect(STYLES).toMatch(/\.odk-check a \{[^}]*display: inline;/);
  });
});

describe("escapeHtml", () => {
  it("跳脫 < > & \" '", () => expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;"));
});

describe("renderLanding", () => {
  const v = landingView({ httpStatus: 200, body: promoOk }, "");
  it("含 C-1-1 文案、價格、到期日、CTA 啟用", () => {
    const h = renderLanding(v);
    expect(h).toContain("測試 KOL × 橘時相遇 · 粉絲專屬");
    expect(h).toContain("尊榮會員 三個月");
    expect(h).toContain("NT$2,400");
    expect(h).toContain("牌告定價 NT$2,700");
    expect(h).toContain("比單月購買三次，省下 NT$1,200");
    expect(h).toContain("用測試 KOL的專屬價加入 →");
    expect(h).toContain("專屬價開放至 2026/12/31，測試 KOL合作期間共 1,000 個名額");
    expect(h).toContain("一次購買三個月，不會自動續訂，不會自動扣款");
    expect(h).toContain("會員權益自付款當日起算，共 90 天");
    expect(h).toContain("到期後想繼續，可以在 App 內續訂");
    expect(h).toContain('id="odk-cta"');
    expect(h).not.toMatch(/id="odk-cta"[^>]*disabled/);
  });
  it("不可用 → CTA disabled + notice", () => {
    const h = renderLanding(landingView({ httpStatus: 200, body: { ...promoOk, is_available: false, unavailable_reason: "sold_out" } }, ""));
    expect(h).toMatch(/id="odk-cta"[^>]*disabled/);
    expect(h).toContain(SOLD_OUT_COPY("測試 KOL"));
  });
  it("display_name 會跳脫", () => {
    expect(renderLanding(landingView({ httpStatus: 200, body: { ...promoOk, kol_display_name: "<b>x</b>" } }, ""))).not.toContain("<b>x</b>");
  });
});

describe("renderStep1", () => {
  it("含手機輸入、傳送鈕、說明；OTP 區塊初始隱藏", () => {
    const h = renderStep1();
    expect(h).toContain("步驟 1 / 3");
    expect(h).toContain("確認你的手機號碼");
    expect(h).toContain('id="odk-phone"');
    expect(h).toContain('placeholder="09XX XXX XXX"');
    expect(h).toContain('id="odk-send"');
    expect(h).toContain("我們用手機號碼幫你開通會員，也用它登入 App。請填你之後會用來登入的號碼。");
    expect(h).toMatch(/id="odk-otp-block"[^>]*hidden/);
    expect(h).toContain('id="odk-otp"');
    expect(h).toContain('id="odk-verify"');
    expect(h).toContain("60 秒後可以重新傳送");
  });

  it("v1.2.0：兩欄有文字標籤（C-1-2）", () => {
    const h = renderStep1();
    expect(h).toMatch(/<label for="odk-phone"[^>]*>手機號碼<\/label>/);
    expect(h).toMatch(/<label for="odk-otp"[^>]*>驗證碼<\/label>/);
  });

  it("v1.2.0：驗證碼是單一 one-time-code input 疊在六格上", () => {
    const h = renderStep1();
    expect(h).toMatch(/<input id="odk-otp"[^>]*autocomplete="one-time-code"/);
    expect(h).not.toMatch(/<input id="odk-otp"[^>]*maxlength/); // 不設 maxlength：貼上「123 456」會被原生先截成 6 字元再少一碼；6 碼上限由 glue 過濾後 slice
    expect(h).toContain('id="odk-otp-cells"');
    expect(h.match(/class="odk-cell"/g)).toHaveLength(6); // 精確比對，避免撞到 .odk-cells 容器
  });
});

describe("renderOtpCells", () => {
  const cells = (h) => [...h.matchAll(/<span class="(odk-cell[^"]*)"[^>]*>([^<]*)<\/span>/g)].map((m) => [m[1], m[2]]);
  it("空值 + 聚焦第 0 格：六格全空、只有第 0 格 active", () => {
    const c = cells(renderOtpCells("", 0));
    expect(c).toHaveLength(6);
    expect(c.map((x) => x[1])).toEqual(["", "", "", "", "", ""]);
    expect(c.map((x) => x[0].includes("active"))).toEqual([true, false, false, false, false, false]);
  });
  it("輸入 12、游標在 2：前兩格有字、第 2 格 active", () => {
    const c = cells(renderOtpCells("12", 2));
    expect(c.map((x) => x[1])).toEqual(["1", "2", "", "", "", ""]);
    expect(c.map((x) => x[0].includes("active"))).toEqual([false, false, true, false, false, false]);
  });
  it("填滿 6 碼：active 停在最後一格", () => {
    const c = cells(renderOtpCells("123456", 5));
    expect(c.map((x) => x[1])).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(c[5][0]).toContain("active");
  });
  it("未聚焦（activeIndex null）：沒有任何 active", () => {
    const c = cells(renderOtpCells("12", null));
    expect(c.some((x) => x[0].includes("active"))).toBe(false);
  });
  it("字元會 escape", () => {
    expect(renderOtpCells("<", null)).not.toContain("><<");
    expect(renderOtpCells("<", null)).toContain("&lt;");
  });
});

describe("renderStep2", () => {
  const pv = planView({ branch: "b", membership: { entitlement: "standard", expires_at: "2026-10-16T00:00:00Z" }, projectedExpireAt: "2026-12-13T05:00:00Z" }, promoBody, today);
  it("含分支文案、價格、折扣、優惠碼欄、權益期間、下一步", () => {
    const h = renderStep2(pv);
    expect(h).toContain("步驟 2 / 3");
    expect(h).toContain(pv.branchText);
    expect(h).toContain("NT$2,400");
    expect(h).toContain("牌告定價 NT$2,700");
    expect(h).toContain("−NT$300");
    expect(h).toContain('id="odk-code"');
    expect(h).toContain('value="TESTKOL1"');
    expect(h).toContain("✓ 已套用測試 KOL專屬價");
    expect(h).toContain(pv.periodLine);
    expect(h).toContain('id="odk-next2"');
  });
  it("分支 d：無身分段落；分支 c：無權益期間行", () => {
    expect(renderStep2(planView({ branch: "d", projectedExpireAt: "2026-12-13T05:00:00Z" }, promoBody, today))).not.toContain('class="odk-branch"');
    expect(renderStep2(planView({ branch: "c", membership: { entitlement: "premium", expires_at: "2027-03-14T00:00:00Z" }, projectedExpireAt: "2027-06-12T00:00:00Z" }, promoBody, today))).not.toContain("起算");
  });
});

describe("renderStep3", () => {
  const h = renderStep3({ price: "2,400", terms, company: { taxId: "12345678", address: "台北市信義區" } });
  it("兩個勾選 + 三個條款連結指向 terms/current 的 content_url", () => {
    expect(h).toContain('id="odk-c1"');
    expect(h).toContain('id="odk-c2"');
    expect(h).toContain('href="https://t/tos"');
    expect(h).toContain('href="https://t/privacy"');
    expect(h).toContain('href="https://t/waiver"');
    expect(h).toContain("《服務條款》");
    expect(h).toContain("《隱私權政策》");
    expect(h).toContain("開通後不適用七日猶豫期");
  });
  it("法律句不可移除、公司資訊、客服", () => {
    expect(LEGAL_LINE).toBe("本方案為線上交友服務訂閱，不包含實體活動報名。");
    expect(h).toContain(LEGAL_LINE);
    expect(h).toContain("橘齡未來股份有限公司｜統一編號 12345678｜台北市信義區");
    expect(h).toContain("客服 contact@orangedate.com｜LINE @orangedate");
  });
  it("91APP 三個 div + 付款鈕初始 disabled", () => {
    for (const id of ["card-number", "card-expiration-date", "card-ccv"]) expect(h).toContain(`id="${id}"`);
    expect(h).toMatch(/id="odk-pay"[^>]*disabled/);
    expect(h).toContain("前往付款 NT$2,400");
  });
});

import { normalizePhone } from "../src/kol-checkout.js";
describe("normalizePhone", () => {
  it("去空白/破折，09 開頭 10 碼才回；否則空字串", () => {
    expect(normalizePhone("0944 000 093")).toBe("0944000093");
    expect(normalizePhone("0944-000-093")).toBe("0944000093");
    expect(normalizePhone("944000093")).toBe("");
    expect(normalizePhone("0212345678")).toBe("");
    expect(normalizePhone("")).toBe("");
  });
});

import { eventProps, analyticsEnvironment } from "../src/kol-checkout.js";
describe("analytics props", () => {
  it("91APP env production → prod，其餘 → dev", () => {
    expect(analyticsEnvironment("production")).toBe("prod");
    expect(analyticsEnvironment("sandbox")).toBe("dev");
    expect(analyticsEnvironment(undefined)).toBe("dev");
  });
  it("每個事件帶 kol_code / environment / event_source=web + 額外參數；不含手機", () => {
    expect(eventProps({ kolCode: "TESTKOL1", env: "sandbox" }, { attempt_no: 2 })).toEqual({
      kol_code: "TESTKOL1", environment: "dev", event_source: "web", attempt_no: 2,
    });
  });
});
