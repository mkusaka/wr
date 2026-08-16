export function matchesQuery(values: unknown[], query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = values.flat().filter(Boolean).join(" ").toLowerCase();
  return terms.every((term) => text.includes(term));
}
