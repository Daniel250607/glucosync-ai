// Pure helpers for drag-to-reorder lists.

/** Copy of `list` with the item at `from` moved to index `to`; unchanged copy when an index is out of range. */
export function moveItem(list, from, to) {
  const out = Array.isArray(list) ? [...list] : []
  if (from === to || from < 0 || to < 0 || from >= out.length || to >= out.length) return out
  const [item] = out.splice(from, 1)
  out.splice(to, 0, item)
  return out
}

/** True when both arrays hold the same items in the same order. */
export function sameOrder(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i])
}
