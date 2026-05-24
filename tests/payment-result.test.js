import { describe, it, expect, vi } from "vitest";
import {
  getOrderId,
  isTerminalStatus,
  pollStatus,
  buildResultView,
  statusLabel,
  resultRedirectTarget,
} from "../src/payment-result.js";

describe("getOrderId", () => {
  it("從 query string 取 order", () => {
    expect(getOrderId("?order=TEA-20260614-001")).toBe("TEA-20260614-001");
  });
  it("沒有 order → null", () => expect(getOrderId("?foo=1")).toBeNull());
});

describe("isTerminalStatus", () => {
  it("confirmed 為終態", () => expect(isTerminalStatus("confirmed")).toBe(true));
  it("pending_payment 非終態", () => expect(isTerminalStatus("pending_payment")).toBe(false));
});

describe("pollStatus", () => {
  it("輪詢直到 confirmed", async () => {
    const responses = [
      { status: "pending_payment" },
      { status: "pending_payment" },
      { status: "confirmed", name: "王小明" },
    ];
    let i = 0;
    const fetchFn = vi.fn(async () => responses[i++]);
    const final = await pollStatus("TEA-1", fetchFn, { intervalMs: 0, maxAttempts: 5 });
    expect(final.status).toBe("confirmed");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("達 maxAttempts 仍非終態 → 回最後一筆並標記 timedOut", async () => {
    const fetchFn = vi.fn(async () => ({ status: "pending_payment" }));
    const final = await pollStatus("TEA-1", fetchFn, { intervalMs: 0, maxAttempts: 3 });
    expect(final.timedOut).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});

describe("buildResultView", () => {
  it("組出畫面欄位（含中文狀態）", () => {
    const v = buildResultView({
      status: "confirmed", merchant_order_id: "TEA-1",
      amount: 300, session_title: "週六午後場", name: "王小明",
    });
    expect(v).toMatchObject({
      orderId: "TEA-1", amount: 300, sessionTitle: "週六午後場", name: "王小明",
      confirmed: true, statusLabel: "已確認",
    });
  });
});

describe("statusLabel", () => {
  it("confirmed → 已確認", () => expect(statusLabel("confirmed")).toBe("已確認"));
  it("failed → 付款失敗", () => expect(statusLabel("failed")).toBe("付款失敗"));
  it("expired → 已逾時", () => expect(statusLabel("expired")).toBe("已逾時"));
  it("pending_payment → 待付款", () => expect(statusLabel("pending_payment")).toBe("待付款"));
  it("未知狀態原樣回傳", () => expect(statusLabel("weird")).toBe("weird"));
});

describe("resultRedirectTarget", () => {
  it("成功頁收到失敗狀態 → 導去失敗頁", () =>
    expect(resultRedirectTarget("failed", "/afternoon-tea-payment-success")).toBe(
      "/afternoon-tea-payment-fail"
    ));
  it("失敗頁收到 confirmed → 導去成功頁", () =>
    expect(resultRedirectTarget("confirmed", "/afternoon-tea-payment-fail")).toBe(
      "/afternoon-tea-payment-success"
    ));
  it("成功頁收到 confirmed → 不導向（留在原頁）", () =>
    expect(resultRedirectTarget("confirmed", "/afternoon-tea-payment-success")).toBeNull());
  it("pending（未終態）不導向", () =>
    expect(resultRedirectTarget("pending_payment", "/afternoon-tea-payment-success")).toBeNull());
});
