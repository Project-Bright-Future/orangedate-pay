// KOL 完成頁：?order=KOL-… → GET orders/status/{id}/ 輪詢 2s×15，
// 完成判定 = status=paid AND grant_status=granted（不採信 3DS 導回的 query 參數）。文案 SPEC A C-1-5 / C-5。
import { pollUntil } from "./lib/poll.js";
import { createApi } from "./lib/api.js";
import { parseCookie } from "./lib/cookie.js";
import { formatTpeDate, escapeHtml as e } from "./lib/format.js";

export const PROCESSING_COPY = "款項處理中，開通後會用簡訊通知你";
export const APP_DOWNLOAD_URL = "https://onelink.to/zqfayt";
const FINAL_FAIL = ["failed", "expired", "refunded"];

// 停止輪詢的條件：paid+granted、終態失敗、或訂單不存在。paid 但未授予 → 續輪（「已收款未授予」是合法中間態）。
export function isKolDone(res) {
  if (!res) return false;
  if (res.code === "order_not_found") return true;
  if (res.status === "paid" && res.grant_status === "granted") return true;
  return FINAL_FAIL.includes(res.status);
}

export function resultView(res) {
  res = res || {};
  if (res.code === "order_not_found") return { state: "not_found" };
  if (res.status === "paid" && res.grant_status === "granted") {
    return {
      state: "success",
      orderId: res.merchant_order_id,
      paidAt: formatTpeDate(res.paid_at),
      expireAt: formatTpeDate(res.expire_at),
      phoneMasked: res.phone_masked || "",
    };
  }
  if (res.status === "refunded") return { state: "refunded" };
  if (FINAL_FAIL.includes(res.status)) return { state: "failed" };
  return { state: "processing" };
}

export function renderResult(view, { returnPath }) {
  const back = `<p><a class="odk-btn odk-btn-secondary" href="${e(returnPath || "/")}">回到結帳頁</a></p>`;
  switch (view.state) {
    case "success":
      return `
<h2 class="odk-result-title">開通完成</h2>
<p>你的尊榮會員已經開通了。</p>
<p class="odk-period-line">有效期間：${e(view.paidAt)} － ${e(view.expireAt)}</p>
<p>接下來只要兩步：</p>
<ol class="odk-steps">
  <li>1. 下載橘時相遇 App</li>
  <li>2. 用剛才驗證的手機號碼 ${e(view.phoneMasked)} 登入</li>
</ol>
<p><a class="odk-btn" href="${APP_DOWNLOAD_URL}" target="_blank" rel="noopener">下載 App</a></p>
<p class="odk-help">第一次使用的話，登入後會請你完成人臉驗證，大約三分鐘。<br>權益從今天開始計算，建議先把 App 裝起來。</p>
<p class="odk-help">有任何問題，隨時在 LINE 找我們。</p>`;
    case "failed":
      return `<h2 class="odk-result-title">付款未完成</h2><p>這筆付款沒有成功，尚未開通。可以回到結帳頁重新付款，或在 LINE 找我們。</p>${back}`;
    case "refunded":
      return `<h2 class="odk-result-title">這筆訂單已退款</h2><p>有任何問題，隨時在 LINE 找我們。</p>`;
    case "not_found":
      return `<h2 class="odk-result-title">找不到這筆訂單</h2><p>請確認連結是否正確，或在 LINE 找我們。</p>${back}`;
    default:
      return `<h2 class="odk-result-title">${PROCESSING_COPY}</h2><p>有任何問題，隨時在 LINE 找我們。</p>`;
  }
}

// ---- Browser glue（vitest/node 略過）----
// 設定由 Webflow head custom code 的 window.OD_KOL 帶入：{ apiBase }
const CFG = (typeof window !== "undefined" && window.OD_KOL) || {};
const API_BASE = CFG.apiBase || "https://dev-api.orangedate.com/api/pbf-kol";

function injectStyles() {
  if (document.getElementById("odk-result-styles")) return;
  const style = document.createElement("style");
  style.id = "odk-result-styles";
  style.textContent = `
    #od-kol-result { max-width: 560px; margin: 0 auto; padding: 24px 16px; line-height: 1.7; color: #333; }
    .odk-result-title { font-size: 1.6rem; font-weight: 700; margin: 0 0 12px; }
    .odk-period-line { font-weight: 700; }
    .odk-steps { list-style: none; padding: 0; margin: 0 0 12px; }
    .odk-help { color: #666; font-size: .9rem; }
    .odk-btn { display: inline-block; background: #ff6b35; color: #fff; border: 0; border-radius: 999px;
      padding: 12px 28px; font-size: 1rem; font-weight: 700; text-decoration: none; cursor: pointer; }
    .odk-btn-secondary { background: #fff; color: #ff6b35; border: 2px solid #ff6b35; }
  `;
  document.head.appendChild(style);
}

async function initResultPage() {
  const root = document.querySelector("#od-kol-result");
  if (!root) return;
  injectStyles();
  const orderId = new URLSearchParams(window.location.search).get("order");
  const returnPath = parseCookie(document.cookie, "od_kol_return") || "/";
  if (!orderId) { root.innerHTML = renderResult({ state: "not_found" }, { returnPath }); return; }

  root.innerHTML = `<p class="odk-help">正在確認付款狀態…</p>`;
  const api = createApi(API_BASE);
  const final = await pollUntil(
    async () => (await api(`/orders/status/${encodeURIComponent(orderId)}/`, { method: "GET" })).body,
    isKolDone,
    { intervalMs: 2000, maxAttempts: 15 }
  );
  root.innerHTML = renderResult(resultView(final), { returnPath });
}

if (typeof document !== "undefined") {
  if (document.readyState !== "loading") initResultPage();
  else document.addEventListener("DOMContentLoaded", initResultPage);
}
