import { createApi } from "./lib/api.js";
import { createCard91 } from "./lib/card91.js";
import { otpCreateRoute, otpVerifyRoute } from "./lib/otp.js";

// 價格依手機的會員身分決定 → 手機要先經 OTP 驗證，quote／報名一律帶 checkout_token、不帶手機號碼
// （後端從 token 取驗證過的手機；否則輸入別人的會員手機就能拿會員價）。
// 例外：固定價場次（工作坊）沒有會員價可冒用 → 頁面設 phoneOtp:false，改帶 phone；
// 後端只對有 price 的場次接受 phone，設錯也不會變成漏洞。
export function buildQuotePayload(form, checkoutToken, { phoneOtp = true } = {}) {
  const payload = {
    session_id: form.session_id,
    checkout_token: checkoutToken || "",
    pricing_plan: form.pricing_plan || "general",
  };
  if (!phoneOtp) payload.phone = form.phone || "";
  return payload;
}

export function buildRegistrationPayload(form, txnToken, checkoutToken, { phoneOtp = true } = {}) {
  const payload = {
    session_id: form.session_id,
    name: form.name,
    gender: form.gender,
    age: form.age ?? null,
    checkout_token: checkoutToken || "",
    email: form.email,
    nickname: form.nickname || "",
    occupation_category: form.occupation_category || "",
    dietary_preference: form.dietary_preference || "",
    note: form.note || "",
    pricing_plan: form.pricing_plan || "general",
    txn_token: txnToken || "",
  };
  if (!phoneOtp) payload.phone = form.phone || "";
  return payload;
}

// 401 + checkout_token_*：手機驗證逾時／無效 → 要重新驗證手機。
export function isCheckoutTokenError(httpStatus, body) {
  const code = body && body.code;
  return httpStatus === 401 && (code === "checkout_token_expired" || code === "checkout_token_invalid");
}

// OTP 端點在 KOL app（/api/pbf-kol/otp/）；預設由 event 的 apiBase 推出來。
export function otpApiBase(eventBase) {
  return String(eventBase || "").replace(/\/pbf-event\/?$/, "/pbf-kol");
}

export function routeRegistrationResponse(res, httpStatus) {
  res = res || {};
  if (isCheckoutTokenError(httpStatus, res)) {
    return { action: "reverify", message: res.error || "手機驗證已失效，請重新驗證" };
  }
  if (httpStatus >= 400) {
    return { action: "error", message: res.error || "系統忙線中，請稍後再試" };
  }
  if (res.redirect_url) {
    return { action: "redirect", url: res.redirect_url };
  }
  // confirmed 或 pending_payment（無 redirect）一律導去成功頁，
  // 由成功頁輪詢 status 端點確認最終結果（含 failed/expired）。
  // 網址帶 order_token：流水號可猜，後端 status 只接受 token。
  return { action: "success", orderToken: res.order_token };
}

const PLAN_LABELS = {
  general: "一般報名",
  verified: "App 單身認證優惠",
  subscriber: "付費訂閱會員",
};

// fixedPrice：場次有固定價（工作坊）→ 不提會員方案，只講活動費用。
export function formatQuoteResult(quote, { fixedPrice = false } = {}) {
  const amount = quote.amount;
  if (fixedPrice && amount > 0) {
    return { needsCard: true, amount, message: `活動費用 NT$${amount}。` };
  }
  if (amount === 0) {
    return {
      needsCard: false,
      amount: 0,
      message: "你符合付費訂閱會員資格，本次免費，無須付款。",
    };
  }
  const label = PLAN_LABELS[quote.plan] || "一般報名";
  return {
    needsCard: true,
    amount,
    message: `你的方案為「${label}」，需支付 NT$${amount}。`,
  };
}

export function sessionGenderOpen(session, gender) {
  return gender === "male" ? !!session.is_male_open : !!session.is_female_open;
}

// 把後端 registration_end_at（ISO 8601）轉成卡片上要顯示的「報名至 M/D HH:mm」。
// null / undefined / 解析失敗 → 空字串（呼叫端用空字串判斷不顯示）。
export function formatDeadline(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return "";
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `報名至 ${m}/${day} ${hh}:${mm}`;
}

// 把後端 GET /sessions/ 的單筆場次整理成卡片顯示用資料（純函式，免 DOM 可測）。
// 有總名額（max_total）的場次另帶 totalLabel，卡片改顯示總剩餘名額、不分男女。
export function formatSessionCard(session) {
  const hhmm = (t) => (t || "").slice(0, 5);
  const card = {
    id: session.id,
    title: session.title || "",
    timeLabel: `${session.date || ""} ${hhmm(session.start_time)}–${hhmm(session.end_time)}`,
    location: session.location_name || "",
    deadlineLabel: formatDeadline(session.registration_end_at),
    maleLabel: `男生剩餘名額：${session.remaining_male}`,
    femaleLabel: `女生剩餘名額：${session.remaining_female}`,
    soldOut: !session.is_male_open && !session.is_female_open,
  };
  if (session.max_total != null) card.totalLabel = `剩餘名額：${session.remaining_total}`;
  return card;
}

// Webflow 性別 select 的值為 Male/Female；後端要小寫 male/female。未選回空字串。
export function normalizeGender(raw) {
  const s = String(raw || "").trim().toLowerCase();
  return s === "male" || s === "female" ? s : "";
}

// Webflow 報名費用 select 的值是中文句子；映射成後端契約 general/verified/subscriber。
// 用關鍵字判斷（順序：先訂閱、再認證、否則一般），對文案小改動較有韌性。
// ⚠️ 若行銷大改選項文案，需同步此處或改用 Webflow option value（見 docs/webflow-setup.md）。
export function normalizePricingPlan(raw) {
  const s = String(raw || "").trim();
  if (s === "general" || s === "verified" || s === "subscriber") return s;
  if (/無[須需]|免費|訂閱|尊榮|誠心/.test(s)) return "subscriber";
  if (/認證|100/.test(s)) return "verified";
  return "general";
}

// 是否已具備自動試算的最小條件：選了場次、手機已驗證（拿到 checkout_token）；
// 不驗手機的頁面（phoneOtp:false）則是手機有填。
export function canAutoQuote(form, checkoutToken, { phoneOtp = true } = {}) {
  if (!form.session_id) return false;
  return phoneOtp ? !!checkoutToken : !!String(form.phone || "").trim();
}

export function validateForm(form) {
  const errors = [];
  if (!form.session_id) errors.push("請選擇場次");
  if (!form.name) errors.push("請填寫姓名");
  if (!form.gender) errors.push("請選擇性別");
  if (!form.phone) errors.push("請填寫手機");
  if (!form.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) {
    errors.push("Email 格式不正確");
  }
  return errors;
}

// Keep the form visible and hide Webflow's native submit done/fail message.
// We don't block the native submit (the lead still reaches Webflow/email/webhook);
// payment outcome is driven by our JS (#od-errors on failure, redirect on success).
export function revertWebflowFormUI(formEl) {
  if (!formEl) return;
  const wrap = formEl.closest && formEl.closest(".w-form");
  if (!wrap) return;
  formEl.style.display = "";
  wrap.querySelectorAll(".w-form-done, .w-form-fail").forEach((el) => {
    el.style.display = "none";
  });
}

// ---- Browser glue (skipped under vitest/node) ----
// 設定值由 Webflow 頁面 custom code 的 window.OD_PAYMENT 帶入（publishableKey 放這、不進 git）：
//   window.OD_PAYMENT = { publishableKey: "...", env: "sandbox"|"production", apiBase: "..." }
// 同一支 JS 給多個活動頁用（預設值＝下午茶）：
//   category：只列這個分類的場次（"tea"／"workshop"）
//   successPath：付款完成頁
//   phoneOtp：false＝不驗手機（只給固定價場次的頁面用）
const CFG = (typeof window !== "undefined" && window.OD_PAYMENT) || {};
const API_BASE = CFG.apiBase || "https://dev-api.orangedate.com/api/pbf-event";
const PUBLISHABLE_KEY = CFG.publishableKey || "";
const SDK_ENV = CFG.env || "sandbox";
const CATEGORY = CFG.category || "tea";
const SUCCESS_PATH = CFG.successPath || "/afternoon-tea-payment-success";
const PHONE_OTP = CFG.phoneOtp !== false;
const PAYLOAD_OPTS = { phoneOtp: PHONE_OTP };

const api = createApi(API_BASE);
// OTP 端點在 KOL app；可用 window.OD_PAYMENT.otpApiBase 覆寫
const otpApi = createApi(CFG.otpApiBase || otpApiBase(API_BASE));
const OTP_COOLDOWN_SECONDS = 60;

// 左：後端契約欄位 → 右：Webflow 表單實際 name（2026-05-24 於 Designer 確認）。
// 採 JS 對應表而非改 Webflow 欄位名，避免動到原生表單欄位、且集中一處易維護。
const FIELD_NAME_MAP = {
  name: "Name",
  gender: "Gender",
  age: "Age",
  phone: "Phone_number",
  email: "email",
  nickname: "Nickname",
  occupation_category: "Occupation",
  dietary_preference: "food_preference",
  pricing_plan: "fee",
  note: "field",
};

function readForm(formEl) {
  const get = (key) => {
    const wfName = FIELD_NAME_MAP[key] || key;
    return (formEl.querySelector(`[name="${wfName}"]`) || {}).value || "";
  };
  return {
    session_id: Number(formEl.dataset.sessionId) || null, // 由選中的場次卡片寫入
    name: get("name"),
    gender: normalizeGender(get("gender")),
    age: get("age") ? Number(get("age")) : null,
    phone: get("phone"),
    email: get("email"),
    nickname: get("nickname"),
    occupation_category: get("occupation_category"),
    dietary_preference: get("dietary_preference"),
    note: get("note"),
    pricing_plan: normalizePricingPlan(get("pricing_plan")),
  };
}

// 場次卡片自帶 CSS（注入一次），不依賴 Webflow class——避免刪掉靜態卡片後
// Webflow 把 .session 等樣式 tree-shake 掉，導致動態卡片變無樣式。
function injectSessionStyles() {
  if (document.getElementById("od-session-styles")) return;
  const style = document.createElement("style");
  style.id = "od-session-styles";
  style.textContent = `
    #od-sessions { display: flex; flex-direction: column; gap: 12px; }
    .od-session-card { border: 2px solid #ddd; border-radius: 12px; padding: 16px 20px;
      transition: border-color .15s, box-shadow .15s; background: #fff; }
    .od-session-card.od-selected { border-color: #ff6b35; box-shadow: 0 0 0 3px rgba(255,107,53,.15); }
    .od-session-card.od-soldout { opacity: .5; pointer-events: none; }
    .od-card-title { font-weight: 700; font-size: 1.05rem; }
    .od-card-meta { color: #666; margin: 4px 0 10px; }
    .od-card-counts { display: flex; gap: 24px; font-size: .9rem; }
    .od-card-counts span { color: #555; }
    .od-card-deadline { color: #888; font-size: .85rem; margin-top: 8px; }
  `;
  document.head.appendChild(style);
}

// 在 #od-sessions 容器渲染可點選的場次卡片。
// 點卡片 → 高亮、把 session.id 寫進 formEl.dataset.sessionId、呼叫 onSelect（讓 quote 失效）。
function renderSessions(container, sessions, formEl, onSelect) {
  injectSessionStyles();
  container.innerHTML = "";
  sessions.forEach((s) => {
    const c = formatSessionCard(s);
    const card = document.createElement("div");
    card.className = "od-session-card" + (c.soldOut ? " od-soldout" : "");
    card.dataset.sessionId = String(c.id);

    const title = document.createElement("div");
    title.className = "od-card-title";
    title.textContent = c.title;

    const meta = document.createElement("div");
    meta.className = "od-card-meta";
    meta.textContent = `${c.timeLabel}　${c.location}`;

    const counts = document.createElement("div");
    counts.className = "od-card-counts";
    const labels = c.totalLabel ? [c.totalLabel] : [c.maleLabel, c.femaleLabel];
    labels.forEach((text) => {
      const span = document.createElement("span");
      span.textContent = text;
      counts.appendChild(span);
    });

    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(counts);

    if (c.deadlineLabel) {
      const deadline = document.createElement("div");
      deadline.className = "od-card-deadline";
      deadline.textContent = c.deadlineLabel;
      card.appendChild(deadline);
    }

    if (!c.soldOut) {
      card.addEventListener("click", () => {
        container.querySelectorAll(".od-session-card").forEach((el) => el.classList.remove("od-selected"));
        card.classList.add("od-selected");
        formEl.dataset.sessionId = String(c.id);
        if (typeof onSelect === "function") onSelect();
      });
    }
    container.appendChild(card);
  });
}

// 載入的場次依 id 留著：試算時要知道選中的場次是不是固定價
const sessionsById = new Map();

async function loadSessions(formEl, onSelect) {
  const container = document.querySelector("#od-sessions");
  const { body } = await api(`/sessions/?category=${encodeURIComponent(CATEGORY)}`, { method: "GET" });
  if (Array.isArray(body)) body.forEach((s) => sessionsById.set(s.id, s));
  if (container && Array.isArray(body)) renderSessions(container, body, formEl, onSelect);
  return body;
}

function showErrors(errs) {
  const el = document.querySelector("#od-errors");
  if (el) el.textContent = (errs || []).join("、");
}

function showAmount(msg) {
  const el = document.querySelector("#od-amount");
  if (el) el.textContent = msg || "";
}

function setCardVisible(visible) {
  const el = document.querySelector("#od-card");
  if (el) el.style.display = visible ? "" : "none";
}

// ---- 手機驗證（OTP）----
// 在 Webflow 原生手機欄位下方插入「傳送驗證碼 → 輸入驗證碼」，Webflow 版面不用改。
// 按鈕一律 type=button，避免觸發表單送出；驗證碼欄位沒有 name，不會進 Webflow 的表單通知。
// .od-otp-row 設了 display:flex，會蓋掉瀏覽器內建的 [hidden]{display:none}，要明確補回來
export const OTP_STYLES = `
    .od-otp { margin: 8px 0 16px; }
    .od-otp-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .od-otp-row[hidden] { display: none; }
    .od-otp-row input { flex: 1 1 160px; min-width: 0; padding: 8px 12px; border: 1px solid #ccc; border-radius: 8px; font-size: 1rem; }
    .od-otp-btn { padding: 8px 16px; border: 0; border-radius: 8px; background: #ff6b35; color: #fff; font-weight: 600; cursor: pointer; }
    .od-otp-btn:disabled { background: #ccc; cursor: default; }
    .od-otp-msg { margin: 6px 0 0; font-size: .9rem; color: #666; min-height: 1.2em; }
    .od-otp-msg.od-ok { color: #2e7d32; }
    .od-otp-msg.od-err { color: #d32f2f; }
  `;

// 「傳送驗證碼」鈕的狀態：已驗證 > 冷卻倒數 > 可傳送（傳過就叫「重新傳送」）
export function otpSendButtonState({ verified, cooldownLeft, sent }) {
  if (verified) return { disabled: true, text: "已驗證" };
  if (cooldownLeft > 0) return { disabled: true, text: `重新傳送（${cooldownLeft}）` };
  return { disabled: false, text: sent ? "重新傳送" : "傳送驗證碼" };
}

function injectOtpStyles() {
  if (document.getElementById("od-otp-styles")) return;
  const style = document.createElement("style");
  style.id = "od-otp-styles";
  style.textContent = OTP_STYLES;
  document.head.appendChild(style);
}

function mountOtp(phoneInput) {
  injectOtpStyles();
  const box = document.createElement("div");
  box.className = "od-otp";
  box.innerHTML = `
    <div class="od-otp-row"><button type="button" id="od-otp-send" class="od-otp-btn">傳送驗證碼</button></div>
    <div class="od-otp-row" id="od-otp-block" hidden>
      <input id="od-otp-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="輸入 6 碼驗證碼" aria-label="驗證碼 6 碼">
      <button type="button" id="od-otp-verify" class="od-otp-btn">驗證</button>
    </div>
    <p id="od-otp-msg" class="od-otp-msg" role="status"></p>`;
  phoneInput.insertAdjacentElement("afterend", box);
  return {
    send: box.querySelector("#od-otp-send"),
    block: box.querySelector("#od-otp-block"),
    code: box.querySelector("#od-otp-code"),
    verify: box.querySelector("#od-otp-verify"),
    msg: box.querySelector("#od-otp-msg"),
  };
}

function setOtpMsg(ui, text, kind) {
  ui.msg.textContent = text || "";
  ui.msg.className = "od-otp-msg" + (kind ? ` od-${kind}` : "");
}

// 91APP 卡片欄位 glue 見 lib/card91.js（setup / mount 皆只做一次）。
let card = null;
function mountCardFields() {
  if (card) card.mount();
}

// 步驟一：試算金額。回傳 { form, quote }，失敗回 null；手機驗證失效時呼叫 onTokenError。
async function runQuote(formEl, checkoutToken, onTokenError) {
  const form = readForm(formEl);
  const errors = validateForm(form);
  if (errors.length) { showErrors(errors); return null; }
  showErrors([]);

  const quoteRes = await api("/quote/", {
    method: "POST",
    body: JSON.stringify(buildQuotePayload(form, checkoutToken, PAYLOAD_OPTS)),
  });
  if (isCheckoutTokenError(quoteRes.httpStatus, quoteRes.body)) {
    onTokenError(quoteRes.body.error);
    return null;
  }
  if (quoteRes.httpStatus >= 400) {
    showErrors([quoteRes.body && quoteRes.body.error ? quoteRes.body.error : "試算失敗，請稍後再試"]);
    return null;
  }

  const session = sessionsById.get(form.session_id);
  const quote = formatQuoteResult(quoteRes.body, { fixedPrice: !!session && session.price != null });
  showAmount(quote.message);
  if (quote.needsCard) {
    setCardVisible(true);
    mountCardFields(); // 顯示後才掛載 iframe 欄位
  } else {
    setCardVisible(false);
  }
  return { form, quote };
}

// 步驟二：確認付款。付費方案才取 txnToken（90 秒有效，當下才取），空 token＝卡號未填對。
async function submitRegistration(form, quote, checkoutToken, onTokenError) {
  let txnToken = "";
  if (quote.needsCard) {
    txnToken = card ? await card.getTxnToken() : "";
    if (!txnToken) {
      showErrors(["信用卡資訊有誤，請確認卡號、有效期限與末三碼"]);
      return;
    }
  }

  const regRes = await api("/registrations/", {
    method: "POST",
    body: JSON.stringify(buildRegistrationPayload(form, txnToken, checkoutToken, PAYLOAD_OPTS)),
  });

  const route = routeRegistrationResponse(regRes.body, regRes.httpStatus);
  if (route.action === "redirect") {
    window.location.href = route.url;
  } else if (route.action === "success") {
    window.location.href = `${SUCCESS_PATH}?order=${encodeURIComponent(route.orderToken)}`;
  } else if (route.action === "reverify") {
    onTokenError(route.message);
  } else {
    showErrors([route.message]);
  }
}

function setSubmitLabel(btn, text) {
  if (!btn) return;
  if (btn.tagName === "INPUT") btn.value = text;
  else btn.textContent = text;
}

// Watch .w-form and revert whenever Webflow's native submit toggles the done/fail UI.
// Disconnect during revert so our own style changes don't re-trigger the observer.
function neutralizeWebflowFormUI(formEl) {
  if (typeof MutationObserver === "undefined") return;
  const wrap = formEl.closest(".w-form");
  if (!wrap) return;
  const targets = [formEl, ...wrap.querySelectorAll(".w-form-done, .w-form-fail")];
  const opts = { attributes: true, attributeFilter: ["style"] };
  const observe = () => targets.forEach((t) => obs.observe(t, opts));
  const obs = new MutationObserver(() => {
    obs.disconnect();
    revertWebflowFormUI(formEl);
    observe();
  });
  observe();
}

async function initPaymentFlow() {
  const formEl = document.querySelector("#wf-form form") || document.querySelector("form");
  if (!formEl) return;

  if (!card) card = createCard91();
  if (!card.available) {
    console.error("91APP SDK 載入失敗");
    return;
  }
  card.setup(PUBLISHABLE_KEY, SDK_ENV);
  setCardVisible(false); // 試算前不顯示卡片欄位

  // 自動試算單按鈕流程：選好場次+填齊手機 → 自動 /quote/ → 顯示金額/卡片、
  // 送出鈕變「確認付款 NT$X」並啟用；任何相關欄位變動就讓 quote 失效並重算。
  // 金額仍在刷卡前先出現，避免方案降級造成的意外扣款。
  let current = null; // { form, quote }
  let busy = false;
  let quoteTimer = null;
  // 手機驗證狀態：verifiedPhone 是拿到 checkoutToken 時的號碼；號碼一改就作廢
  const otp = { token: "", phone: "", checkoutToken: "", verifiedPhone: "", cooldownTimer: null, cooldownLeft: 0 };
  const phoneInput = formEl.querySelector(`[name="${FIELD_NAME_MAP.phone}"]`);
  const otpUi = PHONE_OTP && phoneInput ? mountOtp(phoneInput) : null;
  const submitBtn = formEl.querySelector("[type=submit]");
  const initialLabel = submitBtn ? (submitBtn.tagName === "INPUT" ? submitBtn.value : submitBtn.textContent) : "";
  if (submitBtn) submitBtn.disabled = true; // 試算完成前不可送出

  function invalidateQuote() {
    current = null;
    if (submitBtn) {
      submitBtn.disabled = true;
      setSubmitLabel(submitBtn, initialLabel);
    }
    showAmount("");
    setCardVisible(false);
  }

  function resetVerification(message) {
    otp.checkoutToken = "";
    otp.verifiedPhone = "";
    otp.token = "";
    if (!otpUi) return;
    otpUi.block.hidden = true;
    otpUi.code.value = "";
    renderSendButton();
    setOtpMsg(otpUi, message || "", message ? "err" : "");
  }

  function renderSendButton() {
    const s = otpSendButtonState({ verified: !!otp.checkoutToken, cooldownLeft: otp.cooldownLeft, sent: !!otp.token });
    otpUi.send.disabled = s.disabled;
    otpUi.send.textContent = s.text;
  }

  function onTokenError(message) {
    invalidateQuote();
    resetVerification(message || "手機驗證已失效，請重新驗證");
  }

  function startCooldown() {
    otp.cooldownLeft = OTP_COOLDOWN_SECONDS;
    renderSendButton();
    otp.cooldownTimer = setInterval(() => {
      otp.cooldownLeft -= 1;
      if (otp.cooldownLeft <= 0) {
        clearInterval(otp.cooldownTimer);
        otp.cooldownTimer = null;
        otp.cooldownLeft = 0;
      }
      renderSendButton();
    }, 1000);
  }

  async function sendOtp() {
    const phone = String(phoneInput.value || "").trim();
    if (!phone) { setOtpMsg(otpUi, "請先填寫手機", "err"); return; }
    otpUi.send.disabled = true;
    try {
      const r = otpCreateRoute(await otpApi("/otp/create/", {
        method: "POST",
        body: JSON.stringify({ phone_number: phone }),
      }));
      if (r.action === "sent") {
        otp.token = r.token;
        otp.phone = phone;
        otpUi.block.hidden = false;
        otpUi.code.value = "";
        otpUi.code.focus();
        setOtpMsg(otpUi, `驗證碼已傳送到 ${r.phoneMasked || phone}`, "ok");
        startCooldown();
      } else {
        setOtpMsg(otpUi, r.message, "err");
        otpUi.send.disabled = false;
      }
    } catch (err) {
      console.error("otp/create", err);
      setOtpMsg(otpUi, "系統忙線中，請稍後再試", "err");
      otpUi.send.disabled = false;
    }
  }

  async function verifyOtp() {
    const code = String(otpUi.code.value || "").replace(/\D/g, "");
    if (!otp.token || code.length < 4) { setOtpMsg(otpUi, "請輸入簡訊中的驗證碼", "err"); return; }
    otpUi.verify.disabled = true;
    try {
      const r = otpVerifyRoute(await otpApi("/otp/verify/", {
        method: "POST",
        body: JSON.stringify({ phone_number: otp.phone, otp: code, token: otp.token }),
      }));
      if (r.action === "verified") {
        otp.checkoutToken = r.checkoutToken;
        otp.verifiedPhone = otp.phone;
        otpUi.block.hidden = true;
        renderSendButton();
        setOtpMsg(otpUi, "手機已驗證", "ok");
        maybeQuote();
      } else {
        if (r.resend) otpUi.block.hidden = true;
        setOtpMsg(otpUi, r.message, "err");
      }
    } catch (err) {
      console.error("otp/verify", err);
      setOtpMsg(otpUi, "系統忙線中，請稍後再試", "err");
    } finally {
      otpUi.verify.disabled = false;
    }
  }

  if (otpUi) {
    otpUi.send.addEventListener("click", sendOtp);
    otpUi.verify.addEventListener("click", verifyOtp);
    otpUi.code.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); verifyOtp(); } // 別讓 Enter 送出整張表單
    });
  } else if (PHONE_OTP) {
    console.error("找不到手機欄位，無法驗證手機");
  }

  async function doQuote() {
    if (busy) return;
    busy = true;
    try {
      current = await runQuote(formEl, otp.checkoutToken, onTokenError);
      if (submitBtn) {
        submitBtn.disabled = !current;
        if (current) {
          setSubmitLabel(
            submitBtn,
            current.quote.needsCard ? `確認付款 NT$${current.quote.amount}` : "確認報名（本次免費）"
          );
        }
      }
    } finally {
      busy = false;
    }
  }

  // 欄位齊了才自動試算；用防抖避免每次按鍵都打 API。
  function maybeQuote() {
    const form = readForm(formEl);
    if (!canAutoQuote(form, otp.checkoutToken, PAYLOAD_OPTS)) return;
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(() => { doQuote(); }, 500);
  }

  // 任一欄位變動（含改場次）→ 先讓舊 quote 失效，再排程重算。
  // 改了手機號碼 → 之前的驗證作廢（驗證碼欄位自己的輸入不算）。
  function onFieldChange(e) {
    if (otpUi && e && e.target === otpUi.code) return;
    if (phoneInput && otp.verifiedPhone && String(phoneInput.value || "").trim() !== otp.verifiedPhone) {
      resetVerification("");
    }
    invalidateQuote();
    maybeQuote();
  }
  formEl.addEventListener("input", onFieldChange);
  formEl.addEventListener("change", onFieldChange);

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault(); // 接管 Webflow 預設送出
    if (busy || !current) return; // 尚未試算完成不送出（按鈕本來就 disabled）
    busy = true;
    if (submitBtn) submitBtn.disabled = true;
    try {
      await submitRegistration(current.form, current.quote, otp.checkoutToken, onTokenError);
    } finally {
      busy = false;
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  neutralizeWebflowFormUI(formEl); // keep native submit (notification), suppress fake-success UI
  loadSessions(formEl, onFieldChange).catch((e) => console.error("loadSessions", e));
}

if (typeof document !== "undefined") {
  if (document.readyState !== "loading") initPaymentFlow();
  else document.addEventListener("DOMContentLoaded", initPaymentFlow);
}
