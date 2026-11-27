// Exercise crediting by category and intensity, weekly totals and the ketone caution.
// Pure helpers (no Vue components / Firebase / AI calls) shared by the tracker, the trend chart, the clinic
// report and the AI prompts, so every view counts exercise the same way. Guideline numbers live in
// RULES.exercise (targetRules.js); the user's own targets in live.targets.
//
// Log fields (new logs): category ('aerobic' | 'strength' | 'light'), intensity ('light' | 'moderate' |
// 'vigorous', aerobic only), post_meal (boolean), actual_min. Old logs have none of these: they stored
// walking-equivalent minutes in duration_min and are counted as "unrated" moderate aerobic minutes, so the
// history stays continuous; the views mark them separately.
import { latestLabSnapshot } from './labContext.js'
import { INTENSITIES } from './presets.js'

const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)
const round1 = (v) => Math.round(v * 10) / 10

/** Aerobic minutes credited per actual minute for an intensity (light 0, moderate 1, vigorous 2). */
export function intensityWeight(intensity) {
  return INTENSITIES.find((i) => i.value === intensity)?.weight ?? 1
}

/** true when the log was done after a meal (new flag, or the old meal-tag / "餐後" logs). */
export function isPostMealLog(log) {
  if (!log) return false
  if (typeof log.post_meal === 'boolean') return log.post_meal
  return log.source === 'meal_tag' || /餐後|飯後/.test(String(log.type || ''))
}

/**
 * Minutes one log adds to each bucket:
 * { actual, aerobic (moderate-equivalent), light, strength, strengthDone, postMeal, unrated }.
 * Aerobic logs without an intensity (old logs, meal-tag logs) count as moderate and also go to `unrated`.
 */
export function logCredit(log) {
  const out = { actual: 0, aerobic: 0, light: 0, strength: 0, strengthDone: false, postMeal: 0, unrated: 0 }
  if (!log || typeof log !== 'object') return out
  const actual = num(log.actual_min) || num(log.duration_min)
  out.actual = actual
  if (log.category === 'strength') {
    out.strength = actual
    out.strengthDone = actual > 0
  } else if (log.category === 'light') {
    out.light = actual
  } else if (log.category === 'aerobic' && log.intensity) {
    const w = intensityWeight(log.intensity)
    if (w === 0) out.light = actual
    else out.aerobic = actual * w
  } else {
    // Old log (walking-equivalent minutes) or aerobic without an intensity: moderate, marked unrated.
    out.aerobic = log.category === 'aerobic' ? actual : num(log.duration_min)
    out.unrated = out.aerobic
  }
  if (isPostMealLog(log)) out.postMeal = actual
  return out
}

/**
 * Exercise totals for one day: { has, total, aerobic, light, strength, strengthDone, postMeal, unrated }.
 * A day with only the old single `exercise_min` number counts it as unrated aerobic minutes.
 */
export function exerciseDay(day) {
  const s = { has: false, total: 0, aerobic: 0, light: 0, strength: 0, strengthDone: false, postMeal: 0, unrated: 0 }
  if (!day || typeof day !== 'object' || day.deleted) return s
  const logs = Array.isArray(day.exercise_logs) ? day.exercise_logs.filter((x) => x && typeof x === 'object') : []
  if (!logs.length) {
    const legacy = num(day.exercise_min)
    if (legacy) Object.assign(s, { has: true, total: legacy, aerobic: legacy, unrated: legacy })
    return s
  }
  for (const log of logs) {
    const c = logCredit(log)
    s.total += c.actual
    s.aerobic += c.aerobic
    s.light += c.light
    s.strength += c.strength
    s.postMeal += c.postMeal
    s.unrated += c.unrated
    if (c.strengthDone) s.strengthDone = true
  }
  s.has = true
  for (const k of ['total', 'aerobic', 'light', 'strength', 'postMeal', 'unrated']) s[k] = round1(s[k])
  return s
}

/** YYYY-MM-DD shifted by `delta` days (local calendar; '' for an invalid key). */
export function shiftDateKey(key, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''))
  if (!m) return ''
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + delta)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The `n` date keys ending at `endKey` (inclusive), oldest first. */
export function keysEnding(endKey, n) {
  const out = []
  for (let i = n - 1; i >= 0; i--) out.push(shiftDateKey(endKey, -i))
  return out.filter(Boolean)
}

const dayAt = (days, key) => (days && Object.prototype.hasOwnProperty.call(days, key) ? days[key] : null)

/**
 * Rolling 7 days ending at `endKey`:
 * { aerobic, aerobicDays, strengthDays, light, unrated, restDays }.
 * restDays = consecutive days without aerobic minutes counted back from endKey (0 when endKey has some),
 * capped at 7. A day without any record counts as a day without exercise.
 */
export function exerciseWeek(days, endKey) {
  const keys = keysEnding(endKey, 7)
  const out = { aerobic: 0, aerobicDays: 0, strengthDays: 0, light: 0, unrated: 0, restDays: 0 }
  const perDay = keys.map((k) => exerciseDay(dayAt(days, k)))
  for (const s of perDay) {
    out.aerobic += s.aerobic
    out.light += s.light
    out.unrated += s.unrated
    if (s.aerobic > 0) out.aerobicDays++
    if (s.strengthDone) out.strengthDays++
  }
  for (let i = perDay.length - 1; i >= 0 && perDay[i].aerobic === 0; i--) out.restDays++
  out.aerobic = round1(out.aerobic)
  out.light = round1(out.light)
  out.unrated = round1(out.unrated)
  return out
}

/**
 * Quick-select types logged most often in the `windowDays` days ending at `endKey`, most first
 * (ties keep the quick-select order), at most `limit`. Only types in `types` count. When fewer than
 * `limit` were logged, the rest is filled with unused types in quick-select order, so the "常用" tab
 * is never nearly empty (e.g. right after installing).
 */
export function frequentExerciseTypes(days, endKey, types, { windowDays = 30, limit = 8 } = {}) {
  const list = Array.isArray(types) ? types : []
  const count = new Map(list.map((t) => [t, 0]))
  for (const k of keysEnding(endKey, windowDays)) {
    const day = dayAt(days, k)
    if (!day || day.deleted || !Array.isArray(day.exercise_logs)) continue
    for (const log of day.exercise_logs) {
      if (log && count.has(log.type)) count.set(log.type, count.get(log.type) + 1)
    }
  }
  const used = list
    .map((t, i) => ({ t, i, n: count.get(t) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map((x) => x.t)
  const unused = list.filter((t) => !(count.get(t) > 0))
  return [...used, ...unused].slice(0, limit)
}

/** Longest run of consecutive days without aerobic minutes inside `keys` (days without records count as rest). */
export function longestRestRun(days, keys) {
  let best = 0
  let run = 0
  for (const k of keys) {
    run = exerciseDay(dayAt(days, k)).aerobic > 0 ? 0 : run + 1
    if (run > best) best = run
  }
  return best
}

/** Minutes between two HH:MM times (b - a), or null when either is not a clock time. */
function minutesBetween(a, b) {
  const re = /^([01]\d|2[0-3]):([0-5]\d)$/
  const ma = re.exec(String(a || ''))
  const mb = re.exec(String(b || ''))
  if (!ma || !mb) return null
  return Number(mb[1]) * 60 + Number(mb[2]) - (Number(ma[1]) * 60 + Number(ma[2]))
}

/** true when a meal was eaten within `windowMin` minutes before `time` (HH:MM). */
export function isAfterMeal(meals, time, windowMin) {
  return (Array.isArray(meals) ? meals : []).some((m) => {
    const d = minutesBetween(m?.time, time)
    return d != null && d >= 0 && d <= windowMin
  })
}

/**
 * Latest urine ketone result when it is not negative ({ value, date }), else null.
 * While ketones are positive the app advises against vigorous exercise and exercising while fasting.
 */
export function ketoneCaution(labs) {
  const row = latestLabSnapshot(labs).find((r) => r.key === 'u_ketones')
  if (!row || row.status === 'negative') return null
  return { value: row.latest, date: row.latestDate }
}
