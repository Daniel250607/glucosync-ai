// Pure-water timeline. `day.hydration_cc` stays the effective-water total (pure water + drinks that count
// as water); `day.water_logs` records WHEN pure water was logged: [{ id, time: 'HH:MM', cc }].
// Days logged before this feature have a total but no logs; that part shows as an untimed earlier amount.
import { isClockTime } from './mealTime.js'

const num = (v) => Math.max(0, Number(v) || 0)

function newId() {
  return `wtr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Valid water logs (positive cc), ordered by time. */
export function waterLogs(day) {
  const list = Array.isArray(day?.water_logs) ? day.water_logs : []
  return list
    .filter((w) => w && num(w.cc) > 0)
    .map((w) => ({ id: String(w.id || ''), time: isClockTime(w.time) ? w.time : '', cc: Math.round(num(w.cc)) }))
    .sort((a, b) => a.time.localeCompare(b.time))
}

/** Pure water = effective total minus drinks that count as water. */
export function pureWaterCc(day) {
  const drinkWater = (day?.drinks || []).reduce((s, d) => s + (d?.counts_as_water ? num(d.volume_cc) : 0), 0)
  return Math.max(0, num(day?.hydration_cc) - drinkWater)
}

/** Pure water without a logged time (recorded before water_logs existed). */
export function untimedWaterCc(day) {
  const logged = waterLogs(day).reduce((s, w) => s + w.cc, 0)
  return Math.max(0, pureWaterCc(day) - logged)
}

/**
 * Add (cc > 0) or remove (cc < 0) pure water on the mutable `day`.
 * Adding appends a log at `time`. Removing takes the amount from the most recent logs first, then from
 * the untimed amount; the total never goes below 0.
 * @returns {{ applied:number, added?:{id:string,time:string,cc:number}, removed?:{id:string,time:string,cc:number}[] }}
 */
export function changeWater(day, cc, time) {
  const amount = Math.round(Number(cc) || 0)
  const before = num(day.hydration_cc)
  if (!amount) return { applied: 0 }
  if (amount > 0) {
    const added = { id: newId(), time: isClockTime(time) ? time : '', cc: amount }
    day.water_logs = [...(Array.isArray(day.water_logs) ? day.water_logs : []), added]
    day.hydration_cc = before + amount
    return { applied: amount, added }
  }
  let left = Math.min(-amount, before)
  const applied = -left
  const logs = waterLogs(day)
  const removed = []
  for (let i = logs.length - 1; i >= 0 && left > 0; i--) {
    const take = Math.min(left, logs[i].cc)
    logs[i].cc -= take
    left -= take
    removed.push({ id: logs[i].id, time: logs[i].time, cc: take })
  }
  day.water_logs = logs.filter((w) => w.cc > 0)
  day.hydration_cc = before + applied
  return { applied, removed }
}

/** Undo a changeWater() result on the mutable `day`. */
export function undoWaterChange(day, result) {
  if (!result?.applied) return
  if (result.added) {
    removeWaterLog(day, result.added.id)
    return
  }
  const logs = Array.isArray(day.water_logs) ? [...day.water_logs] : []
  for (const r of result.removed || []) {
    const hit = logs.find((w) => w.id === r.id)
    if (hit) hit.cc = num(hit.cc) + r.cc
    else logs.push({ ...r })
  }
  day.water_logs = logs
  day.hydration_cc = num(day.hydration_cc) - result.applied
}

/** Delete one water log and subtract its amount from the total. */
export function removeWaterLog(day, id) {
  const list = Array.isArray(day.water_logs) ? day.water_logs : []
  const hit = list.find((w) => w && w.id === id)
  if (!hit) return
  day.water_logs = list.filter((w) => w !== hit)
  day.hydration_cc = Math.max(0, num(day.hydration_cc) - num(hit.cc))
}

/** Latest HH:MM of pure water or a drink that counts as water; '' when none has a time. */
export function lastWaterTime(day) {
  const times = [
    ...waterLogs(day).map((w) => w.time),
    ...(day?.drinks || []).filter((d) => d?.counts_as_water && num(d.volume_cc) > 0).map((d) => d.time),
  ].filter(isClockTime)
  return times.length ? times.sort().at(-1) : ''
}

/** Minutes from HH:MM `from` to HH:MM `to` on the same day; null if invalid or negative. */
export function minutesBetween(from, to) {
  if (!isClockTime(from) || !isClockTime(to)) return null
  const m = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))
  const diff = m(to) - m(from)
  return diff >= 0 ? diff : null
}
