// 共用 fetch 包裝：base + path、預設 JSON header、回 { httpStatus, body, header(name) }。
// body 解析失敗回 {}；header() 供讀 Retry-After 等。fetchImpl 可注入（測試用）。
export function createApi(base, fetchImpl) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  return async function api(path, options) {
    const res = await doFetch(`${base}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    let body = {};
    try { body = await res.json(); } catch (_) {}
    return {
      httpStatus: res.status,
      body,
      header: (name) => (res.headers && res.headers.get ? res.headers.get(name) : null),
    };
  };
}
