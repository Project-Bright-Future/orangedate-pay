import { describe, it, expect, vi } from "vitest";
import { pollUntil } from "../src/lib/poll.js";

describe("pollUntil", () => {
  it("isDone 為 true 即停止並回該筆", async () => {
    const seq = [{ s: "a" }, { s: "b" }, { s: "done" }];
    let i = 0;
    const fetchFn = vi.fn(async () => seq[i++]);
    const r = await pollUntil(fetchFn, (x) => x.s === "done", { intervalMs: 0, maxAttempts: 5 });
    expect(r).toEqual({ s: "done" });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("達 maxAttempts 仍未 done → 回最後一筆 + timedOut", async () => {
    const fetchFn = vi.fn(async () => ({ s: "x" }));
    const r = await pollUntil(fetchFn, () => false, { intervalMs: 0, maxAttempts: 3 });
    expect(r).toEqual({ s: "x", timedOut: true });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("fetchFn 拋錯 → 不中斷、當作未 done 續輪", async () => {
    let i = 0;
    const fetchFn = vi.fn(async () => {
      if (i++ === 0) throw new Error("net");
      return { s: "done" };
    });
    const r = await pollUntil(fetchFn, (x) => x.s === "done", { intervalMs: 0, maxAttempts: 3 });
    expect(r).toEqual({ s: "done" });
  });

  it("全部拋錯 → timedOut 且 last 為 null", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("net"); });
    const r = await pollUntil(fetchFn, () => true, { intervalMs: 0, maxAttempts: 2 });
    expect(r).toEqual({ timedOut: true });
  });
});
