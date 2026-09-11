export type Topic = { id: string; label: string; hint: string };

export function parseTopicRow(row: { id: string; label: string; hint?: string | null }): Topic {
  return { id: row.id, label: row.label, hint: row.hint ?? "" };
}

/** Cards use an explicit topic id or name as their category. Unmatched cards stay under All. */
export function clusterForCard(card: { category?: string | null }, topics: Topic[]): string {
  const category = (card.category ?? "").trim().toLowerCase();
  return topics.find((topic) => topic.id.toLowerCase() === category || topic.label.toLowerCase() === category)?.id ?? "";
}
