// Gemini client using Structured Outputs (JSON Schema).
// The API key and model ID are never hardcoded: they are read from user settings / env.
import healthContext from '../../docs/health_context.md?raw'
import { live, medLabel } from '../data/presets.js'
import { loadSettings } from '../firebase.js'

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash'
export const GEMINI_MODEL_OPTIONS = ['gemini-3.8-flash']
export const DEFAULT_THINKING_BUDGET = 0
export const THINKING_LEVEL_OPTIONS = [
  { label: '極速 / 關閉', budget: 0, hint: '建議用於即時餐點紀錄，約 1–2 秒' },
  { label: '低思考', budget: 1024, hint: '約 3–5 秒' },
  { label: '中思考', budget: 4096, hint: '約 6–10 秒' },
  { label: '高思考', budget: 8192, hint: '詳細檢驗解讀' },
]

export function getGeminiModel() {
  return (loadSettings().geminiModel || '').trim() || DEFAULT_GEMINI_MODEL
}

/** thinkingBudget 0 explicitly disables extended reasoning tokens. */
export function normalizeThinkingBudget(value) {
  const n = parseInt(value ?? DEFAULT_THINKING_BUDGET, 10)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_THINKING_BUDGET
}

export function getThinkingBudget() {
  return normalizeThinkingBudget(loadSettings().thinkingBudget)
}

function geminiEndpoint(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
}

const SYSTEM_INSTRUCTION = `You are GlucoSync, a clinical-nutrition assistant for ONE patient with poorly controlled type 2 diabetes, dyslipidemia and early albuminuria. Respond in Traditional Chinese (繁體中文, Taiwan usage) inside all string fields. Be concise and practical (Taiwan convenience stores, bento shops, home cooking).

=== PATIENT BASELINE & MEDICATION CONTEXT ===
${healthContext}

=== MANDATORY MEDICAL RULES ===
1. SGLT-2 inhibitor safety (Forxiga / dapagliflozin) + U-Ketones +++:
   - There is a risk of euglycemic diabetic ketoacidosis (euglycemic DKA).
   - NEVER recommend a zero-carb or ketogenic / very-low-carb diet, fasting, or skipping meals. Carbohydrate must stay moderate and distributed (roughly 100-180 g/day; about 30-60 g per main meal), using low-GI, high-fiber sources (purple rice, multigrain, vegetables, legumes).
   - If a meal has very low carbohydrate (< ~20 g for a main meal) or the user mentions fasting, vomiting, heavy alcohol or illness, set sglt2_ketone_safety_alert to "yellow" or "red" and advise adding a measured portion of complex carbohydrate and fluids (and to seek medical advice if ill).
2. LDL-C control (LDL-C 158, on Rosuvastatin): prioritize reducing SATURATED FAT (target < 15-20 g/day) and trans fat over limiting dietary cholesterol. Do not penalize eggs or seafood merely for cholesterol content; flag fatty cuts, skin, lard, cream, coconut/palm oil, fried and processed meat, and encourage unsaturated fats, fish, legumes, soluble fiber.
3. Glycemia / triglycerides (HbA1c 11.7%, TG 203): flag refined starch, sugary drinks, sauces with sugar, large rice/noodle portions, and fried foods. Encourage eating order: vegetables -> protein -> carbohydrate (half portion), and post-meal light activity (marching in place 15-20 min).
4. Renal / urine (UAcr 32.46, U-Specific Gravity 1.037, glycosuria): monitor sodium (aim < 2300 mg/day, ~< 800 mg/meal) and hydration (2000-2500 cc/day). Flag soups, pickles, processed food, heavy sauces. Do not recommend high-protein excess.
5. Never give a diagnosis or change medication doses. For medication questions advise consulting the treating physician.
6. Estimate nutrition honestly; when uncertain, give a reasonable estimate and say so in actionable_advice.
7. Keep actionable_advice to at most 60 words (about 2 short Traditional Chinese sentences). No long paragraphs.

=== TRAFFIC LIGHT SCHEME ===
Each alert has "level" in {green, yellow, red} and a short "message" (<= 40 Chinese characters):
- glycemic_tg_alert: carbohydrate load / refined starch / sugar / fried food effect on glucose and triglycerides.
- ldl_saturated_fat_alert: saturated fat load relative to the daily < 15-20 g budget.
- renal_hydration_alert: sodium load and hydration needs relevant to UAcr and urine specific gravity.
- sglt2_ketone_safety_alert: is carbohydrate adequate (not ketogenic) to avoid euglycemic DKA risk on Forxiga? Green means carbs are adequate; yellow/red means too low or risky situation.`

// ---------- Schemas ----------
const alertSchema = {
  type: 'OBJECT',
  properties: {
    level: { type: 'STRING', enum: ['green', 'yellow', 'red'] },
    message: { type: 'STRING' },
  },
  required: ['level', 'message'],
}

const mealSchema = {
  type: 'OBJECT',
  properties: {
    meal_name: { type: 'STRING' },
    estimated_calories_kcal: { type: 'NUMBER' },
    macronutrients: {
      type: 'OBJECT',
      properties: {
        protein_g: { type: 'NUMBER' },
        carbs_g: { type: 'NUMBER' },
        fat_g: { type: 'NUMBER' },
        saturated_fat_g: { type: 'NUMBER' },
        dietary_fiber_g: { type: 'NUMBER' },
        sodium_mg: { type: 'NUMBER' },
      },
      required: ['protein_g', 'carbs_g', 'fat_g', 'saturated_fat_g', 'dietary_fiber_g', 'sodium_mg'],
    },
    glycemic_tg_alert: alertSchema,
    ldl_saturated_fat_alert: alertSchema,
    renal_hydration_alert: alertSchema,
    sglt2_ketone_safety_alert: alertSchema,
    actionable_advice: { type: 'STRING' },
  },
  required: [
    'meal_name',
    'estimated_calories_kcal',
    'macronutrients',
    'glycemic_tg_alert',
    'ldl_saturated_fat_alert',
    'renal_hydration_alert',
    'sglt2_ketone_safety_alert',
    'actionable_advice',
  ],
}

const labEvalSchema = {
  type: 'OBJECT',
  properties: {
    phase_name: { type: 'STRING' },
    overall_assessment: { type: 'STRING' },
    metric_progress: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          metric: { type: 'STRING' },
          status: { type: 'STRING', enum: ['green', 'yellow', 'red'] },
          comment: { type: 'STRING' },
        },
        required: ['metric', 'status', 'comment'],
      },
    },
    dietary_adjustments: { type: 'ARRAY', items: { type: 'STRING' } },
    carb_guidance: { type: 'STRING' },
    saturated_fat_guidance: { type: 'STRING' },
    hydration_sodium_guidance: { type: 'STRING' },
    safety_flags: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: [
    'phase_name',
    'overall_assessment',
    'metric_progress',
    'dietary_adjustments',
    'carb_guidance',
    'saturated_fat_guidance',
    'hydration_sodium_guidance',
    'safety_flags',
  ],
}

// ---------- HTTP helpers (retry + readable errors) ----------
const RETRY_WAITS_MS = [1500, 3000] // up to 2 retries for 503 / 429
const HTTP_HINT = {
  429: '請求過於頻繁，請稍後再試',
  500: 'Google 伺服器內部錯誤，請稍後再試',
  503: 'Google 伺服器負載過高，請稍後再試',
  401: 'API Key 無效或已過期，請至設定檢查',
  403: 'API Key 無權限或配額不足，請至設定檢查',
  404: '找不到此模型，請至設定更換模型名稱',
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function parseErrorBody(res) {
  try {
    const j = await res.json()
    return j?.error?.message || ''
  } catch {
    try {
      return (await res.text()).slice(0, 200)
    } catch {
      return ''
    }
  }
}

function formatHttpError(status, detail) {
  const hint = HTTP_HINT[status] || 'Gemini API 呼叫失敗'
  return detail ? `[HTTP ${status}] ${hint} — ${detail}` : `[HTTP ${status}] ${hint}`
}

/** fetch with exponential backoff on 503 / 429 (and network failures). */
async function fetchWithRetry(url, init) {
  let lastErr
  for (let attempt = 0; attempt <= RETRY_WAITS_MS.length; attempt++) {
    let res
    try {
      res = await fetch(url, init)
    } catch {
      lastErr = new Error('網路連線失敗，請檢查網路後再試。')
      if (attempt < RETRY_WAITS_MS.length) {
        await sleep(RETRY_WAITS_MS[attempt])
        continue
      }
      throw lastErr
    }
    if (res.ok) return res
    const detail = await parseErrorBody(res)
    lastErr = new Error(formatHttpError(res.status, detail))
    if ((res.status === 503 || res.status === 429) && attempt < RETRY_WAITS_MS.length) {
      await sleep(RETRY_WAITS_MS[attempt])
      continue
    }
    throw lastErr
  }
  throw lastErr
}

// ---------- Core request ----------
async function generate({ apiKey, parts, schema }) {
  if (!apiKey) throw new Error('尚未設定 Gemini API Key，請至右上角設定。')
  const model = getGeminiModel()
  const res = await fetchWithRetry(geminiEndpoint(model), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: schema,
        thinkingConfig: {
          thinkingBudget: getThinkingBudget(),
        },
      },
    }),
  })
  const data = await res.json()
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('')
  if (!text) throw new Error('Gemini 未回傳內容 (可能被安全機制攔截)。')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('無法解析 Gemini 回傳的 JSON。')
  }
}

// ---------- User-configured targets / medications ----------
/** Current daily targets and medication list as configured in the UI (may differ from baseline). */
function userConfigLines() {
  const t = live.targets
  const meds = live.medications
    .map((m) => `${medLabel(m)} (${m.timing === 'both' ? 'morning+evening' : m.timing})`)
    .join('; ')
  return [
    `User-configured daily targets: carbohydrate ${t.carbsMin}-${t.carbsMax} g (never go ketogenic), saturated fat warning ${t.satFatMin} g / limit ${t.satFatMax} g, hydration ${t.hydrationMin}-${t.hydrationMax} cc, post-dinner marching ${t.exerciseTarget} min. Use these as the daily budgets.`,
    `Current medication list configured by the user (treat as the current regimen): ${meds || 'none'}.`,
  ]
}

// ---------- Public API ----------
/**
 * Analyze a meal from free text and/or a photo.
 * @param {{apiKey:string, text?:string, tags?:string[], image?:{mimeType:string,data:string}, dayContext?:object}} opts
 */
export async function analyzeMeal({ apiKey, text = '', tags = [], image = null, dayContext = null }) {
  const lines = ['Analyze this meal and return the structured JSON.']
  if (text.trim()) lines.push(`Meal description: ${text.trim()}`)
  if (tags.length) lines.push(`Modifiers applied by the user: ${tags.join(' ')}`)
  lines.push(...userConfigLines())
  if (dayContext) {
    lines.push(
      `Intake so far today (before this meal): ${JSON.stringify(dayContext)}. Use it to judge the daily saturated-fat, sodium and carbohydrate budgets and hydration.`,
    )
  }
  if (image) lines.push('A photo of the meal is attached.')

  const parts = [{ text: lines.join('\n') }]
  if (image) parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } })
  return generate({ apiKey, parts, schema: mealSchema })
}

/**
 * Evaluate lab milestones against baseline and recent intake, and suggest a dietary phase.
 */
export async function evaluateLabs({ apiKey, labs, recentDays }) {
  const text = [
    'Evaluate the follow-up lab results against the 2026-09-05 baseline and the 11-12 month targets, then propose the next dynamic dietary phase.',
    `Logged follow-up labs (chronological): ${JSON.stringify(labs)}`,
    `Recent daily intake summaries (last 14 logged days): ${JSON.stringify(recentDays)}`,
    ...userConfigLines(),
    'Remember: never recommend ketogenic / zero-carb eating (Forxiga + U-Ketones +++); prioritize saturated fat over dietary cholesterol; keep hydration and sodium guidance.',
  ].join('\n')
  return generate({ apiKey, parts: [{ text }], schema: labEvalSchema })
}

// ---------- Helpers ----------
/** Aggregate a day's logged meals + tracker values. */
export function summarizeDay(day) {
  const s = {
    date: day.date,
    kcal: 0,
    protein_g: 0,
    carbs_g: 0,
    fat_g: 0,
    saturated_fat_g: 0,
    fiber_g: 0,
    sodium_mg: 0,
    hydration_cc: day.hydration_cc || 0,
    exercise_min: day.exercise_min || 0,
  }
  for (const m of day.meals || []) {
    const a = m.analysis
    if (!a) continue
    const n = a.macronutrients || {}
    s.kcal += a.estimated_calories_kcal || 0
    s.protein_g += n.protein_g || 0
    s.carbs_g += n.carbs_g || 0
    s.fat_g += n.fat_g || 0
    s.saturated_fat_g += n.saturated_fat_g || 0
    s.fiber_g += n.dietary_fiber_g || 0
    s.sodium_mg += n.sodium_mg || 0
  }
  for (const k of ['kcal', 'protein_g', 'carbs_g', 'fat_g', 'saturated_fat_g', 'fiber_g', 'sodium_mg']) {
    s[k] = Math.round(s[k] * 10) / 10
  }
  return s
}
