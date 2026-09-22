import { describe, it, expect } from "vitest";
import { fixedNavOffset, measureNav, applyNavOffset } from "../src/lib/nav-offset.js";

const box = (top, bottom) => ({ getBoundingClientRect: () => ({ top, bottom, height: bottom - top }) });
// 實測 staging：.w-nav 與其直接子元素只有 30px，84px 的 wrapper 在更深層
const fakeNav = () => ({ ...box(0, 30), querySelectorAll: () => [box(0, 30), box(0, 84), box(0, 0)] });

describe("fixedNavOffset", () => {
  it("fixed 且有高度 → 無條件進位的高度", () => {
    expect(fixedNavOffset({ position: "fixed", height: 84 })).toBe(84);
    expect(fixedNavOffset({ position: "fixed", height: 83.4 })).toBe(84);
  });
  it("非 fixed / 高度 0 / 沒 nav → 0", () => {
    expect(fixedNavOffset({ position: "static", height: 84 })).toBe(0);
    expect(fixedNavOffset({ position: "fixed", height: 0 })).toBe(0);
    expect(fixedNavOffset()).toBe(0);
  });
});

describe("measureNav", () => {
  it("取所有後代 bottom 相對 nav top 的最大值（不是容器或直接子元素的高度）", () => {
    expect(measureNav(fakeNav(), () => ({ position: "fixed" }))).toEqual({ position: "fixed", height: 84 });
  });
  it("nav 不在 top 0 時仍量相對高度", () => {
    const nav = { ...box(10, 40), querySelectorAll: () => [box(10, 94)] };
    expect(measureNav(nav, () => ({ position: "fixed" })).height).toBe(84);
  });
  it("沒 nav → 空", () => {
    expect(measureNav(null, () => ({}))).toEqual({ position: "", height: 0 });
  });
});

describe("applyNavOffset", () => {
  const win = { getComputedStyle: () => ({ position: "fixed" }) };
  it("有 fixed navbar → root padding-top = 原本 padding + 高度", () => {
    const root = { style: { paddingTop: "" } };
    const doc = { querySelector: () => fakeNav() };
    expect(applyNavOffset(root, { doc, win, basePx: 24 })).toBe(84);
    expect(root.style.paddingTop).toBe("108px");
  });
  it("沒 navbar → 不動 padding、回 0", () => {
    const root = { style: { paddingTop: "" } };
    const doc = { querySelector: () => null };
    expect(applyNavOffset(root, { doc, win, basePx: 24 })).toBe(0);
    expect(root.style.paddingTop).toBe("");
  });
});
