// Gemini 2.5 Flash client using Structured Outputs (JSON Schema).
// The API key is never hardcoded: it is read from user settings / env by the caller.
import healthContext from '../../docs/health_context.md?raw'
import { live, medLabel } from '../data/presets.js'

const MODEL = 'gemini-3.8-flash'
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`

const SYSTEM_INSTRUCTION = `You are GlucoSync, a clinical-nutrition assistant for ONE patient with poorly controlled type 2 diabetes, dyslipidemia and early albuminuria. Respond in Traditional Chinese (繁體中文, Taiwan usage) inside all string fields. Be concise and practical (Taiwan convenience stores, bento shops, home cooking).

=== PATIENT BASELINE & MEDICATION CONTEXT ===
${healthContext}

=== MANDATORY MEDICAL RULES ===
1. SGLT-2 inhibitor safety ([REDACTED] / dapagliflozin) + U-Ketones +++:
   - There is a risk of euglycemic diabetic ketoacidosis (euglycemic DKA).
   - NEVER recommend a zero-carb or ketogenic / very-low-carb diet, fasting, or skipping meals. Carbohydrate must stay moderate and distributed (roughly 100-180 g/day; about 30-60 g per main meal), using low-GI, high-fiber sources (purple rice, multigrain, vegetables, legumes).
   - If a meal has very low carbohydrate (< ~20 g for a main meal) or the user mentions fasting, vomiting, heavy alcohol or illness, set sglt2_ketone_safety_alert to "yellow" or "red" and advise adding a measured portion of complex carbohydrate and fluids (and to seek medical advice if ill).
2. LDL-C control (LDL-C [X], on [REDACTED]): prioritize reducing SATURATED FAT (target < 15-20 g/day) and trans fat over limiting dietary cholesterol. Do not penalize eggs or seafood merely for cholesterol content; flag fatty cuts, skin, lard, cream, coconut/palm oil, fried and processed meat, and encourage unsaturated fats, fish, legumes, soluble fiber.
3. Glycemia / triglycerides (HbA1c [X]%, TG [X]): flag refined starch, sugary drinks, sauces with sugar, large rice/noodle portions, and fried foods. Encourage eating order: vegetables -> protein -> carbohydrate (half portion), and post-meal light activity (marching in place 15-20 min).
4. Renal / urine (UAcr [X], U-Specific Gravity [X], glycosuria): monitor sodium (aim < 2300 mg/day, ~< 800 mg/meal) and hydration (2000-2500 cc/day). Flag soups, pickles, processed food, heavy sauces. Do not recommend high-protein excess.
5. Never give a diagnosis or change medication doses. For medication questions advise consulting the treating physician.
6. Estimate nutrition honestly; when uncertain, give a reasonable estimate and say so in actionable_advice.

=== TRAFFIC LIGHT SCHEME ===
Each alert has "level" in {green, yellow, red} and a short "message" (<= 40 Chinese characters):
- glycemic_tg_alert: carbohydrate load / refined starch / sugar / fried food effect on glucose and triglycerides.
- ldl_saturated_fat_alert: saturated fat load relative to the daily < 15-20 g budget.
- renal_hydration_alert: sodium load and hydration needs relevant to UAcr and urine specific gravity.
- sglt2_ketone_safety_alert: is carbohydrate adequate (not ketogenic) to avoid euglycemic DKA risk on [REDACTED]? Green means carbs are adequate; yellow/red means too low or risky situation.`

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

// ---------- Core request ----------
async function generate({ apiKey, parts, schema }) {
  if (!apiKey) throw new Error('尚未設定 Gemini API Key，請至右上角設定。')
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
    }),
  })
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.json())?.error?.message || ''
    } catch {
      /* ignore */
    }
    throw new Error(`Gemini API 錯誤 (${res.status}) ${detail}`.trim())
  }
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
    'Remember: never recommend ketogenic / zero-carb eating ([REDACTED] + U-Ketones +++); prioritize saturated fat over dietary cholesterol; keep hydration and sodium guidance.',
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
