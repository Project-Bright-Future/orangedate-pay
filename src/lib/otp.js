// 手機 OTP（後端 /api/pbf-kol/otp/create|verify/）的回應分流，KOL 結帳與下午茶報名共用。
// verify 成功拿到 checkout_token；後端以它認定「這支手機驗證過」，報名／訂單一律帶它、不再帶手機號碼。

export const BANNED_COPY = "這個號碼的帳號已經停用了。想重新開始的話，在 LINE 找我們，我們幫你處理。";
export const GENERIC_ERROR = "系統忙線中，請稍後再試";

// Retry-After 可能是秒數或 HTTP-date；解析失敗回 0。
export function retryAfterSeconds(value) {
  if (!value) return 0;
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : Math.max(0, Math.round((t - Date.now()) / 1000));
}

// POST otp/create/ 回應分流。429 依 Retry-After：≥ 1 小時 → 今天用完。
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

// POST otp/verify/ 回應分流。200 只取 checkout_token；需要會員資訊的呼叫端（KOL）自己再讀 body。
// otp_max_attempts 只提示重送（後端沒有 30 分鐘鎖，別假裝有）。
export function otpVerifyRoute({ httpStatus, body }) {
  body = body || {};
  if (httpStatus === 200) return { action: "verified", checkoutToken: body.checkout_token };
  if (httpStatus === 403 && body.code === "user_banned") return { action: "banned", message: BANNED_COPY };
  if (body.code === "otp_expired") return { action: "error", message: "驗證碼已過期，請重新傳送", reason: "expired", resend: true };
  if (body.code === "otp_max_attempts") return { action: "error", message: "錯誤次數過多，請重新傳送驗證碼", reason: "wrong", resend: true };
  if (body.code === "otp_invalid") return { action: "error", message: body.detail || "驗證碼錯誤", reason: "wrong", resend: false };
  return { action: "error", message: body.detail || GENERIC_ERROR, reason: "wrong", resend: false };
}
