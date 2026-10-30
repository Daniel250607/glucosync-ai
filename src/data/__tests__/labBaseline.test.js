import { afterEach, describe, expect, it } from 'vitest'
import { applyCustomConfig, getBaselineDate, LAB_FIELDS, MEDICATIONS, medIdFromName } from '../presets.js'
import { labContextBlock, latestLabSnapshot } from '../labContext.js'

afterEach(() => applyCustomConfig({}))

describe('lab baseline lives in custom config', () => {
  it('is empty by default and ships no values', () => {
    expect(getBaselineDate()).toBe('')
    expect(LAB_FIELDS.every((f) => f.baseline === null)).toBe(true)
    expect(latestLabSnapshot([])).toEqual([])
    expect(labContextBlock([])).toContain('Baseline date: not recorded')
  })

  it('without baseline a follow-up still yields a row, trend "no baseline"', () => {
    const rows = latestLabSnapshot([{ date: '2026-12-01', hba1c: 8 }])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 'hba1c', latest: 8, trend: 'no baseline' })
  })

  it('applies and sanitizes a configured baseline', () => {
    applyCustomConfig({
      labBaseline: { date: '2026-01-01', values: { hba1c: '9', ldl: 'x', u_ketones: '++', u_sugar: 'bogus' } },
    })
    expect(getBaselineDate()).toBe('2026-01-01')
    const rows = latestLabSnapshot([])
    expect(rows.map((r) => r.key)).toEqual(['hba1c', 'u_ketones'])
    expect(rows[0]).toMatchObject({ latest: 9, source: 'baseline' })
    expect(rows[0].baseline).toBe(9)
  })

  it('rejects a malformed baseline date', () => {
    applyCustomConfig({ labBaseline: { date: '2026/01/01', values: { hba1c: 9 } } })
    expect(getBaselineDate()).toBe('')
  })
})

describe('medications', () => {
  it('ships no default medications', () => {
    expect(MEDICATIONS).toEqual([])
  })
  it('derives ids from the first latin word of the name', () => {
    expect(medIdFromName('Name1 (Generic)')).toBe('name1')
    expect(medIdFromName('  Abc-D 10mg')).toBe('abcd')
    expect(medIdFromName('中文藥名')).toBe('')
  })
})
