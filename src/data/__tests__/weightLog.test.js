import { afterEach, describe, expect, it } from 'vitest'
import { applyCustomConfig, bmiOf, getCustomConfig, live, recordWeight, sanitizeWeight, weightEntries, weightRangeFromHeight } from '../presets.js'

afterEach(() => applyCustomConfig({}))

describe('standard weight range from height', () => {
  it('uses BMI 18.5-24 with ideal BMI 22', () => {
    expect(weightRangeFromHeight(170)).toEqual({ min: 53.5, max: 69.4, ideal: 63.6 })
  })

  it('is null when height is not set or implausible', () => {
    expect(weightRangeFromHeight(0)).toBeNull()
    expect(weightRangeFromHeight('')).toBeNull()
    expect(weightRangeFromHeight(50)).toBeNull()
    expect(weightRangeFromHeight(300)).toBeNull()
  })

  it('computes BMI only with valid weight and height', () => {
    expect(bmiOf(72, 170)).toBe(24.9)
    expect(bmiOf(72, 0)).toBeNull()
    expect(bmiOf(5, 170)).toBeNull()
  })
})

describe('weight log', () => {
  it('sanitizes stored entries (bad dates / out-of-range values dropped)', () => {
    applyCustomConfig({ weightLog: { '2026-11-01': '72.34', '2026-11-05': 500, bad: 70, '2026-11-03': true } })
    expect(live.weightLog).toEqual({ '2026-11-01': 72.3 })
    expect(sanitizeWeight('abc')).toBeNull()
  })

  it('latest entry by date drives userWeight and the hydration band', () => {
    applyCustomConfig({ targets: { userWeight: 70 }, weightLog: { '2026-11-08': 80, '2026-10-01': 90 } })
    expect(live.targets.userWeight).toBe(80)
    expect(live.targets.hydrationMin).toBe(2400)
    expect(weightEntries().map((e) => e.date)).toEqual(['2026-10-01', '2026-11-08'])
  })

  it('without entries the stored setting is used', () => {
    applyCustomConfig({ targets: { userWeight: 65 } })
    expect(live.targets.userWeight).toBe(65)
  })

  it('recordWeight adds, overwrites and removes one date; rejects invalid values', () => {
    expect(recordWeight('2026-11-09', '71.5')).toBe(true)
    expect(recordWeight('2026-11-09', 71)).toBe(true)
    expect(recordWeight('2026-11-02', 73)).toBe(true)
    expect(getCustomConfig().weightLog).toEqual({ '2026-11-09': 71, '2026-11-02': 73 })
    expect(live.targets.userWeight).toBe(71)
    // An older date never replaces the latest weight.
    expect(recordWeight('2026-10-01', 90)).toBe(true)
    expect(live.targets.userWeight).toBe(71)
    expect(recordWeight('2026-11-09', '')).toBe(true)
    expect(live.targets.userWeight).toBe(73)
    expect(recordWeight('2026-11-09', 5)).toBe(false)
    expect(recordWeight('not-a-date', 70)).toBe(false)
  })
})
