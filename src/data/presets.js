// Default meal presets, modifier tags, exercise types, drink presets, medications and daily targets.
// User customizations (stored under `glucosync.customConfig`) override these at runtime
// through the reactive `live` store at the bottom of this file.
import { reactive } from 'vue'

export const TARGETS = {
  // Body weight (kg) drives the hydration band. 70 kg → 2100–2660 cc.
  userWeight: 70,
  hydrationMin: 2100,
  hydrationMax: 2660,
  // Post-dinner marching-in-place target duration (min).
  exerciseTarget: 20,
  // Saturated fat warning / strict limit (g/day) for LDL-C control.
  satFatMin: 15,
  satFatMax: 20,
  // Carb safety bounds (g/day): lower bound avoids ketogenic-like intake while on
  // an SGLT-2 inhibitor; upper bound limits post-meal glucose load.
  carbsMin: 100,
  carbsMax: 180,
}

export const PRESETS = [
  {
    id: 'weekday-breakfast',
    category: '平日',
    label: '平日早餐',
    description:
      '7-11 無糖豆漿 + 無糖優格 + 沙拉(醬汁減半) + 茶葉蛋/溫泉蛋',
  },
  {
    id: 'weekday-lunch',
    category: '平日',
    label: '平日午餐',
    description:
      '7-11 健康餐盒：2/3 份紫米/多穀飯 + 烤雞/鯖魚/牛肉/雞胸肉 + 關東煮蔬菜',
  },
  {
    id: 'miss-energy',
    category: '外食',
    label: '能量小姐',
    description: '能量小姐 (Miss Energy) 健康餐盒，主食減量，蔬菜與蛋白質優先',
  },
  {
    id: 'liang-she-han',
    category: '外食',
    label: '梁社漢/蔡家排骨',
    description:
      '梁社漢/蔡家排骨：滷雞腿/油雞/滷豬排擇一，飯吃一半，搭配蔬菜',
  },
  {
    id: 'chicken-homestead',
    category: '外食',
    label: '雞肉本家',
    description: '雞肉本家：醬汁清淡、飯吃一半、燙青菜 + 豆腐',
  },
  {
    id: 'popiah',
    category: '外食',
    label: '素食潤餅',
    description:
      '素食潤餅：不加花生糖粉、不加酥脆餅皮屑 + 無糖豆漿 + 蛋',
  },
  {
    id: 'stir-fried-pasta',
    category: '外食',
    label: '炒義大利麵',
    description: '炒義大利麵 (麵量減少)',
  },
  {
    id: 'braised-dishes',
    category: '外食',
    label: '滷味 (熱/冷)',
    description:
      '熱滷/冷滷味：原型蔬菜、瘦肉、豆製品/豆腐，不加酸菜、不加麻油',
  },
  {
    id: 'mini-hotpot',
    category: '外食',
    label: '小火鍋',
    description:
      '小火鍋 (12MINI / 麗媽涮涮鍋)：原味湯底，雞胸肉/海鮮，不喝湯',
  },
  {
    id: 'home-steamer',
    category: '在家',
    label: '電蒸鍋餐',
    description:
      '家用電蒸鍋餐：雞腿肉/蝦 + 小白菜/花椰菜/竹筍 + 嫩豆腐 + 番茄 + 蛋；調味為 10-15ml 無添加醬油、1 茶匙蒜泥、七味粉、五香粉、鹽',
  },
  {
    id: 'weekend-brunch',
    category: '假日',
    label: '假日早午餐',
    description:
      '麥味登嫩雞沙拉 + 無糖綠茶 + 蛋；或傳統早餐店蔬菜蛋餅(里肌/雙蛋) + 沙拉',
  },
]

export const TAGS = [
  '[飯吃 1/2]',
  '[飯吃 2/3]',
  '[醬汁減半]',
  '[不喝湯]',
  '[去皮]',
  '[先菜肉後飯]',
  '[餐後踏步 20分]',
]

export const EXERCISE_TYPES = [
  '餐後踏步',
  '抬腳跟',
  '戶外散步',
  '慢跑/路跑',
  '健身房跑步機',
  '重訓/肌力',
  '騎車',
]

export const DRINK_PRESETS = [
  { id: 'drk-green-tea', name: '無糖綠茶/烏龍茶', default_cc: 500, counts_as_water: true },
  { id: 'drk-black-coffee', name: '美式黑咖啡', default_cc: 350, counts_as_water: true },
  { id: 'drk-sparkling', name: '無糖氣泡水', default_cc: 500, counts_as_water: true },
  { id: 'drk-soy-milk', name: '無糖豆漿', default_cc: 400, counts_as_water: false },
  { id: 'drk-almond-milk', name: '無糖杏仁飲', default_cc: 300, counts_as_water: false },
]

// Medications are PERSONAL health data: the default list is empty and the user enters their own in
// Settings (stored in the custom config). timing: 'morning' | 'evening' | 'both'. `id` is the key used
// in day.meds[slot][id]; see medIdFromName for how ids are derived so logged data stays valid.
export const MEDICATIONS = []

/** Stable id from a drug name: its first latin word, lowercased ("[REDACTED] ([REDACTED])" -> "eutomin"). '' if none. */
export function medIdFromName(name) {
  const first = String(name || '').trim().split(/[\s(（]/)[0]
  return first.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Lab field definitions and follow-up targets. Baseline values are PERSONAL health data: they are
// never shipped in the code but entered by the user (section `labBaseline` of the custom config),
// and exposed through the reactive `baseline` getters below (null until entered).
// `dir` = "lt" means lower is better (value must be below `target`);
const LAB_FIELD_DEFS = [
  { key: 'hba1c', label: 'HbA1c', unit: '%', target: 7.5, targetLabel: '< 7.0-7.5', dir: 'lt' },
  { key: 'ac_sugar', label: 'AC Sugar', unit: 'mg/dL', target: 130, targetLabel: '< 110-130', dir: 'lt' },
  { key: 'ldl', label: 'LDL-C', unit: 'mg/dL', target: 100, targetLabel: '< 100', dir: 'lt' },
  { key: 'tg', label: 'TG', unit: 'mg/dL', target: 150, targetLabel: '< 150', dir: 'lt' },
  { key: 't_cho', label: 'T-Cho', unit: 'mg/dL', target: null, targetLabel: '—', dir: null },
  { key: 'hdl', label: 'HDL-C', unit: 'mg/dL', target: null, targetLabel: '—', dir: null },
  { key: 'uacr', label: 'UAcr', unit: '', target: 30, targetLabel: '< 30', dir: 'lt' },
  { key: 'micro_albumin', label: 'Micro-Albumin', unit: 'mg/L', target: null, targetLabel: '—', dir: null },
  { key: 'creatinine', label: 'Creatinine', unit: 'mg/dL', target: null, targetLabel: '—', dir: null },
  { key: 'egfr', label: 'eGFR', unit: '', target: null, targetLabel: '—', dir: null },
  { key: 'bun', label: 'BUN', unit: 'mg/dL', target: null, targetLabel: '—', dir: null },
  { key: 'uric_acid', label: 'Uric Acid', unit: 'mg/dL', target: null, targetLabel: '—', dir: null },
  { key: 's_gpt', label: 'S-GPT', unit: 'U/L', target: null, targetLabel: '—', dir: null },
  { key: 'u_sg', label: 'U-Specific Gravity', unit: '', target: null, targetLabel: '1.005-1.030', dir: null },
]

// Qualitative urine definitions (baseline entered by the user, not numeric).
const URINE_DEFS = [
  { key: 'u_sugar', label: 'U-Sugar' },
  { key: 'u_ketones', label: 'U-Ketones' },
]

const withBaseline = (def) =>
  Object.defineProperty({ ...def }, 'baseline', {
    enumerable: true,
    get: () => live.labBaseline.values[def.key] ?? null,
  })

export const LAB_FIELDS = LAB_FIELD_DEFS.map(withBaseline)
export const URINE_QUALITATIVE = URINE_DEFS.map(withBaseline)

/** Baseline lab date (YYYY-MM-DD), '' until the user enters a baseline. Reactive when read in a render/computed. */
export function getBaselineDate() {
  return live.labBaseline.date || ''
}

// =====================================================================
// User customization (glucosync.customConfig)
// `customConfig` holds ONLY the sections the user changed; anything missing
// falls back to the defaults above. `live` is the effective, reactive config
// that all components read from.
// =====================================================================
const clone = (o) => JSON.parse(JSON.stringify(o))
const SECTIONS = ['presets', 'tags', 'exerciseTypes', 'drinkPresets', 'medications', 'targets', 'labBaseline']
const TIMINGS = ['morning', 'evening', 'both']

export const customConfig = reactive({})
export const live = reactive({
  presets: clone(PRESETS),
  tags: clone(TAGS),
  exerciseTypes: clone(EXERCISE_TYPES),
  drinkPresets: clone(DRINK_PRESETS),
  medications: clone(MEDICATIONS),
  targets: { ...TARGETS },
  labBaseline: { date: '', values: {} },
})

let changeListener = null
/** Register a callback fired after the user edits (not after applyCustomConfig). */
export function onCustomConfigChange(fn) {
  changeListener = fn
}

/**
 * Weight-based hydration band. Lower bound never drops below 2000 cc (SGLT-2).
 * Upper bound is weight × 38 cc, and always at least 400 cc above the minimum.
 */
export function hydrationRangeFromWeight(weightKg) {
  const w = Number(weightKg)
  const weight = Number.isFinite(w) && w > 0 ? w : 70
  const hydrationMin = Math.max(2000, Math.round(weight * 30))
  const hydrationMax = Math.max(hydrationMin + 400, Math.round(weight * 38))
  return { userWeight: weight, hydrationMin, hydrationMax }
}

function recompute() {
  live.presets = clone(customConfig.presets ?? PRESETS)
  live.tags = clone(customConfig.tags ?? TAGS)
  live.exerciseTypes = clone(customConfig.exerciseTypes ?? EXERCISE_TYPES)
  live.drinkPresets = clone(customConfig.drinkPresets ?? DRINK_PRESETS)
  live.medications = clone(customConfig.medications ?? MEDICATIONS)
  const merged = { ...TARGETS, ...(customConfig.targets ?? {}) }
  live.targets = { ...merged, ...hydrationRangeFromWeight(merged.userWeight) }
  live.labBaseline = clone(customConfig.labBaseline ?? { date: '', values: {} })
}

/** Validate untrusted config (from storage / import); returns only valid sections. */
export function sanitizeCustomConfig(cfg) {
  const out = {}
  if (!cfg || typeof cfg !== 'object') return out
  if (Array.isArray(cfg.presets)) {
    out.presets = cfg.presets
      .filter((p) => p && typeof p.label === 'string' && p.label.trim())
      .map((p, i) => ({
        id: String(p.id || `custom-${Date.now()}-${i}`),
        category: String(p.category || '自訂').trim() || '自訂',
        label: p.label.trim(),
        description: String(p.description || ''),
      }))
  }
  if (Array.isArray(cfg.tags)) {
    out.tags = [...new Set(cfg.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()))]
  }
  if (Array.isArray(cfg.exerciseTypes)) {
    out.exerciseTypes = [
      ...new Set(cfg.exerciseTypes.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())),
    ]
  }
  if (Array.isArray(cfg.drinkPresets)) {
    out.drinkPresets = cfg.drinkPresets
      .filter((d) => d && typeof d.name === 'string' && d.name.trim())
      .map((d, i) => ({
        id: String(d.id || `drk-${Date.now()}-${i}`),
        name: d.name.trim(),
        default_cc: Math.max(0, Number(d.default_cc) || 0),
        counts_as_water: Boolean(d.counts_as_water),
      }))
  }
  if (Array.isArray(cfg.medications)) {
    out.medications = cfg.medications
      .filter((m) => m && typeof m.name === 'string' && m.name.trim())
      .map((m, i) => ({
        id: String(m.id || `med-${Date.now()}-${i}`),
        name: m.name.trim(),
        dosage: String(m.dosage || '').trim(),
        timing: TIMINGS.includes(m.timing) ? m.timing : 'morning',
      }))
  }
  if (cfg.targets && typeof cfg.targets === 'object') {
    const t = {}
    for (const k of Object.keys(TARGETS)) {
      const v = Number(cfg.targets[k])
      if (cfg.targets[k] !== '' && cfg.targets[k] != null && Number.isFinite(v) && v >= 0) t[k] = v
    }
    if (Object.keys(t).length) out.targets = t
  }
  if (cfg.labBaseline && typeof cfg.labBaseline === 'object') {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(cfg.labBaseline.date) ? cfg.labBaseline.date : ''
    const values = {}
    const src = cfg.labBaseline.values && typeof cfg.labBaseline.values === 'object' ? cfg.labBaseline.values : {}
    for (const f of LAB_FIELD_DEFS) {
      const v = src[f.key]
      if (v === '' || v == null || typeof v === 'boolean') continue
      const n = Number(v)
      if (Number.isFinite(n) && n >= 0 && n < 100000) values[f.key] = n
    }
    for (const q of URINE_DEFS) {
      if (typeof src[q.key] === 'string' && /^(-|±|\+{1,4})$/.test(src[q.key])) values[q.key] = src[q.key]
    }
    out.labBaseline = { date, values }
  }
  return out
}

/** Replace all overrides (used on load / import). Does not trigger the change listener. */
export function applyCustomConfig(cfg) {
  for (const k of Object.keys(customConfig)) delete customConfig[k]
  Object.assign(customConfig, sanitizeCustomConfig(cfg))
  recompute()
}

/** Current overrides as a plain object (safe to JSON-serialize). */
export function getCustomConfig() {
  return clone(customConfig)
}

/** Override one section ('presets' | 'tags' | 'exerciseTypes' | 'drinkPresets' | 'medications' | 'targets' | 'labBaseline'). */
export function updateCustom(section, value) {
  if (!SECTIONS.includes(section)) return
  const clean = sanitizeCustomConfig({ [section]: value })[section]
  if (clean === undefined) return
  customConfig[section] = clean
  recompute()
  if (changeListener) changeListener()
}

/** Restore defaults for the given sections (all sections when omitted). */
export function resetCustom(sections = SECTIONS) {
  for (const s of [].concat(sections)) delete customConfig[s]
  recompute()
  if (changeListener) changeListener()
}

/** Medications that should be taken in a slot ('morning' | 'evening'). */
export function medsForSlot(slot) {
  return live.medications.filter((m) => m.timing === 'both' || m.timing === slot)
}

export function medLabel(m) {
  return m.dosage ? `${m.name} ${m.dosage}` : m.name
}