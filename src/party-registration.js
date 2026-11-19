// 交友活動報名頁（Webflow /2026-xmas-party）：整張表由這支 JS 畫進 #od-party。
// 流程：填表 → 手機簡訊驗證 → POST /eligibility/ 查 App 驗證狀態＋價格 → 付款（91APP）或去 App 驗證；
// 該性別額滿 → 候補登記。後端 contract：pbf-specs/features/event/api.md；需求：Wilson 12/13 報名頁需求。
// 價格／名額／資格最終裁判在後端，前端顯示一律當預估。純函式在上、瀏覽器 glue 在下（vitest/node 略過）。
import { createApi } from "./lib/api.js";
import { createCard91 } from "./lib/card91.js";
import { escapeHtml, formatTwd } from "./lib/format.js";
import { otpCreateRoute, otpVerifyRoute, GENERIC_ERROR } from "./lib/otp.js";
export { escapeHtml };

export const CITIES = ["桃園", "新竹", "苗栗", "台北", "新北", "其他"];
export const SOURCES = [
  { value: "smile_group", label: "微笑幸福團" },
  { value: "orangedate", label: "橘時相遇" },
];
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];

// ---- 純函式 ----

export function parseUtm(search) {
  const q = new URLSearchParams(search || "");
  const out = {};
  for (const k of UTM_KEYS) {
    const v = q.get(k);
    if (v) out[k] = v.slice(0, 100);
  }
  return out;
}

export function isValidPhone(phone) {
  return /^09\d{8}$/.test(String(phone || "").replace(/[\s-]/g, ""));
}

// 以活動日計算的實歲（YYYY-MM-DD 字串）
export function ageOn(birthIso, eventIso) {
  const [by, bm, bd] = String(birthIso || "").split("-").map(Number);
  const [ey, em, ed] = String(eventIso || "").split("-").map(Number);
  if (!by || !bm || !bd || !ey) return null;
  return ey - by - (em < bm || (em === bm && ed < bd) ? 1 : 0);
}

export function ageError(birthIso, session) {
  if (!birthIso) return "請填寫出生年月日";
  const age = ageOn(birthIso, session.date);
  if (age == null) return "出生年月日格式不正確";
  const { min_age: min, max_age: max } = session;
  if ((min != null && age < min) || (max != null && age > max)) return `本場活動限 ${min}–${max} 歲`;
  return "";
}

// 依現在時間算「已驗證」價格（顯示用；實際以後端為準）
export function verifiedPrice(session, gender, now = new Date()) {
  const p = gender === "male"
    ? { early: session.price_male_early, verified: session.price_male_verified }
    : { early: session.price_female_early, verified: session.price_female_verified };
  const early = session.early_bird_deadline && now <= new Date(session.early_bird_deadline);
  const femaleExt = gender === "female" && session.female_early_extended
    && session.female_early_extend_until && now <= new Date(session.female_early_extend_until);
  return early || femaleExt ? p.early : p.verified;
}

export function basePrice(session, gender) {
  return gender === "male" ? session.price_male_base : session.price_female_base;
}

export function isEarlyPeriod(session, now = new Date()) {
  return !!session.early_bird_deadline && now <= new Date(session.early_bird_deadline);
}

export function genderOpen(session, gender) {
  return gender === "male" ? !!session.is_male_open : !!session.is_female_open;
}

const SINGLE_MISSING = {
  not_submitted: "單身驗證",
  reviewing: "單身驗證（審核中）",
  rejected: "單身驗證",
};

// POST /eligibility/ 結果 → 畫面要顯示的東西
// choice：pay＝直接付款；either＝A 原價付款／B 先去驗證；waitReview＝A 原價付款／B 等審核
export function eligibilityView(body, saving) {
  body = body || {};
  const price = body.price != null ? `NT$${formatTwd(body.price)}` : "";
  switch (body.status) {
    case "eligible":
      return { tone: "ok", message: `你符合驗證價 ${price}`, choice: "pay" };
    case "no_account":
      return { tone: "info", message: `下載橘時相遇 App 完成人臉驗證與單身驗證，報名現省 NT$${saving}`, choice: "either" };
    case "single_reviewing":
      if (body.face_passed) {
        return { tone: "info", message: "單身驗證審核中，24 小時內會有結果，通過後會通知你", choice: "waitReview" };
      }
      return { tone: "info", message: "還差：人臉驗證；單身驗證審核中", choice: "either" };
    case "single_rejected":
      return { tone: "warn", message: "目前無法使用驗證價，可用原價報名", choice: "payBase" };
    case "face_not_passed":
    case "single_not_submitted": {
      const missing = [];
      if (!body.face_passed) missing.push("人臉驗證");
      if (body.single_status !== "passed") missing.push(SINGLE_MISSING[body.single_status] || "單身驗證");
      return { tone: "info", message: `還差：${missing.join("、")}。完成後報名現省 NT$${saving}`, choice: "either" };
    }
    default:
      return { tone: "warn", message: GENERIC_ERROR, choice: "none" };
  }
}

export function validateForm(form, session) {
  const errs = [];
  if (!form.name) errs.push("請填寫暱稱");
  else if (form.name.length > 10) errs.push("暱稱最多 10 個字");
  if (!form.gender) errs.push("請選擇性別");
  const ae = ageError(form.birth_date, session);
  if (ae) errs.push(ae);
  if (!isValidPhone(form.phone)) errs.push("手機請填 09 開頭共 10 碼");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email || "")) errs.push("Email 格式不正確");
  if (!form.city) errs.push("請選擇居住縣市");
  const interests = (form.interests || []).filter(Boolean);
  if (interests.length !== 3) errs.push("請填寫 3 個興趣關鍵字");
  if (interests.some((i) => i.length > 6)) errs.push("每個興趣關鍵字最多 6 個字");
  if (!form.single_declared) errs.push("請勾選單身聲明");
  if (!form.terms_agreed) errs.push("請同意個資與活動條款");
  if (!form.photo_consent) errs.push("請選擇拍照同意");
  if (!form.source) errs.push("請選擇從哪裡知道這場活動");
  return errs;
}

export function validateWaitlist(form, session) {
  const errs = [];
  if (!form.name) errs.push("請填寫暱稱");
  if (!form.gender) errs.push("請選擇性別");
  const ae = ageError(form.birth_date, session);
  if (ae) errs.push(ae);
  if (!isValidPhone(form.phone)) errs.push("手機請填 09 開頭共 10 碼");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email || "")) errs.push("Email 格式不正確");
  return errs;
}

export function buildRegistrationPayload(form, { sessionId, checkoutToken, txnToken, utm }) {
  return {
    session_id: sessionId,
    checkout_token: checkoutToken,
    txn_token: txnToken,
    name: form.name,
    gender: form.gender,
    birth_date: form.birth_date,
    email: form.email,
    city: form.city,
    interests: (form.interests || []).map((s) => s.trim()).filter(Boolean),
    single_declared: !!form.single_declared,
    terms_agreed: !!form.terms_agreed,
    photo_consent: form.photo_consent,
    source: form.source,
    note: form.note || "",
    utm: utm || {},
  };
}

export function buildWaitlistPayload(form, { sessionId, checkoutToken, utm }) {
  return {
    session_id: sessionId,
    checkout_token: checkoutToken,
    nickname: form.name,
    gender: form.gender,
    birth_date: form.birth_date || null,
    email: form.email,
    utm: utm || {},
  };
}

export function remainingText(session) {
  return `男生剩餘 ${session.remaining_male ?? "-"} 名｜女生剩餘 ${session.remaining_female ?? "-"} 名`;
}

// ---- 瀏覽器 glue ----
const CFG = (typeof window !== "undefined" && window.OD_PAYMENT) || {};
const API_BASE = CFG.apiBase || "https://dev-api.orangedate.com/api/pbf-event";
const OTP_BASE = CFG.otpApiBase || API_BASE.replace(/\/pbf-event\/?$/, "/pbf-kol");
const SUCCESS_PATH = CFG.successPath || "/2026-xmas-party-success";
const ONELINK = CFG.appLink || "https://orangedate.onelink.me/6fot/2026-xmas-party";
const PRIVACY_URL = CFG.privacyUrl || "https://orangedate.com/privacy-policy";
const OTP_COOLDOWN_SECONDS = 60;

function track(event, params) {
  if (typeof window === "undefined") return;
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ event, ...(params || {}) });
}

const STYLES = `
#od-party{max-width:560px;margin:0 auto;font-size:16px;color:#333}
#od-party .odp-field{margin:0 0 18px}
#od-party label.odp-label{display:block;font-weight:600;margin:0 0 6px}
#od-party .odp-hint{font-size:13px;color:#888;margin:4px 0 0}
#od-party input[type=text],#od-party input[type=email],#od-party input[type=tel],#od-party input[type=date],#od-party select,#od-party textarea{width:100%;box-sizing:border-box;height:44px;padding:8px 12px;border:1px solid #ddd;border-radius:8px;font-size:16px;background:#fff}
#od-party textarea{height:88px}
#od-party .odp-row{display:flex;gap:8px}
#od-party .odp-row>*{flex:1;min-width:0}
#od-party .odp-choice{display:flex;gap:16px;flex-wrap:wrap}
#od-party .odp-choice label{display:flex;align-items:center;gap:6px;font-weight:400}
#od-party .odp-check{display:flex;gap:8px;align-items:flex-start;margin:0 0 12px}
#od-party .odp-btn{display:inline-block;border:0;border-radius:999px;background:#ff6b35;color:#fff;font-size:16px;font-weight:600;padding:12px 20px;cursor:pointer;text-decoration:none;text-align:center}
#od-party .odp-btn[disabled]{opacity:.5;cursor:not-allowed}
#od-party .odp-btn.odp-ghost{background:#fff;color:#ff6b35;border:1px solid #ff6b35}
#od-party .odp-btn.odp-block{display:block;width:100%;box-sizing:border-box}
#od-party .odp-box{border-radius:10px;padding:14px 16px;margin:0 0 18px;background:#fff6f0;line-height:1.6}
#od-party .odp-box.odp-ok{background:#eef8ee}
#od-party .odp-box.odp-warn{background:#fff4e5}
#od-party .odp-msg{font-size:14px;margin:6px 0 0}
#od-party .odp-msg.odp-err,#od-party .odp-errors{color:#e53935}
#od-party .odp-msg.odp-good{color:#2e7d32}
#od-party .odp-errors{margin:0 0 16px;padding-left:20px}
#od-party .odp-card>div{margin:0 0 10px}
#od-party .odp-remaining{font-weight:600;color:#ff6b35;margin:0 0 16px}
`;

function formHtml(session) {
  const cities = CITIES.map((c) => `<option value="${c}">${c}</option>`).join("");
  const sources = SOURCES.map((s) => `<label><input type="radio" name="source" value="${s.value}"> ${s.label}</label>`).join("");
  return `
  <p class="odp-remaining" id="odp-remaining">${escapeHtml(remainingText(session))}</p>
  <div class="odp-field"><label class="odp-label" for="odp-name">暱稱（印在名牌）</label>
    <input id="odp-name" name="name" type="text" maxlength="10" placeholder="最多 10 個字"></div>
  <div class="odp-field"><span class="odp-label">性別</span>
    <div class="odp-choice" id="odp-gender">
      <label><input type="radio" name="gender" value="male"> 男</label>
      <label><input type="radio" name="gender" value="female"> 女</label>
    </div><p class="odp-msg" id="odp-gender-msg"></p></div>
  <div class="odp-field"><label class="odp-label" for="odp-birth">出生年月日</label>
    <input id="odp-birth" name="birth_date" type="date" min="1930-01-01" max="2000-12-31">
    <p class="odp-msg odp-err" id="odp-birth-msg"></p></div>
  <div class="odp-field"><label class="odp-label" for="odp-phone">手機</label>
    <div class="odp-row"><input id="odp-phone" name="phone" type="tel" inputmode="numeric" maxlength="10" placeholder="09xxxxxxxx">
      <button type="button" class="odp-btn odp-ghost" id="odp-otp-send" style="flex:0 0 auto">傳送驗證碼</button></div>
    <div class="odp-row" id="odp-otp-block" hidden style="margin-top:8px">
      <input id="odp-otp-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="輸入 6 碼驗證碼">
      <button type="button" class="odp-btn" id="odp-otp-verify" style="flex:0 0 auto">驗證</button></div>
    <p class="odp-msg" id="odp-otp-msg" role="status"></p></div>
  <div id="odp-elig" hidden></div>
  <div class="odp-field"><label class="odp-label" for="odp-email">Email（寄確認信）</label>
    <input id="odp-email" name="email" type="email" autocomplete="email"></div>
  <div id="odp-full-fields">
  <div class="odp-field"><label class="odp-label" for="odp-city">居住縣市</label>
    <select id="odp-city" name="city"><option value="">請選擇</option>${cities}</select></div>
  <div class="odp-field"><span class="odp-label">3 個興趣關鍵字（印在名牌，當開話題用）</span>
    <div class="odp-row">
      <input name="interest" type="text" maxlength="6" placeholder="爬山">
      <input name="interest" type="text" maxlength="6" placeholder="咖啡">
      <input name="interest" type="text" maxlength="6" placeholder="日本旅行"></div>
    <p class="odp-hint">每個最多 6 個字</p></div>
  <div class="odp-field"><span class="odp-label">拍照同意（活動回顧用）</span>
    <div class="odp-choice">
      <label><input type="radio" name="photo_consent" value="ok"> 可以入鏡</label>
      <label><input type="radio" name="photo_consent" value="mosaic"> 合照請幫我打馬賽克</label></div></div>
  <div class="odp-field"><span class="odp-label">你從哪裡知道這場活動</span>
    <div class="odp-choice">${sources}</div></div>
  <div class="odp-field"><label class="odp-label" for="odp-note">其他想告訴我們的事（選填）</label>
    <textarea id="odp-note" name="note" placeholder="素食、過敏等"></textarea></div>
  <label class="odp-check"><input type="checkbox" name="single_declared"> <span>我確認目前為單身</span></label>
  <label class="odp-check"><input type="checkbox" name="terms_agreed"> <span>我已閱讀並同意<a href="${PRIVACY_URL}" target="_blank" rel="noopener">隱私權政策</a>與活動條款</span></label>
  </div>
  <div class="odp-card" id="odp-card" hidden>
    <p class="odp-label">信用卡付款</p>
    <div id="card-number"></div><div id="card-expiration-date"></div><div id="card-ccv"></div>
  </div>
  <ul class="odp-errors" id="odp-errors" hidden></ul>
  <button type="button" class="odp-btn odp-block" id="odp-submit" disabled>請先完成手機驗證</button>
  <p class="odp-hint" id="odp-submit-hint" style="text-align:center"></p>`;
}

function initParty() {
  const root = document.querySelector("#od-party");
  if (!root) return;
  if (!document.getElementById("odp-styles")) {
    const st = document.createElement("style");
    st.id = "odp-styles";
    st.textContent = STYLES;
    document.head.appendChild(st);
  }
  const api = createApi(API_BASE);
  const otpApi = createApi(OTP_BASE);
  const utm = parseUtm(window.location.search);
  const card = createCard91();
  if (card.available) card.setup(CFG.publishableKey || "", CFG.env || "sandbox");

  const state = {
    session: null, checkoutToken: "", verifiedPhone: "", otpToken: "", otpPhone: "",
    cooldown: 0, timer: null, elig: null, mode: "register", formStarted: false, busy: false,
  };
  const $ = (sel) => root.querySelector(sel);

  // 頁面其他地方的按鈕（Hero CTA、下載 App）也記事件
  document.querySelectorAll('a[href="#od-party"],[data-od-cta]').forEach((el) =>
    el.addEventListener("click", () => track("event_cta_click")));
  document.querySelectorAll("[data-od-app-download]").forEach((el) =>
    el.addEventListener("click", () => track("event_app_download_click", { position: el.dataset.odAppDownload || "" })));
  track("event_page_view", { ...utm });

  function readForm() {
    const val = (n) => ((root.querySelector(`[name="${n}"]:checked`) || root.querySelector(`[name="${n}"]:not([type=radio])`) || {}).value || "").trim();
    const checked = (n) => !!(root.querySelector(`[name="${n}"]`) || {}).checked;
    return {
      name: val("name"),
      gender: (root.querySelector('[name="gender"]:checked') || {}).value || "",
      birth_date: val("birth_date"),
      phone: val("phone").replace(/[\s-]/g, ""),
      email: val("email"),
      city: val("city"),
      interests: Array.from(root.querySelectorAll('[name="interest"]')).map((i) => i.value.trim()),
      photo_consent: (root.querySelector('[name="photo_consent"]:checked') || {}).value || "",
      source: (root.querySelector('[name="source"]:checked') || {}).value || "",
      note: val("note"),
      single_declared: checked("single_declared"),
      terms_agreed: checked("terms_agreed"),
    };
  }

  function showErrors(errs) {
    const el = $("#odp-errors");
    el.innerHTML = (errs || []).map((e) => `<li>${escapeHtml(e)}</li>`).join("");
    el.hidden = !errs || !errs.length;
  }

  function setOtpMsg(text, kind) {
    const el = $("#odp-otp-msg");
    el.textContent = text || "";
    el.className = "odp-msg" + (kind ? ` odp-${kind}` : "");
  }

  function renderSend() {
    const btn = $("#odp-otp-send");
    if (state.checkoutToken) { btn.textContent = "已驗證"; btn.disabled = true; return; }
    btn.disabled = state.cooldown > 0;
    btn.textContent = state.cooldown > 0 ? `${state.cooldown} 秒後可重送` : state.otpToken ? "重新傳送" : "傳送驗證碼";
  }

  function setMode(mode) {
    state.mode = mode;
    $("#odp-full-fields").hidden = mode === "waitlist";
    if (mode === "waitlist") $("#odp-card").hidden = true;
    renderSubmit();
  }

  function genderFull() {
    const g = readForm().gender;
    return g && state.session && !genderOpen(state.session, g);
  }

  function renderSubmit(label) {
    const btn = $("#odp-submit");
    const hint = $("#odp-submit-hint");
    hint.textContent = "";
    if (label) { btn.textContent = label; btn.disabled = true; return; }
    if (state.mode === "waitlist") {
      btn.textContent = "登記候補（不用付款）";
      btn.disabled = !state.checkoutToken;
      if (!state.checkoutToken) hint.textContent = "請先完成手機驗證";
      return;
    }
    if (!state.checkoutToken) { btn.textContent = "請先完成手機驗證"; btn.disabled = true; return; }
    const e = state.elig;
    if (!e || e.price == null) { btn.textContent = "請先選擇性別"; btn.disabled = true; return; }
    btn.textContent = `確認付款 NT$${formatTwd(e.price)}`;
    btn.disabled = false;
    hint.textContent = "線上付款即完成報名，系統會立即寄出確認信";
  }

  function renderElig() {
    const box = $("#odp-elig");
    const e = state.elig;
    if (!e) { box.hidden = true; return; }
    const s = state.session;
    const g = e.gender || readForm().gender;
    const saving = g ? basePrice(s, g) - verifiedPrice(s, g) : (isEarlyPeriod(s) ? 300 : 150);
    const v = eligibilityView(e, saving);
    let html = `<div class="odp-box odp-${v.tone}">${escapeHtml(v.message)}`;
    if (v.choice === "either" || v.choice === "waitReview") {
      html += `<p style="margin:10px 0 0">A. 以原價 NT$${formatTwd(e.price)} 直接付款（填完下方資料）<br>`;
      html += v.choice === "either"
        ? `B. 先去 App 驗證，驗證完再回來付款</p><p class="odp-hint">名額不保留，驗證期間可能額滿。${escapeHtml(remainingText(s))}</p>
           <a class="odp-btn odp-ghost" style="margin-top:8px" href="${ONELINK}" target="_blank" rel="noopener" data-od-app-download="eligibility">打開 App 去驗證</a>`
        : `B. 等審核結果再回來付款（名額不保留）</p>`;
    }
    html += "</div>";
    box.innerHTML = html;
    box.hidden = false;
    const link = box.querySelector("[data-od-app-download]");
    if (link) link.addEventListener("click", () => track("event_app_download_click", { position: "eligibility" }));
    // 已驗證者性別以 App 帳號為準：鎖定
    root.querySelectorAll('[name="gender"]').forEach((r) => {
      if (e.gender_locked) { r.checked = r.value === e.gender; r.disabled = true; } else r.disabled = false;
    });
    $("#odp-gender-msg").textContent = e.gender_locked ? "已依你的 App 帳號帶入" : "";
  }

  async function checkEligibility() {
    if (!state.checkoutToken || !state.session) return;
    const gender = readForm().gender || undefined;
    const r = await api("/eligibility/", {
      method: "POST",
      body: JSON.stringify({ session_id: state.session.id, checkout_token: state.checkoutToken, gender }),
    });
    if (r.httpStatus === 401) { resetOtp(r.body.error || "手機驗證已失效，請重新驗證"); return; }
    if (r.httpStatus === 403) { state.elig = null; renderElig(); showErrors([r.body.error]); renderSubmit("無法報名"); return; }
    if (r.httpStatus >= 400) { showErrors([r.body.error || GENERIC_ERROR]); return; }
    state.elig = r.body;
    track("event_eligibility_result", { status: r.body.status });
    renderElig();
    const full = genderFull();
    setMode(full ? "waitlist" : "register");
    if (full) $("#odp-gender-msg").textContent = "此性別名額已滿，可以登記候補";
    if (!full && r.body.price) { $("#odp-card").hidden = false; card.mount(); }
  }

  function resetOtp(message) {
    state.checkoutToken = ""; state.verifiedPhone = ""; state.otpToken = ""; state.elig = null;
    $("#odp-otp-block").hidden = true;
    renderSend(); renderElig(); renderSubmit();
    setOtpMsg(message || "", message ? "err" : "");
  }

  async function sendOtp() {
    const phone = readForm().phone;
    if (!isValidPhone(phone)) { setOtpMsg("手機請填 09 開頭共 10 碼", "err"); return; }
    $("#odp-otp-send").disabled = true;
    try {
      const r = otpCreateRoute(await otpApi("/otp/create/", { method: "POST", body: JSON.stringify({ phone_number: phone }) }));
      if (r.action !== "sent") { setOtpMsg(r.message, "err"); renderSend(); return; }
      state.otpToken = r.token; state.otpPhone = phone;
      $("#odp-otp-block").hidden = false; $("#odp-otp-code").value = ""; $("#odp-otp-code").focus();
      setOtpMsg(`驗證碼已傳送到 ${r.phoneMasked || phone}，10 分鐘內有效`, "good");
      track("event_phone_otp_sent");
      state.cooldown = OTP_COOLDOWN_SECONDS; renderSend();
      clearInterval(state.timer);
      state.timer = setInterval(() => { state.cooldown -= 1; if (state.cooldown <= 0) clearInterval(state.timer); renderSend(); }, 1000);
    } catch (err) {
      console.error("otp/create", err); setOtpMsg(GENERIC_ERROR, "err"); renderSend();
    }
  }

  async function verifyOtp() {
    const code = $("#odp-otp-code").value.replace(/\D/g, "");
    if (!state.otpToken || code.length < 4) { setOtpMsg("請輸入簡訊中的驗證碼", "err"); return; }
    $("#odp-otp-verify").disabled = true;
    try {
      const r = otpVerifyRoute(await otpApi("/otp/verify/", {
        method: "POST", body: JSON.stringify({ phone_number: state.otpPhone, otp: code, token: state.otpToken }),
      }));
      if (r.action !== "verified") { if (r.resend) $("#odp-otp-block").hidden = true; setOtpMsg(r.message, "err"); return; }
      state.checkoutToken = r.checkoutToken; state.verifiedPhone = state.otpPhone;
      $("#odp-otp-block").hidden = true; renderSend(); setOtpMsg("手機已驗證", "good");
      track("event_phone_otp_verified");
      await checkEligibility();
    } catch (err) {
      console.error("otp/verify", err); setOtpMsg(GENERIC_ERROR, "err");
    } finally {
      $("#odp-otp-verify").disabled = false;
    }
  }

  async function submit() {
    if (state.busy) return;
    const form = readForm();
    if (state.elig && state.elig.gender_locked) form.gender = state.elig.gender;
    const s = state.session;
    const errs = state.mode === "waitlist" ? validateWaitlist(form, s) : validateForm(form, s);
    if (errs.length) { showErrors(errs); return; }
    showErrors([]);
    state.busy = true;
    renderSubmit("處理中…");
    try {
      if (state.mode === "waitlist") {
        const r = await api("/waitlist/", {
          method: "POST", body: JSON.stringify(buildWaitlistPayload(form, { sessionId: s.id, checkoutToken: state.checkoutToken, utm })),
        });
        if (r.httpStatus === 401) { resetOtp(r.body.error); return; }
        if (r.httpStatus >= 400) { showErrors([r.body.error || GENERIC_ERROR]); return; }
        track("event_waitlist_submit", { gender: form.gender });
        root.innerHTML = `<div class="odp-box odp-ok">候補登記完成，你是第 ${r.body.position} 位。有人釋出名額時，我們會依登記順序用 Email 通知你。</div>`;
        return;
      }
      const txnToken = await card.getTxnToken();
      if (!txnToken) { showErrors(["信用卡資訊有誤，請確認卡號、有效期限與末三碼"]); return; }
      track("event_form_submit", { gender: form.gender, member_status: state.elig ? state.elig.status : "" });
      const r = await api("/registrations/", {
        method: "POST",
        body: JSON.stringify(buildRegistrationPayload(form, { sessionId: s.id, checkoutToken: state.checkoutToken, txnToken, utm })),
      });
      if (r.httpStatus === 401) { resetOtp(r.body.error || "手機驗證已失效，請重新驗證"); return; }
      if (r.httpStatus >= 400) { showErrors([r.body.error || GENERIC_ERROR]); await refreshSession(); return; }
      if (r.body.redirect_url) { window.location.href = r.body.redirect_url; return; }
      window.location.href = `${SUCCESS_PATH}?order=${encodeURIComponent(r.body.order_token)}`;
    } catch (err) {
      console.error("submit", err); showErrors([GENERIC_ERROR]);
    } finally {
      state.busy = false;
      if (document.body.contains($("#odp-submit"))) renderSubmit();
    }
  }

  async function refreshSession() {
    const r = await api(`/sessions/?category=${encodeURIComponent(CFG.category || "party")}`, { method: "GET" });
    const list = Array.isArray(r.body) ? r.body : [];
    const s = CFG.sessionId ? list.find((x) => x.id === CFG.sessionId) : list[0];
    if (!s) return null;
    state.session = s;
    const rem = $("#odp-remaining");
    if (rem) rem.textContent = remainingText(s);
    document.querySelectorAll("[data-od-remaining]").forEach((el) => { el.textContent = remainingText(s); });
    return s;
  }

  (async () => {
    root.innerHTML = '<p style="text-align:center;color:#888">載入中…</p>';
    const s = await refreshSession().catch(() => null);
    if (!s) { root.innerHTML = '<div class="odp-box odp-warn">報名尚未開放或已截止。有問題請加入橘時相遇 LINE 官方帳號詢問。</div>'; return; }
    root.innerHTML = formHtml(s);
    $("#odp-otp-send").addEventListener("click", sendOtp);
    $("#odp-otp-verify").addEventListener("click", verifyOtp);
    $("#odp-otp-code").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); verifyOtp(); } });
    $("#odp-phone").addEventListener("input", () => {
      if (state.checkoutToken && readForm().phone !== state.verifiedPhone) resetOtp("手機號碼已變更，請重新驗證");
    });
    $("#odp-birth").addEventListener("change", () => { $("#odp-birth-msg").textContent = ageError(readForm().birth_date, s); });
    root.querySelectorAll('[name="gender"]').forEach((r) => r.addEventListener("change", () => {
      if (state.checkoutToken) checkEligibility();
      else { setMode(genderFull() ? "waitlist" : "register"); $("#odp-gender-msg").textContent = genderFull() ? "此性別名額已滿，可以登記候補" : ""; }
    }));
    root.addEventListener("input", () => { if (!state.formStarted) { state.formStarted = true; track("event_form_start"); } }, { once: false });
    $("#odp-submit").addEventListener("click", submit);
    renderSend();
    renderSubmit();
  })();
}

if (typeof document !== "undefined") {
  if (document.readyState !== "loading") initParty();
  else document.addEventListener("DOMContentLoaded", initParty);
}
