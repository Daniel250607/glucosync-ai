import { describe, expect, it } from 'vitest'
import { computeRuleTargets, estimateEnergy, ruleTargetLines } from '../targetRules.js'

const row = (key, latest, extra = {}) => ({ key, latest, latestDate: '2026-11-01', ...extra })

describe('estimateEnergy', () => {
  it('uses the current weight x 25 kcal without a height', () => {
    expect(estimateEnergy(70, 0).kcal).toBe(1750)
  })
  it('uses ideal weight x 30 kcal for a normal BMI', () => {
    // 170 cm -> ideal 63.6 kg; 65 kg -> BMI 22.5
    expect(estimateEnergy(65, 170).kcal).toBe(1910)
  })
  it('uses ideal weight x 25 kcal when BMI >= 24', () => {
    // 170 cm, 80 kg -> BMI 27.7
    expect(estimateEnergy(80, 170).kcal).toBe(1590)
  })
})

describe('computeRuleTargets', () => {
  it('uses the fixed carbohydrate range', () => {
    const r = computeRuleTargets({ snapshot: [], weight: 70, height: 0 })
    expect(r.targets.carbsMin).toBe(130)
    expect(r.targets.carbsMax).toBe(180)
  })
  it('treats missing LDL-C as not met (6% / 7% of energy)', () => {
    const r = computeRuleTargets({ snapshot: [], weight: 70, height: 0 }) // 1750 kcal
    expect(r.targets.satFatMin).toBe(12)
    expect(r.targets.satFatMax).toBe(14)
    expect(r.reasons.find((x) => x.key === 'satFat').text).toContain('尚無 LDL-C')
  })
  it('uses 6% / 7% while LDL-C is above target and 7% / 10% once met', () => {
    const notMet = computeRuleTargets({ snapshot: [row('ldl', 130)], weight: 65, height: 170 }) // 1910 kcal
    expect(notMet.targets).toMatchObject({ satFatMin: 13, satFatMax: 15 })
    const met = computeRuleTargets({ snapshot: [row('ldl', 95)], weight: 65, height: 170 })
    expect(met.targets).toMatchObject({ satFatMin: 15, satFatMax: 21 })
  })
  it('adds reminders for positive ketones, high TG, high UAcr and high urine specific gravity', () => {
    const r = computeRuleTargets({
      snapshot: [row('u_ketones', '++', { status: 'positive' }), row('tg', 160), row('uacr', 31), row('u_sg', 1.035)],
      weight: 70,
      height: 0,
    })
    expect(r.notices).toHaveLength(4)
  })
  it('adds no reminders when values are fine', () => {
    const r = computeRuleTargets({
      snapshot: [row('u_ketones', '-', { status: 'negative' }), row('tg', 120), row('uacr', 10), row('u_sg', 1.02)],
      weight: 70,
      height: 0,
    })
    expect(r.notices).toEqual([])
  })
  it('gives the same result for the same input', () => {
    const input = { snapshot: [row('ldl', 130)], weight: 70, height: 172 }
    expect(computeRuleTargets(input)).toEqual(computeRuleTargets(input))
  })
  it('prompt lines carry the numbers and forbid other proposals', () => {
    const lines = ruleTargetLines(computeRuleTargets({ snapshot: [], weight: 70, height: 0 }))
    expect(lines[0]).toContain('130-180 g')
    expect(lines[0]).toContain('must NOT propose')
  })
})
