// Clinic-visit report (回診報告) model + shared per-day "was this metric logged?" flags.
// Pure computation over App state; rendering (print view / PNG) lives in ClinicReport.vue.
// All values that come from day / lab records are normalized here (numbers via Number(), labs via
// latestLabSnapshot / sanitize helpers, sick-day records via sanitizeSick), and the view renders them
// only through Vue text interpolation or canvas fillText (never as HTML).
import { live } from './presets.js'
import { latestLabSnapshot } from './labContext.js'
import { sanitizeSick, sickLabels } from './sickDay.js'
import { summarizeDay } from '../services/gemini.js'

export const REPORT_RANGES = [14, 30, 90]

/**
 * summarizeDay + "was this metric actually logged?" flags. A missing value is NOT a zero:
 * - macro: only days with >= 1 AI-analyzed meal
 * - water: hydration_cc > 0 or any drink logged
 * - exercise: any exercise log or legacy exercise_min > 0
 * Shared by TrendChart (charts / scorecards) and the clinic report so both count days the same way.
 */
export function dayFlags(raw) {
  const day = raw || {}
  const s = summarizeDay(day)
  const mealsAnalyzed = (day.meals || []).filter((m) => m && m.analysis).length
  const hasWater = s.hydration_cc > 0 || (day.drinks || []).some((d) => d && d.name)
  const hasExerciseLog = (day.exercise_logs || []).length > 0 || Number(day.exercise_min) > 0
  return { ...s, meals_analyzed: mealsAnalyzed, has_water: hasWater, has_exercise: hasExerciseLog, raw: day }
}

/** Compliance over days where the metric was logged (`has`); no-data days count as neither pass nor fail. */
export function compliance(rows, test, has) {
  const logged = rows.filter(has)
  const total = logged.length
  if (!total) return { pct: null, hit: 0, total: 0 }
  const hit = logged.filter(test).length
  return { pct: Math.round((hit / total) * 100), hit, total }
}

/** Compliance definitions (same rules as the TrendChart scorecards). */
export function complianceDefs(t = live.targets) {
  return [
    { id: 'carbs', label: '碳水安全', hint: `${t.carbsMin}–${t.carbsMax} g`, has: (d) => d.meals_analyzed > 0, test: (d) => d.carbs_g >= t.carbsMin && d.carbs_g <= t.carbsMax },
    { id: 'sat', label: '飽和脂肪', hint: `≤ ${t.satFatMax} g`, has: (d) => d.meals_analyzed > 0, test: (d) => d.saturated_fat_g <= t.satFatMax },
    { id: 'water', label: '飲水', hint: `≥ ${t.hydrationMin} cc`, has: (d) => d.has_water, test: (d) => d.hydration_cc >= t.hydrationMin },
    { id: 'ex', label: '運動', hint: `≥ ${t.exerciseTarget} 分`, has: (d) => d.has_exercise, test: (d) => d.exercise_min >= t.exerciseTarget },
  ]
}

function localKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Inclusive list of local YYYY-MM-DD keys for the last `n` days ending at `end` (a Date). */
export function windowKeys(n, end = new Date()) {
  const out = []
  const base = new Date(end.getFullYear(), end.getMonth(), end.getDate())
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base)
    d.setDate(base.getDate() - i)
    out.push(localKey(d))
  }
  return out
}

const round1 = (v) => Math.round(v * 10) / 10

function avgOver(rows, key, digits = 1) {
  if (!rows.length) return { value: null, days: 0 }
  const sum = rows.reduce((acc, d) => acc + (Number(d[key]) || 0), 0)
  const v = sum / rows.length
  return { value: digits ? round1(v) : Math.round(v), days: rows.length }
}

function hasAnyRecord(day) {
  if (!day || typeof day !== 'object' || day.deleted) return false
  const meds = day.meds && typeof day.meds === 'object' ? Object.values(day.meds) : []
  const medTicked = meds.some((slot) => slot && typeof slot === 'object' && Object.values(slot).some((v) => v === true))
  return Boolean(
    (day.meals || []).length ||
      Number(day.hydration_cc) > 0 ||
      (day.drinks || []).length ||
      (day.exercise_logs || []).length ||
      Number(day.exercise_min) > 0 ||
      medTicked ||
      sanitizeSick(day.sick),
  )
}

const SLOTS = { morning: '早', evening: '晚' }
function slotsFor(m) {
  return m.timing === 'both' ? ['morning', 'evening'] : m.timing === 'evening' ? ['evening'] : ['morning']
}

/**
 * Medication adherence over "tracked" days (days where at least one medication box was ticked).
 * Days without any tick are treated as "not tracked" rather than "all doses missed".
 */
export function medAdherence(dayRecords, meds = live.medications) {
  const tracked = dayRecords.filter((d) => {
    const all = d.meds && typeof d.meds === 'object' ? Object.values(d.meds) : []
    return all.some((slot) => slot && typeof slot === 'object' && Object.values(slot).some((v) => v === true))
  })
  let taken = 0
  let expected = 0
  const rows = (Array.isArray(meds) ? meds : []).map((m) => {
    const slots = slotsFor(m)
    let t = 0
    for (const d of tracked) for (const s of slots) if (d.meds?.[s]?.[m.id] === true) t++
    const e = tracked.length * slots.length
    taken += t
    expected += e
    return {
      id: String(m.id),
      label: m.dosage ? `${m.name} ${m.dosage}` : String(m.name || m.id),
      slots: slots.map((s) => SLOTS[s]).join('+'),
      taken: t,
      expected: e,
      pct: e ? Math.round((t / e) * 100) : null,
    }
  })
  return { trackedDays: tracked.length, rows, taken, expected, pct: expected ? Math.round((taken / expected) * 100) : null }
}

const STATUS_ZH = {
  'target met': '已達標',
  'near target (not met)': '接近目標',
  'above target (not met)': '未達標',
  'no target': '—',
  'in range': '範圍內',
  negative: '陰性',
  trace: '微量',
  positive: '陽性',
}
const TREND_ZH = {
  improved: '改善',
  worsened: '變差',
  unchanged: '持平',
  higher: '上升',
  lower: '下降',
  'no follow-up yet': '尚無追蹤',
}
export function labStatusZh(s) {
  if (typeof s === 'string' && s.startsWith('out of range')) return '超出範圍'
  return STATUS_ZH[s] || '—'
}
export function labTrendZh(s) {
  return TREND_ZH[s] || '—'
}

/**
 * Build the report model for the last `rangeDays` days (inclusive of today).
 * @param {{days:object, labs:object[], rangeDays:number, now?:Date}} opts
 */
export function buildReport({ days, labs, rangeDays = 30, now = new Date() }) {
  const n = REPORT_RANGES.includes(Number(rangeDays)) ? Number(rangeDays) : 30
  const keys = windowKeys(n, now)
  const map = days && typeof days === 'object' ? days : {}
  // Only days inside the window that hold at least one real entry (tombstoned / empty days are skipped).
  const records = keys.filter((k) => Object.prototype.hasOwnProperty.call(map, k) && hasAnyRecord(map[k])).map((k) => ({ ...map[k], date: k }))
  const flagged = records.map((d) => dayFlags(d))
  const t = { ...live.targets }

  const complianceRows = complianceDefs(t).map((def) => ({ id: def.id, label: def.label, hint: def.hint, ...compliance(flagged, def.test, def.has) }))

  const macroDays = flagged.filter((d) => d.meals_analyzed > 0)
  const waterDays = flagged.filter((d) => d.has_water)
  const exDays = flagged.filter((d) => d.has_exercise)
  const averages = [
    { id: 'carbs', label: '碳水化合物', unit: 'g/日', ...avgOver(macroDays, 'carbs_g'), basis: '有已分析餐點的天數' },
    { id: 'sat', label: '飽和脂肪', unit: 'g/日', ...avgOver(macroDays, 'saturated_fat_g'), basis: '有已分析餐點的天數' },
    { id: 'sodium', label: '鈉', unit: 'mg/日', ...avgOver(macroDays, 'sodium_mg', 0), basis: '有已分析餐點的天數' },
    { id: 'kcal', label: '熱量', unit: 'kcal/日', ...avgOver(macroDays, 'kcal', 0), basis: '有已分析餐點的天數' },
    { id: 'water', label: '飲水', unit: 'cc/日', ...avgOver(waterDays, 'hydration_cc', 0), basis: '有飲水紀錄的天數' },
    { id: 'ex', label: '運動', unit: '分/日', ...avgOver(exDays, 'exercise_min'), basis: '有運動紀錄的天數' },
  ]

  const sickEntries = records
    .map((d) => ({ date: String(d.date || ''), sick: sanitizeSick(d.sick) }))
    .filter((r) => r.sick && /^\d{4}-\d{2}-\d{2}$/.test(r.date))
    .map((r) => ({ date: r.date, time: r.sick.time, symptoms: sickLabels(r.sick).join('、'), note: r.sick.note }))

  const labRows = latestLabSnapshot(labs).map((r) => ({
    key: r.key,
    label: r.label,
    unit: r.unit,
    baseline: r.baseline,
    baselineDate: r.baselineDate,
    latest: r.source === 'follow-up' ? r.latest : null,
    latestDate: r.source === 'follow-up' ? r.latestDate : null,
    target: r.targetLabel || '—',
    // Without a follow-up the status describes the baseline value; label it so it is not read as current.
    status: r.source === 'follow-up' || labStatusZh(r.status) === '—' ? labStatusZh(r.status) : `${labStatusZh(r.status)}（基準）`,
    trend: labTrendZh(r.trend),
    delta: r.kind === 'numeric' && r.source === 'follow-up' ? r.delta : null,
  }))

  return {
    rangeDays: n,
    start: keys[0],
    end: keys[keys.length - 1],
    generatedAt: now,
    recordDays: records.length,
    targets: t,
    compliance: complianceRows,
    averages,
    labRows,
    sickEntries,
    meds: medAdherence(records),
  }
}
