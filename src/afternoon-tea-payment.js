export function buildQuotePayload(form) {
  return {
    session_id: form.session_id,
    phone: form.phone,
    pricing_plan: form.pricing_plan || "general",
  };
}

export function buildRegistrationPayload(form, txnToken) {
  return {
    session_id: form.session_id,
    name: form.name,
    gender: form.gender,
    age: form.age ?? null,
    phone: form.phone,
    email: form.email,
    nickname: form.nickname || "",
    occupation_category: form.occupation_category || "",
    dietary_preference: form.dietary_preference || "",
    note: form.note || "",
    pricing_plan: form.pricing_plan || "general",
    txn_token: txnToken || "",
  };
}

export function routeRegistrationResponse(res, httpStatus) {
  res = res || {};
  if (httpStatus >= 400) {
    return { action: "error", message: res.error || "系統忙線中，請稍後再試" };
  }
  if (res.redirect_url) {
    return { action: "redirect", url: res.redirect_url };
  }
  // confirmed 或 pending_payment（無 redirect）一律導去成功頁，
  // 由成功頁輪詢 status 端點確認最終結果（含 failed/expired）
  return { action: "success", orderId: res.merchant_order_id };
}

const PLAN_LABELS = {
  general: "一般報名",
  verified: "App 單身認證優惠",
  subscriber: "付費訂閱會員",
};

export function formatQuoteResult(quote) {
  const amount = quote.amount;
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

// 把後端 GET /sessions/ 的單筆場次整理成卡片顯示用資料（純函式，免 DOM 可測）。
export function formatSessionCard(session) {
  const hhmm = (t) => (t || "").slice(0, 5);
  return {
    id: session.id,
    title: session.title || "",
    timeLabel: `${session.date || ""} ${hhmm(session.start_time)}–${hhmm(session.end_time)}`,
    location: session.location_name || "",
    maleLabel: `男生剩餘名額：${session.remaining_male}`,
    femaleLabel: `女生剩餘名額：${session.remaining_female}`,
    soldOut: !session.is_male_open && !session.is_female_open,
  };
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

// 是否已具備自動試算的最小條件：選了場次、手機數字滿 10 碼。
// （金額由場次/手機/方案決定，這兩項齊了才值得打 /quote/。）
export function canAutoQuote(form) {
  const digits = String(form.phone || "").replace(/\D/g, "");
  return !!form.session_id && digits.length >= 10;
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
const CFG = (typeof window !== "undefined" && window.OD_PAYMENT) || {};
const API_BASE = CFG.apiBase || "https://dev-api.orangedate.com/api/pbf-event";
const PUBLISHABLE_KEY = CFG.publishableKey || "";
const SDK_ENV = CFG.env || "sandbox";

async function api(path, options) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let body = {};
  try { body = await res.json(); } catch (_) {}
  return { httpStatus: res.status, body };
}

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
    const male = document.createElement("span");
    male.textContent = c.maleLabel;
    const female = document.createElement("span");
    female.textContent = c.femaleLabel;
    counts.appendChild(male);
    counts.appendChild(female);

    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(counts);

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

async function loadSessions(formEl, onSelect) {
  const container = document.querySelector("#od-sessions");
  const { body } = await api("/sessions/", { method: "GET" });
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

// 91APP Web SDK 信用卡欄位以 iframe 掛載到這三個 div（不是單一容器）。
// 須先 setup 再讓使用者輸入，最後才 getTxnToken。setup 只做一次。
let sdkSetup = false;
let cardMounted = false;
function mountCardFields() {
  if (cardMounted) return;
  Payments91APP.card.setup({
    enableIcon: false,
    fields: {
      number: { element: "#card-number", placeholder: "信用卡號" },
      expirationDate: { element: "#card-expiration-date", placeholder: "有效期限 MM/YY" },
      ccv: { element: "#card-ccv", placeholder: "末三碼" },
    },
    styles: {
      normal: { width: "100%", height: "44px", color: "#333333", borderColor: "#DDDDDD" },
      focus: { borderColor: "#ff6b35" },
      error: { color: "#e53935", borderColor: "#e53935" },
      success: { borderColor: "#43a047" },
    },
  });
  cardMounted = true;
}

// 步驟一：試算金額。回傳 { form, quote }，失敗回 null。
async function runQuote(formEl) {
  const form = readForm(formEl);
  const errors = validateForm(form);
  if (errors.length) { showErrors(errors); return null; }
  showErrors([]);

  const quoteRes = await api("/quote/", {
    method: "POST",
    body: JSON.stringify(buildQuotePayload(form)),
  });
  if (quoteRes.httpStatus >= 400) {
    showErrors([quoteRes.body && quoteRes.body.error ? quoteRes.body.error : "試算失敗，請稍後再試"]);
    return null;
  }

  const quote = formatQuoteResult(quoteRes.body);
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
async function submitRegistration(form, quote) {
  let txnToken = "";
  if (quote.needsCard) {
    const r = await Payments91APP.card.getTxnToken();
    txnToken = r && r.txnToken ? r.txnToken : "";
    if (!txnToken) {
      showErrors(["信用卡資訊有誤，請確認卡號、有效期限與末三碼"]);
      return;
    }
  }

  const regRes = await api("/registrations/", {
    method: "POST",
    body: JSON.stringify(buildRegistrationPayload(form, txnToken)),
  });

  const route = routeRegistrationResponse(regRes.body, regRes.httpStatus);
  if (route.action === "redirect") {
    window.location.href = route.url;
  } else if (route.action === "success") {
    window.location.href = `/afternoon-tea-payment-success?order=${route.orderId}`;
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

  if (typeof Payments91APP === "undefined") {
    console.error("91APP SDK 載入失敗");
    return;
  }
  if (!sdkSetup) { // 防 DOMContentLoaded 重觸發導致重複 setup
    Payments91APP.setupSDK(PUBLISHABLE_KEY, SDK_ENV);
    sdkSetup = true;
  }
  setCardVisible(false); // 試算前不顯示卡片欄位

  // 自動試算單按鈕流程：選好場次+填齊手機 → 自動 /quote/ → 顯示金額/卡片、
  // 送出鈕變「確認付款 NT$X」並啟用；任何相關欄位變動就讓 quote 失效並重算。
  // 金額仍在刷卡前先出現，避免方案降級造成的意外扣款。
  let current = null; // { form, quote }
  let busy = false;
  let quoteTimer = null;
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

  async function doQuote() {
    if (busy) return;
    busy = true;
    try {
      current = await runQuote(formEl);
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
    if (!canAutoQuote(form)) return;
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(() => { doQuote(); }, 500);
  }

  // 任一欄位變動（含改場次）→ 先讓舊 quote 失效，再排程重算。
  function onFieldChange() {
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
      await submitRegistration(current.form, current.quote);
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
