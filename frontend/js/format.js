/* Number / date formatting helpers (all times shown in US Eastern). */
window.Fmt = (() => {
  const ET = "America/New_York";
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);

  function price(v, digits) {
    if (!isNum(v)) return "—";
    const d = digits ?? (Math.abs(v) < 1 ? 4 : 2);
    return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function signed(v, digits = 2) {
    if (!isNum(v)) return "—";
    return (v > 0 ? "+" : v < 0 ? "−" : "") + price(Math.abs(v), digits);
  }
  function pct(v) {
    if (!isNum(v)) return "—";
    return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "%";
  }
  function volume(v) {
    if (!isNum(v)) return "—";
    return Math.round(v).toLocaleString("en-US");
  }
  function compact(v) {
    if (!isNum(v)) return "—";
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return String(Math.round(v));
  }
  function dirClass(v) {
    if (!isNum(v) || v === 0) return "flat";
    return v > 0 ? "up" : "down";
  }
  /** ISO timestamp -> "11/20/2026 3:59:12 PM ET" */
  function etDateTime(iso, withSeconds = true) {
    if (!iso) return "—";
    const d = new Date(iso);
    const s = d.toLocaleString("en-US", {
      timeZone: ET, month: "2-digit", day: "2-digit", year: "numeric",
      hour: "numeric", minute: "2-digit", ...(withSeconds ? { second: "2-digit" } : {}),
    });
    return s.replace(",", "") + " ET";
  }
  /**
   * Chart times are epoch seconds of New-York wall-clock time (encoded as if UTC),
   * so format them with timeZone UTC.
   */
  function barTime(t, intraday) {
    const d = new Date(t * 1000);
    const date = d.toLocaleDateString("en-US", { timeZone: "UTC", month: "2-digit", day: "2-digit", year: "numeric" });
    if (!intraday) return date;
    const time = d.toLocaleTimeString("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" });
    return `${date} ${time}`;
  }
  function barTimeISO(t, intraday) {
    const s = new Date(t * 1000).toISOString();
    return intraday ? s.slice(0, 16).replace("T", " ") : s.slice(0, 10);
  }
  return { isNum, price, signed, pct, volume, compact, dirClass, etDateTime, barTime, barTimeISO };
})();
