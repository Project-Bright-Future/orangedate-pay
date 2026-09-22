import { describe, it, expect } from "vitest";
import { fixedNavOffset, measureNav, applyNavOffset } from "../src/lib/nav-offset.js";

const rect = (height) => ({ getBoundingClientRect: () => ({ height }) });

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
  it("取容器與子元素的最大高度（.w-nav 容器本身只有 30px，wrapper 才是 84）", () => {
    const nav = { ...rect(30), children: [rect(84), rect(10)] };
    expect(measureNav(nav, () => ({ position: "fixed" }))).toEqual({ position: "fixed", height: 84 });
  });
  it("沒 nav → 空", () => {
    expect(measureNav(null, () => ({}))).toEqual({ position: "", height: 0 });
  });
});

describe("applyNavOffset", () => {
  const win = { getComputedStyle: () => ({ position: "fixed" }) };
  it("有 fixed navbar → root padding-top = 高度 + 原本 padding", () => {
    const root = { style: { paddingTop: "" } };
    const doc = { querySelector: () => ({ ...rect(30), children: [rect(84)] }) };
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
