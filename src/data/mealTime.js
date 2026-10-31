// Pure helpers for meal times. A meal's `time` is the time it was EATEN (HH:MM), which the user can set
// when logging late; it defaults to the moment of logging. Legacy meals always carry the logging time.

const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export function isClockTime(v) {
  return typeof v === 'string' && CLOCK_RE.test(v)
}

/** Meals ordered by eaten time (stable: same time keeps logging order; meals without a valid time keep their place). */
export function sortMealsByTime(meals) {
  const list = Array.isArray(meals) ? meals : []
  const valid = list.filter((m) => isClockTime(m?.time))
  if (valid.length < 2) return [...list]
  const sorted = [...valid].sort((a, b) => a.time.localeCompare(b.time))
  let i = 0
  // Put the sorted valid meals back into the valid slots; invalid-time meals stay where they were.
  return list.map((m) => (isClockTime(m?.time) ? sorted[i++] : m))
}

/** True when `m` was eaten before (or at) `beforeTime`; meals/targets without a valid time always count. */
export function eatenBefore(m, beforeTime) {
  if (!isClockTime(beforeTime) || !isClockTime(m?.time)) return true
  return m.time <= beforeTime
}
