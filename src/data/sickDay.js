// Sick-day (身體不適日) helpers. Pure module (no Vue / Firebase / Gemini imports).
// The record lives on the day document as `day.sick = { symptoms: string[], note: string, time: 'HH:MM' }`,
// so it syncs (and respects tombstones / updatedAt) together with the rest of the day.
// Every value is sanitized on read because day records can come from Firestore or an imported backup.

export const SICK_SYMPTOMS = [
  { key: 'vomiting', label: '嘔吐', en: 'vomiting' },
  { key: 'diarrhea', label: '腹瀉', en: 'diarrhea' },
  { key: 'fever', label: '發燒', en: 'fever' },
  { key: 'poor_intake', label: '吃不下', en: 'unable to eat / very poor food intake' },
  { key: 'alcohol', label: '大量飲酒', en: 'heavy alcohol intake' },
  { key: 'other', label: '其他', en: 'other (see note)' },
]

const SYMPTOM_KEYS = new Set(SICK_SYMPTOMS.map((s) => s.key))
/** Symptoms that make the SGLT-2 ketone risk high (red) rather than elevated (yellow). */
const HIGH_RISK = new Set(['vomiting', 'diarrhea', 'poor_intake', 'alcohol'])
export const SICK_NOTE_MAX = 200

function cleanNote(v) {
  if (typeof v !== 'string') return ''
  // Strip control characters; keep it short (it is shown in the UI / report and sent to the AI prompt).
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SICK_NOTE_MAX)
}

/** Normalize a stored sick-day record; returns null when there is nothing valid. */
export function sanitizeSick(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const list = Array.isArray(raw.symptoms) ? raw.symptoms : []
  const symptoms = []
  for (const s of list) {
    if (typeof s === 'string' && SYMPTOM_KEYS.has(s) && !symptoms.includes(s)) symptoms.push(s)
  }
  const note = cleanNote(raw.note)
  if (!symptoms.length && !note) return null
  if (!symptoms.length) symptoms.push('other') // note only
  const time = typeof raw.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.time) ? raw.time : ''
  return { symptoms, note, time }
}

export function sickLabels(sick) {
  const s = sanitizeSick(sick)
  if (!s) return []
  return s.symptoms.map((k) => SICK_SYMPTOMS.find((x) => x.key === k)?.label || k)
}

export function isHighRiskSick(sick) {
  const s = sanitizeSick(sick)
  return Boolean(s && s.symptoms.some((k) => HIGH_RISK.has(k)))
}

/** Compact, sanitized object for AI prompts (English symptom names + bounded user note). */
export function sickPromptContext(sick) {
  const s = sanitizeSick(sick)
  if (!s) return null
  return {
    symptoms: s.symptoms.map((k) => SICK_SYMPTOMS.find((x) => x.key === k)?.en || k),
    note: s.note,
    high_risk: s.symptoms.some((k) => HIGH_RISK.has(k)),
  }
}
