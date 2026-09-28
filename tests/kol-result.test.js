import { describe, it, expect } from "vitest";
import { isKolDone, resultView, renderResult, PROCESSING_COPY } from "../src/kol-result.js";

const paid = {
  status: "paid", grant_status: "granted", merchant_order_id: "KOL-20260915-001", amount: 2400,
  paid_at: "2026-09-15T02:00:00Z", expire_at: "2026-12-14T02:00:00Z", phone_masked: "0944***093",
};

describe("isKolDone", () => {
  it("paid + granted → done；paid 但 grant pending → 未完成（繼續輪詢）", () => {
    expect(isKolDone(paid)).toBe(true);
    expect(isKolDone({ ...paid, grant_status: "pending" })).toBe(false);
    expect(isKolDone({ ...paid, grant_status: "failed" })).toBe(false);
  });
  it("failed / expired / refunded → done；pending_payment → 否", () => {
    for (const s of ["failed", "expired", "refunded"]) expect(isKolDone({ status: s })).toBe(true);
    expect(isKolDone({ status: "pending_payment", grant_status: "pending" })).toBe(false);
  });
  it("404 order_not_found → done（不必再輪）", () => expect(isKolDone({ code: "order_not_found" })).toBe(true));
});

describe("resultView", () => {
  it("paid+granted → success，日期轉 TPE、phone_masked", () => {
    expect(resultView(paid)).toEqual({
      state: "success", orderId: "KOL-20260915-001",
      paidAt: "2026/09/15", expireAt: "2026/12/14", phoneMasked: "0944***093", prevExpireAt: null,
    });
  });
  it("timedOut / pending → processing", () => {
    expect(resultView({ ...paid, grant_status: "pending", timedOut: true }).state).toBe("processing");
    expect(resultView({ status: "pending_payment", timedOut: true }).state).toBe("processing");
  });
  it("failed / expired → failed；refunded → refunded；404 → not_found", () => {
    expect(resultView({ status: "failed" }).state).toBe("failed");
    expect(resultView({ status: "expired" }).state).toBe("failed");
    expect(resultView({ status: "refunded" }).state).toBe("refunded");
    expect(resultView({ code: "order_not_found", timedOut: true }).state).toBe("not_found");
  });
});

describe("延長（分支 c）", () => {
  const prev = { orderId: "KOL-20260915-001", prevExpireAt: "2027-09-10T02:00:00Z" };
  const ext = { ...paid, expire_at: "2027-12-09T02:00:00Z" };
  it("訂單號對得上 → 顯示從 X 延長到 Y、不寫「權益從今天開始計算」", () => {
    const v = resultView(ext, prev);
    expect(v.prevExpireAt).toBe("2027/09/10");
    const h = renderResult(v, { returnPath: "/" });
    expect(h).toContain("你的尊榮會員已經延長了。");
    expect(h).toContain("到期日從 2027/09/10 延長到 2027/12/09");
    expect(h).not.toContain("有效期間");
    expect(h).not.toContain("權益從今天開始計算");
  });
  it("訂單號不同或沒有 prev → 一般文案", () => {
    expect(resultView(ext, { ...prev, orderId: "KOL-OTHER" }).prevExpireAt).toBeNull();
    expect(resultView(ext).prevExpireAt).toBeNull();
  });
});

describe("renderResult", () => {
  it("success：C-1-5 全文案 + 下載連結 + 遮罩手機", () => {
    const h = renderResult(resultView(paid), { returnPath: "/kol/testkol" });
    for (const t of [
      "開通完成", "你的尊榮會員已經開通了。", "有效期間：2026/09/15 － 2026/12/14",
      "接下來只要兩步：", "1. 下載橘時相遇 App", "2. 用剛才驗證的手機號碼 0944***093 登入",
      "下載 App", 'href="https://onelink.to/zqfayt"',
      "第一次使用的話，登入後會請你完成人臉驗證，大約三分鐘。", "權益從今天開始計算，建議先把 App 裝起來。",
      "有任何問題，隨時在 LINE 找我們。",
    ]) expect(h).toContain(t);
  });
  it("processing：款項處理中", () => {
    expect(PROCESSING_COPY).toBe("款項處理中，開通後會用簡訊通知你");
    expect(renderResult({ state: "processing" }, { returnPath: "/" })).toContain(PROCESSING_COPY);
  });
  it("failed：付款失敗 + 回結帳頁連結", () => {
    const h = renderResult({ state: "failed" }, { returnPath: "/kol/testkol" });
    expect(h).toContain("付款未完成");
    expect(h).toContain('href="/kol/testkol"');
    expect(h).toContain("回到結帳頁");
  });
  it("not_found：找不到訂單", () => {
    expect(renderResult({ state: "not_found" }, { returnPath: "/" })).toContain("找不到這筆訂單");
  });
});
