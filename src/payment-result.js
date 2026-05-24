const TERMINAL = ["confirmed", "failed", "expired", "cancelled"];

export function getOrderId(search) {
  const order = new URLSearchParams(search).get("order");
  return order || null;
}

export function isTerminalStatus(status) {
  return TERMINAL.includes(status);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function pollStatus(orderId, fetchFn, { intervalMs = 2000, maxAttempts = 15 } = {}) {
  let last = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    last = await fetchFn(orderId);
    if (isTerminalStatus(last.status)) return last;
    if (attempt < maxAttempts - 1) await sleep(intervalMs);
  }
  return { ...last, timedOut: true };
}

const STATUS_LABELS = {
  confirmed: "已確認",
  pending_payment: "待付款",
  failed: "付款失敗",
  expired: "已逾時",
  cancelled: "已取消",
};

// 後端原始狀態 → 顯示用中文（未知狀態原樣回傳，避免吞掉資訊）。
export function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

const SUCCESS_PATH = "/afternoon-tea-payment-success";
const FAIL_PATH = "/afternoon-tea-payment-fail";

// 3DS 一律導回成功頁；依輪詢到的真實狀態決定要不要互導到正確的頁。
// 回傳要導向的路徑，或 null（留在原頁）。只在終態時導向，pending/timeout 不動。
export function resultRedirectTarget(status, currentPath) {
  const onFail = String(currentPath || "").includes("payment-fail");
  if (status === "confirmed") return onFail ? SUCCESS_PATH : null;
  if (status === "failed" || status === "expired" || status === "cancelled") {
    return onFail ? null : FAIL_PATH;
  }
  return null;
}

export function buildResultView(statusRes) {
  return {
    orderId: statusRes.merchant_order_id,
    amount: statusRes.amount,
    sessionTitle: statusRes.session_title,
    name: statusRes.name,
    status: statusRes.status,
    statusLabel: statusLabel(statusRes.status),
    confirmed: statusRes.status === "confirmed",
  };
}

// ---- Browser glue (skipped under vitest/node) ----
const CFG = (typeof window !== "undefined" && window.OD_PAYMENT) || {};
const API_BASE = CFG.apiBase || "https://dev-api.orangedate.com/api/pbf-event";

async function fetchStatus(orderId) {
  const res = await fetch(`${API_BASE}/registrations/status/${orderId}/`);
  return res.json();
}

function renderView(view) {
  // 依結果頁實際 DOM 元素 id 填入；元素不存在則略過（成功頁/失敗頁共用此函式）
  const set = (id, val) => {
    const el = document.querySelector(`#${id}`);
    if (el && val !== undefined && val !== null) el.textContent = val;
  };
  set("od-session-title", view.sessionTitle);
  set("od-name", view.name);
  set("od-amount", view.amount != null ? `NT$${view.amount}` : "");
  set("od-order-id", view.orderId);
  set("od-status", view.statusLabel);
}

async function initResultPage() {
  const orderId = getOrderId(window.location.search);
  if (!orderId) return;
  const final = await pollStatus(orderId, fetchStatus, { intervalMs: 2000, maxAttempts: 15 });
  // 若落在不符狀態的頁面（如 3DS 失敗卻在成功頁），導去正確的結果頁。
  const target = resultRedirectTarget(final.status, window.location.pathname);
  if (target) {
    window.location.replace(`${target}?order=${encodeURIComponent(orderId)}`);
    return;
  }
  renderView(buildResultView(final));
}

if (typeof document !== "undefined") {
  if (document.readyState !== "loading") initResultPage();
  else document.addEventListener("DOMContentLoaded", initResultPage);
}
