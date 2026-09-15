// 91APP Web SDK 信用卡欄位 glue（下午茶頁 / KOL 頁共用）。
// 卡片欄位以 iframe 掛到三個 div（不是單一 input）；須先 setup 再 mount，最後才 getTxnToken。
// setup / mount 都只做一次（防 DOMContentLoaded 重觸發）。sdk 可注入（測試用）。
export const DEFAULT_CARD_FIELDS = {
  number: { element: "#card-number", placeholder: "信用卡號" },
  expirationDate: { element: "#card-expiration-date", placeholder: "有效期限 MM/YY" },
  ccv: { element: "#card-ccv", placeholder: "末三碼" },
};

export const DEFAULT_CARD_STYLES = {
  normal: { width: "100%", height: "44px", color: "#333333", borderColor: "#DDDDDD" },
  focus: { borderColor: "#ff6b35" },
  error: { color: "#e53935", borderColor: "#e53935" },
  success: { borderColor: "#43a047" },
};

export function createCard91(sdk = (typeof Payments91APP !== "undefined" ? Payments91APP : undefined)) {
  let setupDone = false;
  let mounted = false;
  return {
    available: !!sdk,
    setup(publishableKey, env) {
      if (!sdk || setupDone) return;
      sdk.setupSDK(publishableKey, env);
      setupDone = true;
    },
    mount(fields = DEFAULT_CARD_FIELDS, styles = DEFAULT_CARD_STYLES) {
      if (!sdk || mounted) return;
      sdk.card.setup({ enableIcon: false, fields, styles });
      mounted = true;
    },
    // 90 秒有效，送出當下才取；空字串＝卡號未填對。
    async getTxnToken() {
      if (!sdk) return "";
      const r = await sdk.card.getTxnToken();
      return r && r.txnToken ? r.txnToken : "";
    },
    onUpdate(cb) {
      if (sdk && sdk.card.onUpdate) sdk.card.onUpdate(cb);
    },
  };
}
