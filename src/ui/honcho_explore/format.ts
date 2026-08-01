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
  return text.replace("T", " ").replace(/\.\d+(?=Z|[+-]\d\d:\d\d$)/, "");
}

export function pageLabel(page: number, pages: number, total: number): string {
  const safePage = Math.max(1, Number(page) || 1);
  const safePages = Math.max(0, Number(pages) || 0);
  const safeTotal = Math.max(0, Number(total) || 0);
  return `${safePage} / ${Math.max(1, safePages)}  ·  ${safeTotal}`;
}