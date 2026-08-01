import { Conclusion } from "../api";
import { sha256 } from "../hash";
import { normalizeMessageContent } from "../message";
import { ConclusionDuplicateGroupDto } from "./types";

export function normalizeConclusionContent(value: string): string {
  return normalizeMessageContent(value).replace(/\s+/g, " " ).trim();
}

export function conclusionDuplicateKey(value: Conclusion): string {
  return sha256(JSON.stringify([
    String(value.observer_id || ""),
    String(value.observed_id || ""),
    String(value.session_id || ""),
    normalizeConclusionContent(value.content),
  ]));
}

function createdAt(value: Conclusion): number {
  const parsed = Date.parse(String(value.created_at || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildConclusionDuplicateGroups(
  conclusions: Conclusion[]
): ConclusionDuplicateGroupDto[] {
  const grouped = new Map<string, Conclusion[]>();
  for (const conclusion of conclusions) {
    if (!conclusion.id || !normalizeConclusionContent(conclusion.content)) continue;
    const key = conclusionDuplicateKey(conclusion);
    const items = grouped.get(key) || [];
    items.push(conclusion);
    grouped.set(key, items);
  }

  const result: ConclusionDuplicateGroupDto[] = [];
  for (const [groupKey, values] of grouped.entries()) {
    if (values.length < 2) continue;
    values.sort((left, right) => createdAt(left) - createdAt(right) || left.id.localeCompare(right.id));
    const first = values[0];
    const last = values[values.length - 1];
    result.push({
      group_key: groupKey,
      content: normalizeConclusionContent(first.content),
      observer_id: String(first.observer_id || ""),
      observed_id: String(first.observed_id || ""),
      session_id: first.session_id,
      items: values.map((item) => ({
        id: item.id,
        created_at: item.created_at,
        level: item.level,
      })),
      earliest_id: first.id,
      latest_id: last.id,
    });
  }
  return result.sort((left, right) => right.items.length - left.items.length
    || left.group_key.localeCompare(right.group_key));
}