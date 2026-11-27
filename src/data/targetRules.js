// Guideline-based daily targets computed from the latest labs and body data.
// Every number and its source lives in RULES below: when a guideline changes, edit RULES (and the tests),
// and the targets, the explanations in the UI and the AI prompts all follow.
// AI never decides these numbers; it only explains them.
import { latestLabSnapshot } from './labContext.js'
import { bmiOf, live, weightRangeFromHeight } from './presets.js'

export const RULES = {
  /** When the rules were last checked against the guidelines (YYYY-MM). */
  reviewed: '2026-11',
  energy: {
    // Taiwan diabetes education: ideal body weight (BMI 22) x kcal per kg for light (office) work,
    // 5 kcal/kg less when overweight (BMI >= 24). Without a height, current weight x 25 kcal.
    kcalPerKg: 30,
    kcalPerKgOverweight: 25,
    overweightBmi: 24,
    fallbackKcalPerKg: 25,
    source: '台灣糖尿病衛教：理想體重 × 每公斤熱量（輕度工作 30 kcal，BMI ≥ 24 為 25 kcal）',
  },
  carbs: {
    // DRI minimum (brain glucose need); ADA Standards of Care: no low-carb eating on an SGLT-2 inhibitor.
    min: 130,
    // 4 carbohydrate exchanges (15 g each) per meal x 3 meals.
    max: 180,
    minSource: '國人膳食營養素參考攝取量的每日最低需要量；ADA 照護標準：服用 SGLT-2 抑制劑不宜低醣飲食',
    maxSource: '每餐 4 份醣類（每份 15 g）× 3 餐',
  },
  satFat: {
    // Percent of daily energy. LDL-C above target -> stricter (lipid guidelines); met -> general < 10%.
    ldlTarget: 100,
    notMet: { warnPct: 6, maxPct: 7 },
    met: { warnPct: 7, maxPct: 10 },
    source: '血脂指引：LDL-C 未達標時飽和脂肪 < 7% 熱量；一般與糖尿病指引 < 10% 熱量',
  },
  exercise: {
    // ADA Standards of Care (physical activity): >= 150 min/week of moderate-to-vigorous aerobic activity
    // over >= 3 days with no more than 2 consecutive days off; 2-3 strength sessions/week on non-consecutive
    // days; one vigorous minute counts as about two moderate minutes.
    aerobicWeekMin: 150,
    aerobicMinDays: 3,
    maxRestDays: 2,
    strengthDaysPerWeek: 2,
    // Daily post-meal activity (any intensity) blunts the post-meal glucose rise; dinner is the priority.
    postMealMin: 15,
    postMealWindowMin: 120,
    source: 'ADA 糖尿病照護標準：每週 ≥ 150 分鐘中等以上強度有氧，分散在至少 3 天、不連續 2 天以上不運動；每週 2–3 次肌力訓練（不排連續兩天）；費力 1 分鐘約等於中等 2 分鐘',
    postMealSource: '餐後活動（輕鬆也可以）能降低餐後血糖高峰，優先放在晚餐後',
  },
  // Reminder-only thresholds (the app does not track these nutrients, so no target changes).
  tgLimit: 150,
  uacrLimit: 30,
  uSgMax: 1.03,
  proteinGPerKg: 0.8,
}

const round10 = (n) => Math.round(n / 10) * 10

/** Daily energy estimate { kcal, text } from weight (kg) and height (cm; 0 / invalid = not set). */
export function estimateEnergy(weightKg, heightCm, rules = RULES) {
  const e = rules.energy
  const w = Number(weightKg) > 0 ? Number(weightKg) : 70
  const range = weightRangeFromHeight(heightCm)
  if (!range) {
    return { kcal: round10(w * e.fallbackKcalPerKg), text: `未填身高，暫以目前體重 ${w} kg × ${e.fallbackKcalPerKg} kcal 估算` }
  }
  const bmi = bmiOf(w, heightCm)
  const perKg = bmi != null && bmi >= e.overweightBmi ? e.kcalPerKgOverweight : e.kcalPerKg
  return {
    kcal: round10(range.ideal * perKg),
    text: `理想體重 ${range.ideal} kg × ${perKg} kcal${bmi != null ? `（目前 BMI ${bmi}）` : ''}`,
  }
}

/**
 * Targets from fixed rules. `snapshot` is latestLabSnapshot() output (latest value per lab field).
 * Returns { targets: { carbsMin, carbsMax, satFatMin, satFatMax }, energy, reasons: [{ key, label, text }], notices: [string] }.
 * Hydration (weight-based) and exercise (RULES.exercise, see exercise.js) are not lab-driven and stay as configured.
 */
export function computeRuleTargets({ snapshot = [], weight, height }, rules = RULES) {
  const row = (key) => snapshot.find((r) => r.key === key) || null
  const energy = estimateEnergy(weight, height, rules)
  const reasons = []
  const notices = []

  reasons.push({ key: 'energy', label: '每日熱量', text: `約 ${energy.kcal} kcal：${energy.text}。依據：${rules.energy.source}` })

  // Carbohydrate: fixed guideline numbers.
  const carbsMin = rules.carbs.min
  const carbsMax = rules.carbs.max
  reasons.push({
    key: 'carbs',
    label: '碳水',
    text: `下限 ${carbsMin} g：${rules.carbs.minSource}。上限 ${carbsMax} g：${rules.carbs.maxSource}。`,
  })

  // Saturated fat: percent of energy, stricter while LDL-C is above target.
  const ldl = row('ldl')
  const ldlMet = ldl != null && Number(ldl.latest) < rules.satFat.ldlTarget
  const pct = ldlMet ? rules.satFat.met : rules.satFat.notMet
  const grams = (p) => Math.round((energy.kcal * p) / 100 / 9)
  const satFatMax = grams(pct.maxPct)
  const satFatMin = Math.min(satFatMax, grams(pct.warnPct))
  const ldlText = ldl
    ? `LDL-C ${ldl.latest}（${ldl.latestDate}）${ldlMet ? `< ${rules.satFat.ldlTarget} 已達標` : `≥ ${rules.satFat.ldlTarget} 未達標`}`
    : '尚無 LDL-C 資料，先以未達標計算'
  reasons.push({
    key: 'satFat',
    label: '飽和脂肪',
    text: `${ldlText} → 警示 ${pct.warnPct}%、上限 ${pct.maxPct}% 熱量（${satFatMin} / ${satFatMax} g）。依據：${rules.satFat.source}`,
  })

  // Reminders only.
  const ket = row('u_ketones')
  if (ket && ket.status === 'positive') {
    notices.push(`尿酮 ${ket.latest}（${ket.latestDate}）陽性：碳水不要低於下限，也先不要提高運動強度，回診時請醫師確認。`)
  }
  const tg = row('tg')
  if (tg && Number(tg.latest) >= rules.tgLimit) {
    notices.push(`TG ${tg.latest}（${tg.latestDate}）≥ ${rules.tgLimit}：少吃添加糖、果汁、精緻澱粉，少喝酒。`)
  }
  const uacr = row('uacr')
  if (uacr && Number(uacr.latest) >= rules.uacrLimit) {
    notices.push(`UAcr ${uacr.latest}（${uacr.latestDate}）≥ ${rules.uacrLimit}：蛋白質不要過量（約每公斤 ${rules.proteinGPerKg} g），少吃鹽。`)
  }
  const sg = row('u_sg')
  if (sg && Number(sg.latest) > rules.uSgMax) {
    notices.push(`尿比重 ${sg.latest}（${sg.latestDate}）> ${rules.uSgMax}：飲水往上限喝。`)
  }

  return { targets: { carbsMin, carbsMax, satFatMin, satFatMax }, energy, reasons, notices }
}

/** computeRuleTargets for the current lab records and the live weight / height. */
export function ruleTargetsFor(labs, overrides = {}) {
  return computeRuleTargets({
    snapshot: latestLabSnapshot(labs),
    weight: overrides.weight ?? live.targets.userWeight,
    height: overrides.height ?? live.targets.userHeight,
  })
}

/** Prompt lines describing the rule-based targets (data only; the AI explains them, never changes them). */
export function ruleTargetLines(result) {
  const t = result.targets
  return [
    `Rule-based daily targets computed by the app from fixed guideline rules (the AI must NOT propose different numbers): carbohydrate ${t.carbsMin}-${t.carbsMax} g, saturated fat warning ${t.satFatMin} g / limit ${t.satFatMax} g, estimated energy ${result.energy.kcal} kcal/day.`,
    `Rule explanations shown to the user (Traditional Chinese): ${JSON.stringify(result.reasons.map((r) => `${r.label}：${r.text}`))}`,
    ...(result.notices.length ? [`Lab-based reminders shown to the user: ${JSON.stringify(result.notices)}`] : []),
  ]
}
