// Pure parsers for the personal `health_context.md` file the user keeps on their own machine.
// The file is read in the browser (file picker) and never uploaded or committed; these helpers only
// turn its text into the structures the app stores in its custom config / settings.

/** Label in the markdown file -> lab field key used by presets.js (numeric and urine qualitative). */
const LABEL_TO_KEY = {
  'ac sugar': 'ac_sugar',
  hba1c: 'hba1c',
  tg: 'tg',
  't-cho': 't_cho',
  'ldl-c': 'ldl',
  'hdl-c': 'hdl',
  'u-sugar': 'u_sugar',
  'u-ketones': 'u_ketones',
  'u-specific gravity': 'u_sg',
  'micro-albumin': 'micro_albumin',
  uacr: 'uacr',
  creatinine: 'creatinine',
  egfr: 'egfr',
  bun: 'bun',
  'uric acid': 'uric_acid',
  's-gpt': 's_gpt',
}
const QUALITATIVE = new Set(['u_sugar', 'u_ketones'])

/** Text of the `## <name>` section (case-insensitive), without the heading line. '' when missing. */
function section(text, name) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let inside = false
  for (const line of lines) {
    const h = line.match(/^##\s+(.*)$/)
    if (h) {
      inside = h[1].trim().toLowerCase().startsWith(name.toLowerCase())
      continue
    }
    if (inside) out.push(line)
  }
  return out.join('\n')
}

/**
 * Baseline labs from the "Glycemic" / "Lipids" / "Renal & Urine" sections plus the lab date from the title.
 * @returns {{ date: string, values: Record<string, number|string> }}
 */
export function parseBaselineLabs(text) {
  const src = String(text || '')
  const date = (src.match(/\b(\d{4}-\d{2}-\d{2})\b/) || [])[1] || ''
  const body = ['Glycemic', 'Lipids', 'Renal'].map((n) => section(src, n)).join('\n')
  const values = {}
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*[-*]\s*([^:]+?)\s*:\s*(\S+)/)
    if (!m) continue
    const key = LABEL_TO_KEY[m[1].trim().toLowerCase()]
    if (!key || key in values) continue
    if (QUALITATIVE.has(key)) {
      if (/^(-|±|\+{1,4})$/.test(m[2])) values[key] = m[2]
    } else {
      const n = Number(m[2])
      if (Number.isFinite(n)) values[key] = n
    }
  }
  return { date, values }
}

const TIMING_BY_FREQUENCY = { BID: 'both', TID: 'both', QD: 'morning', QAM: 'morning', QN: 'evening', HS: 'evening', QPM: 'evening' }

/**
 * Medications from the "Medications" section: `- Name (Generic) 850 mg BID`.
 * QD is taken as morning (editable afterwards); BID/TID as morning + evening; QN/HS as evening.
 * @returns {{ name: string, dosage: string, timing: 'morning'|'evening'|'both' }[]}
 */
export function parseMedications(text) {
  const out = []
  for (const line of section(text, 'Medications').split('\n')) {
    const m = line.match(/^\s*[-*]\s*(.+?)\s+(\d+(?:\.\d+)?)\s*(mg|mcg|g|ug)\b\s*([A-Za-z]+)?/i)
    if (!m) continue
    out.push({
      name: m[1].trim(),
      dosage: `${m[2]}${m[3].toLowerCase()}`,
      timing: TIMING_BY_FREQUENCY[(m[4] || '').toUpperCase()] || 'morning',
    })
  }
  return out
}
