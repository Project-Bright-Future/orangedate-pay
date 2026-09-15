import { describe, it, expect, vi } from "vitest";
import { createCard91, DEFAULT_CARD_FIELDS } from "../src/lib/card91.js";

function fakeSdk(txn = "tok") {
  return {
    setupSDK: vi.fn(),
    card: {
      setup: vi.fn(),
      getTxnToken: vi.fn(async () => ({ txnToken: txn })),
      onUpdate: vi.fn(),
    },
  };
}

describe("createCard91", () => {
  it("SDK 不存在 → available=false，其他呼叫不拋錯", async () => {
    const c = createCard91(undefined);
    expect(c.available).toBe(false);
    expect(() => c.setup("k", "sandbox")).not.toThrow();
    expect(() => c.mount()).not.toThrow();
    expect(await c.getTxnToken()).toBe("");
  });

  it("setup 只呼叫 setupSDK 一次", () => {
    const sdk = fakeSdk();
    const c = createCard91(sdk);
    c.setup("pk", "sandbox");
    c.setup("pk", "sandbox");
    expect(sdk.setupSDK).toHaveBeenCalledTimes(1);
    expect(sdk.setupSDK).toHaveBeenCalledWith("pk", "sandbox");
  });

  it("mount 預設掛到 #card-number/#card-expiration-date/#card-ccv，只掛一次", () => {
    const sdk = fakeSdk();
    const c = createCard91(sdk);
    c.mount();
    c.mount();
    expect(sdk.card.setup).toHaveBeenCalledTimes(1);
    const arg = sdk.card.setup.mock.calls[0][0];
    expect(arg.fields.number.element).toBe("#card-number");
    expect(arg.fields.expirationDate.element).toBe("#card-expiration-date");
    expect(arg.fields.ccv.element).toBe("#card-ccv");
    expect(arg.fields).toEqual(DEFAULT_CARD_FIELDS);
    expect(arg.styles.focus.borderColor).toBe("#ff6b35");
  });

  it("getTxnToken 回字串；SDK 回空 → 空字串", async () => {
    expect(await createCard91(fakeSdk("abc")).getTxnToken()).toBe("abc");
    expect(await createCard91(fakeSdk(null)).getTxnToken()).toBe("");
  });

  it("onUpdate 轉交 SDK", () => {
    const sdk = fakeSdk();
    const cb = () => {};
    createCard91(sdk).onUpdate(cb);
    expect(sdk.card.onUpdate).toHaveBeenCalledWith(cb);
  });
});
