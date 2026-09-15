const TPE_DATE = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
});

// UTC ISO → 台北日期 YYYY/MM/DD；空 / 壞值 → 空字串。
export function formatTpeDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return TPE_DATE.format(d);
}

export const formatTwd = (n) => (n == null ? "" : Number(n).toLocaleString("en-US"));

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
