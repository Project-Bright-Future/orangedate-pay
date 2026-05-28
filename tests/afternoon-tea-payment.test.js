import { describe, it, expect } from "vitest";
import {
  buildQuotePayload,
  buildRegistrationPayload,
  routeRegistrationResponse,
  formatQuoteResult,
  sessionGenderOpen,
  formatDeadline,
  formatSessionCard,
  canAutoQuote,
  normalizeGender,
  normalizePricingPlan,
  validateForm,
} from "../src/afternoon-tea-payment.js";

const sampleForm = {
  session_id: 1,
  name: "王小明",
  gender: "male",
  age: 30,
  phone: "0912345678",
  email: "ming@example.com",
  nickname: "小明",
  occupation_category: "科技業或工程師",
  dietary_preference: "都可以",
  pricing_plan: "verified",
  note: "會晚到",
};

describe("buildQuotePayload", () => {
  it("只取 quote 需要的欄位", () => {
    expect(buildQuotePayload(sampleForm)).toEqual({
      session_id: 1,
      phone: "0912345678",
      pricing_plan: "verified",
    });
  });
});

describe("buildRegistrationPayload", () => {
  it("帶入 txn_token 並保留所有報名欄位", () => {
    const out = buildRegistrationPayload(sampleForm, "tok_abc");
    expect(out.txn_token).toBe("tok_abc");
    expect(out.session_id).toBe(1);
    expect(out.email).toBe("ming@example.com");
    expect(out.pricing_plan).toBe("verified");
  });

  it("免費方案（無 token）txn_token 為空字串", () => {
    const out = buildRegistrationPayload({ ...sampleForm, pricing_plan: "subscriber" }, "");
    expect(out.txn_token).toBe("");
  });
});

describe("routeRegistrationResponse", () => {
  it("有 redirect_url → 導去 3DS（優先於 status）", () => {
    const r = routeRegistrationResponse(
      { status: "pending_payment", redirect_url: "https://3ds.91app/x", merchant_order_id: "TEA-1" },
      200
    );
    expect(r).toEqual({ action: "redirect", url: "https://3ds.91app/x" });
  });

  it("status=confirmed 且無 redirect → 成功頁（帶 order）", () => {
    const r = routeRegistrationResponse(
      { status: "confirmed", merchant_order_id: "TEA-1" },
      200
    );
    expect(r).toEqual({ action: "success", orderId: "TEA-1" });
  });

  it("HTTP 400 → 顯示後端 error 訊息", () => {
    const r = routeRegistrationResponse({ error: "男性名額已滿" }, 400);
    expect(r).toEqual({ action: "error", message: "男性名額已滿" });
  });

  it("400 但無 error 欄位 → 通用訊息", () => {
    const r = routeRegistrationResponse({}, 400);
    expect(r.action).toBe("error");
    expect(r.message).toMatch(/稍後再試/);
  });
});

describe("formatQuoteResult", () => {
  it("amount>0 → 需要卡片，顯示金額", () => {
    expect(formatQuoteResult({ plan: "general", amount: 300 })).toEqual({
      needsCard: true,
      amount: 300,
      message: "你的方案為「一般報名」，需支付 NT$300。",
    });
  });

  it("amount=0 → 免費，不需卡片", () => {
    expect(formatQuoteResult({ plan: "subscriber", amount: 0 })).toEqual({
      needsCard: false,
      amount: 0,
      message: "你符合付費訂閱會員資格，本次免費，無須付款。",
    });
  });

  it("verified 100", () => {
    const r = formatQuoteResult({ plan: "verified", amount: 100 });
    expect(r.needsCard).toBe(true);
    expect(r.message).toContain("NT$100");
  });
});

describe("sessionGenderOpen", () => {
  const session = { is_male_open: true, is_female_open: false };
  it("男生可報名", () => expect(sessionGenderOpen(session, "male")).toBe(true));
  it("女生已滿", () => expect(sessionGenderOpen(session, "female")).toBe(false));
});

describe("formatDeadline", () => {
  it("ISO 字串 → 報名至 M/D HH:mm", () => {
    // 用台北時區（UTC+8）的時刻：2026-06-05 23:59 in TPE
    expect(formatDeadline("2026-06-05T23:59:00+08:00")).toMatch(
      /^報名至 6\/5 \d{2}:\d{2}$/
    );
  });
  it("正中午個位數月份日期", () => {
    expect(formatDeadline("2026-06-05T12:00:00+08:00")).toMatch(
      /^報名至 6\/5 \d{2}:00$/
    );
  });
  it("null → 空字串", () => {
    expect(formatDeadline(null)).toBe("");
  });
  it("undefined → 空字串", () => {
    expect(formatDeadline(undefined)).toBe("");
  });
  it("空字串 → 空字串", () => {
    expect(formatDeadline("")).toBe("");
  });
  it("無效字串 → 空字串", () => {
    expect(formatDeadline("not-a-date")).toBe("");
  });
});

describe("formatSessionCard", () => {
  const s = {
    id: 1, title: "週六午後場", date: "2026-06-14",
    start_time: "14:00:00", end_time: "16:00:00",
    location_name: "某某咖啡廳",
    remaining_male: 2, remaining_female: 0,
    is_male_open: true, is_female_open: false,
  };
  it("組出卡片顯示欄位（無 registration_end_at → deadlineLabel 空）", () => {
    expect(formatSessionCard(s)).toEqual({
      id: 1,
      title: "週六午後場",
      timeLabel: "2026-06-14 14:00–16:00",
      location: "某某咖啡廳",
      deadlineLabel: "",
      maleLabel: "男生剩餘名額：2",
      femaleLabel: "女生剩餘名額：0",
      soldOut: false,
    });
  });
  it("男女名額皆關閉 → soldOut=true", () => {
    expect(
      formatSessionCard({ ...s, is_male_open: false, is_female_open: false }).soldOut
    ).toBe(true);
  });
  // 只驗新欄位；其餘欄位的 shape 已由上方測試 1 用 toEqual 覆蓋。
  it("有 registration_end_at → deadlineLabel 含「報名至」", () => {
    const out = formatSessionCard({ ...s, registration_end_at: "2026-06-10T23:59:00+08:00" });
    expect(out.deadlineLabel).toMatch(/^報名至 6\/10 /);
  });
});

describe("normalizeGender", () => {
  it("Webflow Male → male", () => expect(normalizeGender("Male")).toBe("male"));
  it("Webflow Female → female", () => expect(normalizeGender("Female")).toBe("female"));
  it("已是小寫原樣", () => expect(normalizeGender("female")).toBe("female"));
  it("未選（placeholder）→ 空字串", () => expect(normalizeGender("請選擇性別")).toBe(""));
});

describe("normalizePricingPlan", () => {
  it("中文 300 → general", () =>
    expect(normalizePricingPlan("我將支付300元")).toBe("general"));
  it("中文 認證 100 → verified", () =>
    expect(normalizePricingPlan("我已經在橘時相遇App通過單身認證，將支付100元")).toBe("verified"));
  it("中文 訂閱無須付費 → subscriber", () =>
    expect(normalizePricingPlan("我目前是橘時相遇App誠心、尊榮付費用戶，無須付費")).toBe("subscriber"));
  it("已是 key 原樣回傳", () => expect(normalizePricingPlan("verified")).toBe("verified"));
  it("未知 → general（最保守，避免誤判免費）", () =>
    expect(normalizePricingPlan("")).toBe("general"));
});

describe("canAutoQuote", () => {
  it("有場次且手機滿 10 碼 → 可自動試算", () =>
    expect(canAutoQuote({ session_id: 1, phone: "0912345678" })).toBe(true));
  it("尚未選場次 → 不試算", () =>
    expect(canAutoQuote({ session_id: null, phone: "0912345678" })).toBe(false));
  it("手機未滿 10 碼 → 不試算", () =>
    expect(canAutoQuote({ session_id: 1, phone: "0912" })).toBe(false));
  it("手機含非數字仍以數字位數判斷", () =>
    expect(canAutoQuote({ session_id: 1, phone: "0912-345-678" })).toBe(true));
});

describe("validateForm", () => {
  const valid = {
    session_id: 1, name: "王小明", gender: "male",
    phone: "0912345678", email: "a@b.com", pricing_plan: "general",
  };
  it("完整表單無錯誤", () => expect(validateForm(valid)).toEqual([]));
  it("缺場次", () => expect(validateForm({ ...valid, session_id: null })).toContain("請選擇場次"));
  it("缺手機", () => expect(validateForm({ ...valid, phone: "" })).toContain("請填寫手機"));
  it("email 格式錯", () => expect(validateForm({ ...valid, email: "bad" })).toContain("Email 格式不正確"));
});
