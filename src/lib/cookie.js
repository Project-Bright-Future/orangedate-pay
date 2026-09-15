export function parseCookie(cookieString, name) {
  const parts = String(cookieString || "").split(";");
  for (const p of parts) {
    const [k, ...rest] = p.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function serializeCookie(name, value, { maxAgeSec, path = "/" } = {}) {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAgeSec}; Path=${path}; SameSite=Lax; Secure`;
}
