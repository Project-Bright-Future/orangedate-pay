// KOL 落地頁 + 三步驟結帳（Webflow /kol/<slug>）。純函式在上、瀏覽器 glue 在下（vitest/node 略過）。
// 後端 contract：pbf-specs/features/kol-web-checkout/api.md；文案：SPEC A C-1。規則最終裁判在後端，前端顯示一律當預估。
import { parseCookie, serializeCookie } from "./lib/cookie.js";
import { formatTpeDate, formatTwd, escapeHtml } from "./lib/format.js";
import { createApi } from "./lib/api.js";
import { createCard91 } from "./lib/card91.js";
export { parseCookie, serializeCookie, formatTpeDate, formatTwd, escapeHtml };

// ---- kol_code 來源 / cookie ----
// 優先序：embed data-kol-code > ?kol= > cookie（30 天）。Webflow 未綁欄位時 embed 會是 {{wf …}} 字面值 → 視為空。
export function resolveKolCode({ embed, query, cookie } = {}) {
  const clean = (v) => {
    const s = String(v || "").trim();
    return /^\{\{/.test(s) ? "" : s.toUpperCase();
  };
  return clean(embed) || clean(query) || clean(cookie);
}


// ---- 落地頁 ----
export const SOLD_OUT_COPY = (name) => `這一批名額已經額滿了，之後有新的活動會在${name}的頻道公布`;
export const PROMO_DEAD_COPY = "這組優惠碼已經失效了";

// GET promo/{code}/ 回應 → 落地頁顯示資料。sold_out / expired / 404 → 額滿文案；其他不可用 → 失效文案。
export function landingView({ httpStatus, body }, embedDisplayName) {
  body = body || {};
  const displayName = body.kol_display_name || embedDisplayName || "";
  const reason = httpStatus === 404 ? "not_found" : body.unavailable_reason;
  const available = httpStatus === 200 && body.is_available === true;
  let notice = null;
  if (!available) {
    notice = ["sold_out", "expired", "not_found"].includes(reason) ? SOLD_OUT_COPY(displayName) : PROMO_DEAD_COPY;
  }
  return {
    available,
    ctaDisabled: !available,
    displayName,
    code: body.kol_code || "",
    price: formatTwd(body.price_twd),
    listPrice: formatTwd(body.list_price_twd),
    grantDays: body.grant_days,
    validUntil: formatTpeDate(body.valid_until),
    notice,
  };
}

// ---- 步驟一：OTP ----
export const BANNED_COPY = "這個號碼的帳號已經停用了。想重新開始的話，在 LINE 找我們，我們幫你處理。";
const GENERIC_ERROR = "系統忙線中，請稍後再試";

// Retry-After 可能是秒數或 HTTP-date；解析失敗回 0。
export function retryAfterSeconds(value) {
  if (!value) return 0;
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : Math.max(0, Math.round((t - Date.now()) / 1000));
}

// POST otp/create/ 回應分流。429 依 Retry-After：≥ 1 小時 → 今天用完（C-5）。
export function otpCreateRoute({ httpStatus, body, header }) {
  body = body || {};
  if (httpStatus === 201) return { action: "sent", token: body.token, phoneMasked: body.phone_masked };
  if (httpStatus === 403 && body.code === "user_banned") return { action: "banned", message: BANNED_COPY };
  if (httpStatus === 429) {
    const secs = retryAfterSeconds(header ? header("Retry-After") : null);
    return {
      action: "error",
      message: secs >= 3600 ? "今天的驗證次數用完了，明天再試，或在 LINE 找我們" : "請稍後再試",
      reason: "rate_limited",
    };
  }
  if (httpStatus === 400 && Array.isArray(body.phone_number)) return { action: "error", message: body.phone_number[0] };
  return { action: "error", message: body.detail || GENERIC_ERROR };
}

// verify 回應 → B-3 分支：standard→b、premium→c、new→d、其餘→a。
export function branchOf(body) {
  const ent = body.membership && body.membership.entitlement;
  if (ent === "standard") return "b";
  if (ent === "premium") return "c";
  if (body.user_state === "new") return "d";
  return "a";
}

// POST otp/verify/ 回應分流。otp_max_attempts 只提示重送（後端無 30 分鎖，別假裝有）。
export function otpVerifyRoute({ httpStatus, body }) {
  body = body || {};
  if (httpStatus === 200) {
    return {
      action: "verified",
      branch: branchOf(body),
      checkoutToken: body.checkout_token,
      userState: body.user_state,
      displayName: body.display_name,
      membership: body.membership,
      projectedExpireAt: body.projected_expire_at,
    };
  }
  if (httpStatus === 403 && body.code === "user_banned") return { action: "banned", message: BANNED_COPY };
  if (body.code === "otp_expired") return { action: "error", message: "驗證碼已過期，請重新傳送", reason: "expired", resend: true };
  if (body.code === "otp_max_attempts") return { action: "error", message: "錯誤次數過多，請重新傳送驗證碼", reason: "wrong", resend: true };
  if (body.code === "otp_invalid") return { action: "error", message: body.detail || "驗證碼錯誤", reason: "wrong", resend: false };
  return { action: "error", message: body.detail || GENERIC_ERROR, reason: "wrong", resend: false };
}

// ---- 步驟二：方案 ----
// verify 結果 + promo → 步驟二顯示資料。分支 c 不顯示「今天起算共 90 天」（與延長到期日矛盾）。
export function planView(verify, promo, now = new Date()) {
  const name = promo.kol_display_name || "";
  const exp = verify.membership && formatTpeDate(verify.membership.expires_at);
  const projected = formatTpeDate(verify.projectedExpireAt);
  const branchText = {
    a: verify.displayName ? `歡迎回來，${verify.displayName}` : "歡迎回來",
    b: `你目前是誠心會員，到期日 ${exp}。購買後會立即升級尊榮，剩餘的誠心天數會接在尊榮之後繼續使用。`,
    c: `你目前是尊榮會員（到期 ${exp}）。購買後到期日會延長到 ${projected}。`,
    d: null,
  }[verify.branch];
  return {
    branchText,
    price: formatTwd(promo.price_twd),
    listPrice: formatTwd(promo.list_price_twd),
    discount: formatTwd(promo.list_price_twd - promo.price_twd),
    code: promo.kol_code,
    appliedLabel: `✓ 已套用${name}專屬價`,
    periodLine: verify.branch === "c"
      ? null
      : `權益期間 ${formatTpeDate(now.toISOString())} 起算，共 ${promo.grant_days} 天，至 ${projected} 到期`,
  };
}

// 步驟二改碼即時檢核：任一 reason / 404 → 失效文案（C-5）。
export function promoCheckRoute({ httpStatus, body }) {
  body = body || {};
  if (httpStatus === 200 && body.is_available === true) return { ok: true, promo: body };
  return { ok: false, message: PROMO_DEAD_COPY };
}

// ---- 步驟三：條款 / 付款 ----
const TERMS_MISSING_COPY = "條款尚未設定，目前無法付款";
export const DECLINED_COPY = "信用卡遭拒絕，請換一張卡或聯繫發卡行";

// GET terms/current/：503 → 整頁不可付款。
export function termsRoute({ httpStatus, body }) {
  if (httpStatus === 200 && body && body.tos && body.privacy && body.cooling_off_waiver) return { ok: true, terms: body };
  return { ok: false, message: TERMS_MISSING_COPY };
}

// POST orders/ body。email 選填（A5 未拍板）先不送；consents 由前端擋、送出時必為 true。
export function buildOrderPayload({ checkoutToken, promoCode, txnToken, terms }) {
  return {
    checkout_token: checkoutToken,
    promo_code: promoCode,
    txn_token: txnToken,
    consents: { terms_privacy: true, no_cooling_off: true },
    terms_version_ids: {
      tos: terms.tos.id,
      privacy: terms.privacy.id,
      cooling_off_waiver: terms.cooling_off_waiver.id,
    },
  };
}

// POST orders/ 回應分流（api.md §2.5 / §5）。200 三種形狀：paid / pending+redirect（3DS）/ pending 無 redirect（輪詢）。
export function orderRoute({ httpStatus, body }) {
  body = body || {};
  const ids = { orderId: body.merchant_order_id, userId: body.user_id };
  if (httpStatus === 200) {
    if (body.status === "paid") return { action: "done", ...ids };
    if (body.redirect_url) return { action: "redirect", url: body.redirect_url, ...ids };
    return { action: "poll", ...ids };
  }
  switch (body.code) {
    case "checkout_token_expired":
    case "checkout_token_invalid":
      return { action: "back_step1", message: body.detail || "驗證已逾時，請重新驗證手機" };
    case "promo_unavailable":
      return { action: "promo_dead", message: PROMO_DEAD_COPY };
    case "terms_outdated":
      return { action: "terms_outdated", message: body.detail || "條款已更新，請重新閱讀並勾選" };
    case "consent_required":
      return { action: "back_step3", message: body.detail || "請勾選兩項同意條款" };
    case "order_pending":
      return body.merchant_order_id ? { action: "poll", ...ids } : { action: "error", message: body.detail || GENERIC_ERROR };
    case "payment_declined":
      return { action: "declined", message: DECLINED_COPY };
    case "payment_error":
      return { action: "error", message: body.detail || "付款系統忙線，請稍後再試" };
    case "user_banned":
      return { action: "banned", message: BANNED_COPY };
    case "terms_not_configured":
      return { action: "unavailable", message: TERMS_MISSING_COPY };
    default:
      return { action: "error", message: body.detail || GENERIC_ERROR };
  }
}

// 付款鈕啟用條件：兩勾 + 條款已載 + 優惠碼可用 + 卡片三欄有效（SDK onUpdate canGetToken）+ 非處理中。
export function canPay({ consent1, consent2, termsLoaded, promoOk, cardOk, busy }) {
  return !!(consent1 && consent2 && termsLoaded && promoOk && cardOk && !busy);
}

// ---- render（HTML 字串；動態值一律 escapeHtml）----
export const LEGAL_LINE = "本方案為線上交友服務訂閱，不包含實體活動報名。"; // 法律用途，不可移除、不可改字
export const APP_DOWNLOAD_URL = "https://onelink.to/zqfayt";

const e = escapeHtml;

// 落地頁（C-1-1）。「省下 NT$1,200」「共 1,000 個名額」API 不回，照文案寫死。
export function renderLanding(v) {
  return `
<section class="odk-landing">
  <div class="odk-kicker">${e(v.displayName)} × 橘時相遇 · 粉絲專屬</div>
  <h2 class="odk-plan">尊榮會員 三個月</h2>
  <div class="odk-price">NT$${e(v.price)}</div>
  <div class="odk-muted">牌告定價 NT$${e(v.listPrice)}</div>
  <div class="odk-save">比單月購買三次，省下 NT$1,200</div>
  ${v.notice ? `<p class="odk-notice">${e(v.notice)}</p>` : ""}
  <button type="button" id="odk-cta" class="odk-btn"${v.ctaDisabled ? " disabled" : ""}>用${e(v.displayName)}的專屬價加入 →</button>
  <ul class="odk-bullets">
    <li>專屬價開放至 ${e(v.validUntil)}，${e(v.displayName)}合作期間共 1,000 個名額</li>
    <li>一次購買三個月，不會自動續訂，不會自動扣款</li>
    <li>會員權益自付款當日起算，共 90 天</li>
    <li>到期後想繼續，可以在 App 內續訂</li>
  </ul>
</section>`;
}

// 步驟一（C-1-2）。OTP 區塊送出後才顯示；#odk-send 送出後兼重送鈕（60 秒冷卻由 glue 計時）。
export function renderStep1() {
  return `
<h3 class="odk-step-title">步驟 1 / 3　確認你的手機號碼</h3>
<div class="odk-row">
  <input id="odk-phone" type="tel" inputmode="numeric" autocomplete="tel" maxlength="13" placeholder="09XX XXX XXX">
  <button type="button" id="odk-send" class="odk-btn odk-btn-secondary">傳送驗證碼</button>
</div>
<p class="odk-help">我們用手機號碼幫你開通會員，也用它登入 App。請填你之後會用來登入的號碼。</p>
<div id="odk-otp-block" hidden>
  <p id="odk-sent" class="odk-sent"></p>
  <div class="odk-row">
    <input id="odk-otp" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="驗證碼 6 碼">
    <button type="button" id="odk-verify" class="odk-btn">確認</button>
  </div>
  <p class="odk-help" id="odk-resend-hint">沒收到？60 秒後可以重新傳送</p>
</div>
<p id="odk-err1" class="odk-err" role="alert"></p>`;
}

// 步驟二（C-1-3）。優惠碼欄可改 → glue 打 promo/ 即時檢核並更新 #odk-code-status。
export function renderStep2(pv) {
  return `
<h3 class="odk-step-title">步驟 2 / 3　確認你的方案</h3>
${pv.branchText ? `<p class="odk-branch">${e(pv.branchText)}</p>` : ""}
<div class="odk-plan-box">
  <div class="odk-line"><span>尊榮會員 三個月</span><strong id="odk-p-price">NT$${e(pv.price)}</strong></div>
  <div class="odk-line odk-muted"><span id="odk-p-list">牌告定價 NT$${e(pv.listPrice)}</span><span id="odk-p-discount">−NT$${e(pv.discount)}</span></div>
</div>
<div class="odk-row odk-code-row">
  <label for="odk-code">優惠碼</label>
  <input id="odk-code" type="text" autocapitalize="characters" autocomplete="off" value="${e(pv.code)}">
  <span id="odk-code-status" class="odk-ok">${e(pv.appliedLabel)}</span>
</div>
${pv.periodLine ? `<p id="odk-period" class="odk-help">${e(pv.periodLine)}</p>` : `<p id="odk-period" class="odk-help" hidden></p>`}
<button type="button" id="odk-next2" class="odk-btn">下一步</button>
<p id="odk-err2" class="odk-err" role="alert"></p>`;
}

// 步驟三（C-1-4）。三個條款連結用 terms/current 的 content_url；91APP 三個 div 為 SDK iframe 掛載點。
export function renderStep3({ price, terms, company }) {
  const link = (url, text) => `<a href="${e(url)}" target="_blank" rel="noopener">${text}</a>`;
  return `
<h3 class="odk-step-title">步驟 3 / 3　付款前確認</h3>
<label class="odk-check"><input type="checkbox" id="odk-c1"> <span>我已閱讀並同意${link(terms.tos.content_url, "《服務條款》")}與${link(terms.privacy.content_url, "《隱私權政策》")}</span></label>
<label class="odk-check"><input type="checkbox" id="odk-c2"> <span>我了解本服務為線上數位服務，${link(terms.cooling_off_waiver.content_url, "開通後不適用七日猶豫期")}</span></label>
<p class="odk-legal">${LEGAL_LINE}</p>
<p class="odk-company">橘齡未來股份有限公司｜統一編號 ${e(company.taxId)}｜${e(company.address)}<br>客服 contact@orangedate.com｜LINE @orangedate</p>
<div id="od-card" class="odk-card">
  <div id="card-number"></div>
  <div id="card-expiration-date"></div>
  <div id="card-ccv"></div>
</div>
<button type="button" id="odk-pay" class="odk-btn" disabled>前往付款 NT$${e(price)}</button>
<p id="odk-err3" class="odk-err" role="alert"></p>`;
}

// 手機：去空白/破折；只接 09 開頭 10 碼（其餘格式交後端 400），不合回空字串。
export function normalizePhone(raw) {
  const d = String(raw || "").replace(/[\s-]/g, "");
  return /^09\d{8}$/.test(d) ? d : "";
}

// ---- PostHog（C-7）----
// 後端用 super property 分環境（environment: dev|prod、event_source: server）；前端每個事件同樣帶上，
// 否則 prod 儀表板篩不掉 staging 資料。environment 由 91APP env 推：production → prod、其餘 → dev。
export function analyticsEnvironment(sdkEnv) {
  return sdkEnv === "production" ? "prod" : "dev";
}
// 🔴 任何事件都不得帶手機號（明碼或遮罩都不要）。
export function eventProps({ kolCode, env }, extra) {
  return { kol_code: kolCode, environment: analyticsEnvironment(env), event_source: "web", ...extra };
}

// ============================================================================
// Browser glue（vitest/node 略過）。設定由 Webflow head custom code 的 window.OD_KOL 帶入（publishableKey 不進 git）：
//   window.OD_KOL = { publishableKey, env: "sandbox"|"production", apiBase, kolCode?, successPath?, taxId?, address? }
// ============================================================================
const CFG = (typeof window !== "undefined" && window.OD_KOL) || {};
const API_BASE = CFG.apiBase || "https://dev-api.orangedate.com/api/pbf-kol";
const SUCCESS_PATH = CFG.successPath || "/kol-payment-success";
// 公開登記資料（twincn / ldigi 查得）；揭露用登記地址或營業地址待 Wilson 確認，可由 OD_KOL.taxId / address 覆寫。
const COMPANY = { taxId: CFG.taxId || "93484326", address: CFG.address || "臺北市萬華區長泰街308巷33號1樓" };
const COOKIE_CODE = "od_kol";
const COOKIE_RETURN = "od_kol_return";
const COOKIE_DAYS = 30;
const RESEND_COOLDOWN = 60;

// PostHog（C-7）：window.posthog 不在就 no-op。🔴 任何事件都不得帶手機號。
function track(name, props) {
  try {
    if (typeof window !== "undefined" && window.posthog && window.posthog.capture) window.posthog.capture(name, props);
  } catch (_) {}
}
function registerSuperProps() {
  try {
    if (window.posthog && window.posthog.register) {
      window.posthog.register({ environment: analyticsEnvironment(CFG.env), event_source: "web" });
    }
  } catch (_) {}
}
function identify(userId) {
  try {
    if (userId != null && window.posthog && window.posthog.identify) window.posthog.identify(String(userId));
  } catch (_) {}
}

function injectStyles() {
  if (document.getElementById("odk-styles")) return;
  const style = document.createElement("style");
  style.id = "odk-styles";
  style.textContent = `
    #od-kol { max-width: 560px; margin: 0 auto; padding: 8px 16px 40px; line-height: 1.7; color: #333; }
    .odk-kicker { color: #ff6b35; font-weight: 700; letter-spacing: .02em; }
    .odk-plan { font-size: 1.5rem; font-weight: 700; margin: 4px 0; }
    .odk-price { font-size: 2.2rem; font-weight: 800; color: #ff6b35; line-height: 1.2; }
    .odk-muted { color: #888; }
    .odk-save { margin: 4px 0 12px; }
    .odk-notice { background: #fff3ee; border-left: 4px solid #ff6b35; padding: 10px 14px; border-radius: 6px; }
    .odk-bullets { padding-left: 1.2em; color: #555; font-size: .95rem; margin: 16px 0 0; }
    .odk-btn { display: inline-block; width: 100%; box-sizing: border-box; text-align: center; background: #ff6b35; color: #fff;
      border: 0; border-radius: 999px; padding: 14px 24px; font-size: 1.05rem; font-weight: 700; cursor: pointer; text-decoration: none; }
    .odk-btn[disabled] { background: #ccc; color: #fff; cursor: not-allowed; }
    .odk-btn-secondary { background: #fff; color: #ff6b35; border: 2px solid #ff6b35; width: auto; padding: 10px 18px; white-space: nowrap; }
    .odk-btn-secondary[disabled] { background: #fff; color: #bbb; border-color: #ddd; }
    #odk-checkout { margin-top: 28px; padding-top: 20px; border-top: 1px solid #eee; }
    .odk-step-title { font-size: 1.15rem; font-weight: 700; margin: 0 0 12px; }
    .odk-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
    .odk-row input[type=tel], .odk-row input[type=text] { flex: 1 1 160px; min-width: 0; height: 44px; padding: 0 12px;
      border: 1px solid #ddd; border-radius: 8px; font-size: 1rem; }
    .odk-help { color: #666; font-size: .9rem; margin: 6px 0; }
    .odk-err { color: #e53935; font-size: .95rem; min-height: 1.2em; margin: 8px 0 0; }
    .odk-sent { font-weight: 700; margin: 12px 0 6px; }
    .odk-branch { background: #f7f7f7; border-radius: 8px; padding: 10px 14px; }
    .odk-plan-box { border: 2px solid #eee; border-radius: 12px; padding: 12px 16px; margin: 12px 0; }
    .odk-line { display: flex; justify-content: space-between; gap: 12px; }
    .odk-code-row label { font-weight: 700; }
    .odk-code-row input { flex: 0 1 160px; text-transform: uppercase; }
    .odk-ok { color: #43a047; font-size: .9rem; }
    .odk-dead { color: #e53935; font-size: .9rem; }
    .odk-check { display: flex; gap: 8px; align-items: flex-start; margin: 10px 0; cursor: pointer; }
    .odk-check input { margin-top: 6px; flex: none; }
    .odk-check a { color: #ff6b35; }
    .odk-legal { font-weight: 700; margin: 14px 0 6px; }
    .odk-company { color: #777; font-size: .85rem; margin: 0 0 16px; }
    .odk-card { display: flex; flex-direction: column; gap: 10px; margin: 12px 0 16px; }
    .odk-card > div { min-height: 44px; }
    #odk-next2 { margin-top: 12px; }
  `;
  document.head.appendChild(style);
}

async function initKolCheckout() {
  const root = document.querySelector("#od-kol");
  if (!root) return;
  injectStyles();

  const api = createApi(API_BASE);
  const card = createCard91();
  const $ = (sel) => root.querySelector(sel);
  const setText = (sel, text) => { const el = $(sel); if (el) el.textContent = text || ""; };

  // ---- 設定與 kol_code ----
  const hadCookie = !!parseCookie(document.cookie, COOKIE_CODE);
  const kolCode = resolveKolCode({
    embed: root.dataset.kolCode || CFG.kolCode,
    query: new URLSearchParams(window.location.search).get("kol"),
    cookie: parseCookie(document.cookie, COOKIE_CODE),
  });
  const embedName = /^\{\{/.test(root.dataset.displayName || "") ? "" : (root.dataset.displayName || "");
  if (kolCode) document.cookie = serializeCookie(COOKIE_CODE, kolCode, { maxAgeSec: COOKIE_DAYS * 86400 });

  const st = {
    kolCode, promo: null, landing: null,
    phone: "", otpToken: "", attemptNo: 0, cooldownTimer: null,
    verify: null, terms: null, consent1: false, consent2: false, consentTracked: false,
    cardOk: false, busy: false,
  };
  const trackProps = (extra) => eventProps({ kolCode: st.kolCode, env: CFG.env }, extra);
  registerSuperProps();

  // ---- 落地頁 ----
  root.innerHTML = `<div id="odk-landing"></div>
<section id="odk-checkout" style="display:none">
  <div id="odk-step1"></div><div id="odk-step2" hidden></div><div id="odk-step3" hidden></div>
</section>`;
  const promoRes = kolCode ? await api(`/promo/${encodeURIComponent(kolCode)}/`, { method: "GET" }) : { httpStatus: 0, body: {} };
  st.promo = promoRes.httpStatus === 200 && promoRes.body.is_available ? promoRes.body : null;
  st.landing = landingView(promoRes, embedName);
  $("#odk-landing").innerHTML = renderLanding(st.landing);
  track("kol_landing_viewed", trackProps({ referrer: document.referrer || "", is_returning_visitor: hadCookie }));

  const cta = $("#odk-cta");
  if (cta) cta.addEventListener("click", () => {
    document.cookie = serializeCookie(COOKIE_RETURN, window.location.pathname + window.location.search, { maxAgeSec: COOKIE_DAYS * 86400 });
    $("#odk-checkout").style.display = "";
    showStep(1);
    track("kol_checkout_started", trackProps());
    $("#odk-checkout").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  function showStep(n) {
    [1, 2, 3].forEach((i) => { $(`#odk-step${i}`).hidden = i !== n; });
  }
  function renderBanned(message) {
    $("#odk-checkout").innerHTML = `<p class="odk-notice">${escapeHtml(message)}</p>`;
  }
  function renderUnavailable(message) {
    $("#odk-checkout").innerHTML = `<p class="odk-notice">${escapeHtml(message)}</p>`;
    if (cta) cta.disabled = true;
  }

  // ---- 步驟一 ----
  function startCooldown() {
    const btn = $("#odk-send");
    let left = RESEND_COOLDOWN;
    clearInterval(st.cooldownTimer);
    const tick = () => {
      if (left <= 0) {
        clearInterval(st.cooldownTimer);
        btn.disabled = false; btn.textContent = "重新傳送";
        setText("#odk-resend-hint", "沒收到？可以重新傳送");
        return;
      }
      btn.disabled = true; btn.textContent = `重新傳送（${left}）`;
      setText("#odk-resend-hint", `沒收到？${left} 秒後可以重新傳送`);
      left -= 1;
    };
    tick();
    st.cooldownTimer = setInterval(tick, 1000);
  }
  function allowResendNow() {
    clearInterval(st.cooldownTimer);
    const btn = $("#odk-send");
    if (btn) { btn.disabled = false; btn.textContent = "重新傳送"; }
    setText("#odk-resend-hint", "沒收到？可以重新傳送");
  }

  function mountStep1() {
    $("#odk-step1").innerHTML = renderStep1();
    $("#odk-send").addEventListener("click", sendOtp);
    $("#odk-verify").addEventListener("click", verifyOtp);
    $("#odk-otp").addEventListener("keydown", (ev) => { if (ev.key === "Enter") verifyOtp(); });
    $("#odk-phone").addEventListener("keydown", (ev) => { if (ev.key === "Enter") sendOtp(); });
  }

  async function sendOtp() {
    if (st.busy) return;
    const phone = normalizePhone($("#odk-phone").value);
    if (!phone) { setText("#odk-err1", "請輸入台灣手機號碼（09 開頭共 10 碼）"); return; }
    st.busy = true; $("#odk-send").disabled = true; setText("#odk-err1", "");
    try {
      const res = await api("/otp/create/", { method: "POST", body: JSON.stringify({ phone_number: phone }) });
      const r = otpCreateRoute(res);
      st.attemptNo += 1;
      if (r.action === "sent") {
        st.phone = phone; st.otpToken = r.token;
        $("#odk-otp-block").hidden = false;
        setText("#odk-sent", `驗證碼已經傳到 ${r.phoneMasked}`);
        $("#odk-otp").value = ""; $("#odk-otp").focus();
        track("kol_otp_requested", trackProps({ attempt_no: st.attemptNo }));
        startCooldown();
      } else if (r.action === "banned") {
        renderBanned(r.message);
      } else {
        setText("#odk-err1", r.message);
        if (r.reason) track("kol_otp_failed", trackProps({ reason: r.reason }));
        $("#odk-send").disabled = false;
      }
    } catch (err) {
      console.error("otp/create", err);
      setText("#odk-err1", "系統忙線中，請稍後再試");
      $("#odk-send").disabled = false;
    } finally { st.busy = false; }
  }

  async function verifyOtp() {
    if (st.busy || !st.otpToken) return;
    const otp = String($("#odk-otp").value || "").replace(/\D/g, "");
    if (otp.length !== 6) { setText("#odk-err1", "請輸入 6 碼驗證碼"); return; }
    st.busy = true; $("#odk-verify").disabled = true; setText("#odk-err1", "");
    try {
      const res = await api("/otp/verify/", { method: "POST", body: JSON.stringify({ phone_number: st.phone, otp, token: st.otpToken }) });
      const r = otpVerifyRoute(res);
      if (r.action === "verified") {
        st.verify = r;
        clearInterval(st.cooldownTimer);
        track("kol_otp_verified", trackProps({ user_state: r.userState }));
        mountStep2();
        showStep(2);
      } else if (r.action === "banned") {
        renderBanned(r.message);
      } else {
        setText("#odk-err1", r.message);
        track("kol_otp_failed", trackProps({ reason: r.reason }));
        if (r.resend) allowResendNow();
      }
    } catch (err) {
      console.error("otp/verify", err);
      setText("#odk-err1", "系統忙線中，請稍後再試");
    } finally { st.busy = false; const b = $("#odk-verify"); if (b) b.disabled = false; }
  }

  // ---- 步驟二 ----
  let promoTimer = null;
  function mountStep2() {
    $("#odk-step2").innerHTML = renderStep2(planView(st.verify, st.promo));
    $("#odk-code").addEventListener("input", () => {
      clearTimeout(promoTimer);
      promoTimer = setTimeout(recheckPromo, 400);
    });
    $("#odk-next2").addEventListener("click", () => {
      if (!st.promo) return;
      track("kol_plan_confirmed", trackProps({ promo_code: st.kolCode }));
      enterStep3();
    });
  }
  async function recheckPromo() {
    const code = String($("#odk-code").value || "").trim().toUpperCase();
    const next = $("#odk-next2");
    if (!code) { st.promo = null; next.disabled = true; setText("#odk-code-status", ""); return; }
    const res = await api(`/promo/${encodeURIComponent(code)}/`, { method: "GET" });
    if (String($("#odk-code").value || "").trim().toUpperCase() !== code) return; // 使用者又改了
    const r = promoCheckRoute(res);
    const status = $("#odk-code-status");
    if (r.ok) {
      st.promo = r.promo; st.kolCode = r.promo.kol_code;
      document.cookie = serializeCookie(COOKIE_CODE, st.kolCode, { maxAgeSec: COOKIE_DAYS * 86400 });
      const pv = planView(st.verify, st.promo);
      status.className = "odk-ok"; status.textContent = pv.appliedLabel;
      setText("#odk-p-price", `NT$${pv.price}`);
      setText("#odk-p-list", `牌告定價 NT$${pv.listPrice}`);
      setText("#odk-p-discount", `−NT$${pv.discount}`);
      const period = $("#odk-period");
      if (period) { period.hidden = !pv.periodLine; period.textContent = pv.periodLine || ""; }
      next.disabled = false;
    } else {
      st.promo = null;
      status.className = "odk-dead"; status.textContent = r.message;
      next.disabled = true;
    }
    refreshPayButton();
  }

  // ---- 步驟三 ----
  async function loadTerms() {
    const res = await api("/terms/current/", { method: "GET" });
    return termsRoute(res);
  }
  function applyTerms(terms) {
    st.terms = terms;
    const links = $("#odk-step3").querySelectorAll("a[href]");
    const urls = [terms.tos.content_url, terms.privacy.content_url, terms.cooling_off_waiver.content_url];
    links.forEach((a, i) => { if (urls[i]) a.href = urls[i]; });
    st.consent1 = st.consent2 = false;
    $("#odk-c1").checked = false; $("#odk-c2").checked = false;
    refreshPayButton();
  }
  function refreshPayButton() {
    const btn = $("#odk-pay");
    if (!btn) return;
    btn.disabled = !canPay({
      consent1: st.consent1, consent2: st.consent2, termsLoaded: !!st.terms, promoOk: !!st.promo, cardOk: st.cardOk, busy: st.busy,
    });
  }
  // 條款版本 id 會變 → 每次進步驟三都現拉、不 cache。第一次 render 全區塊並掛卡片 iframe；
  // 之後只更新連結 + 重勾（重 render 會毀掉 91APP iframe）。
  let step3Rendered = false;
  async function enterStep3() {
    showStep(3);
    const step3 = $("#odk-step3");
    if (!step3Rendered) step3.innerHTML = `<p class="odk-help">載入中…</p>`;
    let t;
    try { t = await loadTerms(); } catch (err) { console.error("terms", err); t = { ok: false, message: "系統忙線中，請稍後再試" }; }
    if (!t.ok) { renderUnavailable(t.message); return; }
    if (!step3Rendered) {
      step3.innerHTML = renderStep3({ price: formatTwd(st.promo.price_twd), terms: t.terms, company: COMPANY });
      step3Rendered = true;
      st.terms = t.terms;
      $("#odk-c1").addEventListener("change", onConsentChange);
      $("#odk-c2").addEventListener("change", onConsentChange);
      $("#odk-pay").addEventListener("click", pay);
      if (!card.available) { setText("#odk-err3", "付款元件載入失敗，請重新整理頁面"); return; }
      card.setup(CFG.publishableKey || "", CFG.env || "sandbox");
      card.mount();
      card.onUpdate((u) => { st.cardOk = !!(u && u.canGetToken); refreshPayButton(); });
    } else {
      applyTerms(t.terms);
      $("#odk-pay").textContent = `前往付款 NT$${formatTwd(st.promo.price_twd)}`;
    }
    refreshPayButton();
  }
  function onConsentChange() {
    st.consent1 = $("#odk-c1").checked; st.consent2 = $("#odk-c2").checked;
    if (st.consent1 && st.consent2 && !st.consentTracked) { st.consentTracked = true; track("kol_consent_completed", trackProps()); }
    refreshPayButton();
  }

  async function pay() {
    if (st.busy) return;
    const btn = $("#odk-pay");
    st.busy = true; btn.disabled = true; // C-5 重複點擊：按下即停用
    const label = btn.textContent; btn.textContent = "處理中…";
    setText("#odk-err3", "");
    const restore = () => { st.busy = false; btn.textContent = label; refreshPayButton(); };
    try {
      const txnToken = await card.getTxnToken();
      if (!txnToken) { setText("#odk-err3", "信用卡資訊有誤，請確認卡號、有效期限與末三碼"); restore(); return; }
      const res = await api("/orders/", {
        method: "POST",
        body: JSON.stringify(buildOrderPayload({ checkoutToken: st.verify.checkoutToken, promoCode: st.kolCode, txnToken, terms: st.terms })),
      });
      const r = orderRoute(res);
      if (r.userId != null) identify(r.userId);
      switch (r.action) {
        case "done":
        case "poll":
          window.location.href = `${SUCCESS_PATH}?order=${encodeURIComponent(r.orderId)}`;
          return;
        case "redirect":
          window.location.href = r.url;
          return;
        case "back_step1":
          st.verify = null; st.otpToken = ""; st.consentTracked = false;
          mountStep1(); showStep(1);
          setText("#odk-err1", r.message);
          restore();
          return;
        case "promo_dead":
          showStep(2);
          st.promo = null;
          $("#odk-code-status").className = "odk-dead"; setText("#odk-code-status", r.message);
          $("#odk-next2").disabled = true;
          restore();
          return;
        case "terms_outdated": {
          let t;
          try { t = await loadTerms(); } catch (_) { t = { ok: false, message: "系統忙線中，請稍後再試" }; }
          if (!t.ok) { renderUnavailable(t.message); return; }
          applyTerms(t.terms);
          setText("#odk-err3", r.message);
          restore();
          return;
        }
        case "banned":
          renderBanned(r.message);
          return;
        case "unavailable":
          renderUnavailable(r.message);
          return;
        default: // back_step3 / declined / error
          setText("#odk-err3", r.message);
          restore();
      }
    } catch (err) {
      console.error("orders", err);
      setText("#odk-err3", "系統忙線中，請稍後再試");
      restore();
    }
  }

  mountStep1();
}

if (typeof document !== "undefined") {
  if (document.readyState !== "loading") initKolCheckout();
  else document.addEventListener("DOMContentLoaded", initKolCheckout);
}
