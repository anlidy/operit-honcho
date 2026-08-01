export function clipText(value: unknown, maximum = 160): string {
  const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(1, maximum - 3))}...`;
}

export function compactJson(value: unknown, maximum = 140): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  try {
    const text = JSON.stringify(value);
    return text === "{}" ? "" : clipText(text, maximum);
  } catch (_error) {
    return "";
  }
}

export function displayTime(value: unknown): string {
  const text = String(value == null ? "" : value).trim();
  if (!text) return "时间未知";

  // Honcho timestamps without an explicit offset are interpreted as UTC.
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)
    ? `${text}Z`
    : text;
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) return "时间未知";

  try {
    if (typeof Intl !== "undefined" && typeof Intl.DateTimeFormat === "function") {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date(timestamp));
      const values: Record<string, string> = {};
      for (const part of parts) values[part.type] = part.value;
      if (values.year && values.month && values.day && values.hour && values.minute && values.second) {
        return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
      }
    }
  } catch (_error) {
    // QuickJS builds without time-zone data use the deterministic UTC+8 fallback.
  }

  const shifted = new Date(timestamp + 8 * 60 * 60 * 1000);
  const number = (input: number): string => String(input).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${number(shifted.getUTCMonth() + 1)}-${number(shifted.getUTCDate())} `
    + `${number(shifted.getUTCHours())}:${number(shifted.getUTCMinutes())}:${number(shifted.getUTCSeconds())}`;
}

export function pageLabel(page: number, pages: number, total: number): string {
  const safePage = Math.max(1, Number(page) || 1);
  const safePages = Math.max(0, Number(pages) || 0);
  const safeTotal = Math.max(0, Number(total) || 0);
  return `${safePage} / ${Math.max(1, safePages)}  ·  ${safeTotal}`;
}