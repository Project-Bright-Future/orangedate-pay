import { describe, it, expect, vi } from "vitest";
import { createApi } from "../src/lib/api.js";

function fakeFetch(status, body, headers = {}) {
  return vi.fn(async () => ({
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => {
      if (body === undefined) throw new Error("no json");
      return body;
    },
  }));
}

describe("createApi", () => {
  it("組 base + path、預設 JSON header、回 httpStatus/body", async () => {
    const f = fakeFetch(200, { ok: 1 });
    const api = createApi("https://x/api/pbf-kol", f);
    const r = await api("/promo/A/", { method: "GET" });
    expect(f).toHaveBeenCalledWith("https://x/api/pbf-kol/promo/A/", expect.objectContaining({
      method: "GET",
      headers: { "Content-Type": "application/json" },
    }));
    expect(r.httpStatus).toBe(200);
    expect(r.body).toEqual({ ok: 1 });
  });

  it("body 非 JSON → body 為 {}", async () => {
    const api = createApi("https://x", fakeFetch(500, undefined));
    const r = await api("/p/");
    expect(r.body).toEqual({});
  });

  it("可讀 response header（Retry-After）", async () => {
    const api = createApi("https://x", fakeFetch(429, { code: "otp_rate_limited" }, { "retry-after": "3600" }));
    const r = await api("/otp/create/", { method: "POST", body: "{}" });
    expect(r.header("Retry-After")).toBe("3600");
    expect(r.header("X-None")).toBeNull();
  });
});
