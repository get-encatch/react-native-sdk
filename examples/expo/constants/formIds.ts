/** Parse comma-separated form IDs from env (deduped, order preserved). */
export function parseFormIds(raw: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Resolves the active form id from env list + manual/selected fallback state. */
export function resolveSelectedFormId(
  formIds: readonly string[],
  selectedValue: string
): string {
  if (formIds.length === 0) return selectedValue.trim();
  if (formIds.length === 1) return formIds[0];
  const trimmed = selectedValue.trim();
  return formIds.includes(trimmed) ? trimmed : formIds[0];
}
