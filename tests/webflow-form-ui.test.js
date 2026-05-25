import { describe, it, expect } from "vitest";
import { revertWebflowFormUI } from "../src/afternoon-tea-payment.js";

// Lightweight fake DOM (duck typing) to test revertWebflowFormUI without jsdom.
function makeFakeForm() {
  const done = { style: { display: "block" } };
  const fail = { style: { display: "block" } };
  const wrap = {
    querySelectorAll: (sel) => (sel === ".w-form-done, .w-form-fail" ? [done, fail] : []),
  };
  const form = {
    style: { display: "none" },
    closest: (sel) => (sel === ".w-form" ? wrap : null),
  };
  return { form, done, fail };
}

describe("revertWebflowFormUI", () => {
  it("Webflow 藏表單跳假成功後 → 還原表單顯示、隱藏 done/fail", () => {
    const { form, done, fail } = makeFakeForm();
    revertWebflowFormUI(form);
    expect(form.style.display).toBe(""); // 表單（含 #od-errors）還原顯示
    expect(done.style.display).toBe("none");
    expect(fail.style.display).toBe("none");
  });

  it("沒有 .w-form 包裹時安靜略過、不動表單", () => {
    const form = { style: { display: "none" }, closest: () => null };
    expect(() => revertWebflowFormUI(form)).not.toThrow();
    expect(form.style.display).toBe("none");
  });

  it("formEl 為 null 時不報錯", () => {
    expect(() => revertWebflowFormUI(null)).not.toThrow();
  });
});
