# orangedate-pay

橘時相遇下午茶報名頁的前端金流 JS（串接 91APP Web SDK 與後端 `pbf_event` API），供 [jsDelivr](https://www.jsdelivr.com/?docs=gh) 在 Webflow 引入。

> 本 repo 是這兩支 JS 的**唯一正式來源**。請勿在別處（如私有的 `orangedate-site`）另存副本後分開維護，以免 Webflow 載到舊版。

## 檔案

| 檔案 | 責任 |
|---|---|
| `src/afternoon-tea-payment.js` | 報名頁主邏輯：場次動態渲染、自動試算單按鈕流程、欄位對應表、付款送出與回應分流 |
| `src/payment-result.js` | 結果頁邏輯：讀 order、狀態輪詢、狀態中文化、成功/失敗頁互導 |

純函式（payload 組裝、回應分流、金額顯示、狀態輪詢）以 vitest 做單元測試；瀏覽器接線層（DOM / 91APP SDK）在 sandbox 手動驗證。

## 測試

```bash
npm install
npm test        # vitest run
```

## 在 Webflow 引入（jsDelivr）

下 git tag 後，於 Webflow 對應頁面 footer custom code 引入（`@<tag>` 鎖版本，避免快取問題）：

```html
<!-- 報名頁 -->
<script type="module"
  src="https://cdn.jsdelivr.net/gh/Project-Bright-Future/orangedate-pay@<tag>/src/afternoon-tea-payment.js"></script>

<!-- 兩個結果頁 -->
<script type="module"
  src="https://cdn.jsdelivr.net/gh/Project-Bright-Future/orangedate-pay@<tag>/src/payment-result.js"></script>
```

`window.OD_PAYMENT`（`publishableKey` / `env` / `apiBase`）與 91APP SDK script 放在頁面 `<head>`，設定細節見 `orangedate-site` 的 `docs/webflow-setup.md`。
