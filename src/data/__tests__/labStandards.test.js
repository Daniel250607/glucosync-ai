import { afterEach, describe, expect, it } from 'vitest'
import { applyCustomConfig, LAB_FIELDS, labMeets, labName, resolveLabStandard, sanitizeCustomConfig } from '../presets.js'
import { latestLabSnapshot } from '../labContext.js'

const field = (key) => LAB_FIELDS.find((f) => f.key === key)

afterEach(() => applyCustomConfig({}))

describe('lab standards', () => {
  it('every numeric lab field has a standard', () => {
    for (const f of LAB_FIELDS) expect(f.targetLabel).not.toBe('—')
  })

  it('judges lt, gt and range standards', () => {
    expect(labMeets(field('t_cho'), 199)).toBe(true)
    expect(labMeets(field('t_cho'), 200)).toBe(false)
    expect(labMeets(field('egfr'), 90)).toBe(true)
    expect(labMeets(field('egfr'), 80)).toBe(false)
    expect(labMeets(field('bun'), 13)).toBe(true)
    expect(labMeets(field('bun'), 25)).toBe(false)
    expect(labMeets(field('bun'), '')).toBe(null)
  })

  it('does not judge sex-specific standards until the sex is set', () => {
    const hdl = field('hdl')
    expect(hdl.needsSex).toBe(true)
    expect(hdl.targetLabel).toBe('≥ 40（男）/ ≥ 50（女）')
    expect(labMeets(hdl, 45)).toBe(null)

    applyCustomConfig({ targets: { userSex: 1 } })
    expect(hdl.targetLabel).toBe('≥ 40')
    expect(labMeets(hdl, 45)).toBe(true)

    applyCustomConfig({ targets: { userSex: 2 } })
    expect(labMeets(hdl, 45)).toBe(false)
  })

  it('a field without a standard has no label', () => {
    expect(resolveLabStandard({}, 1).label).toBe('—')
  })

  it('uses the female uric acid and creatinine standards', () => {
    applyCustomConfig({ targets: { userSex: 2 } })
    expect(field('uric_acid').targetLabel).toBe('< 6.0')
    expect(labMeets(field('creatinine'), 1.2)).toBe(false)
  })

  it('only accepts 0, 1 or 2 as the sex setting', () => {
    expect(sanitizeCustomConfig({ targets: { userSex: 5 } }).targets).toBeUndefined()
    expect(sanitizeCustomConfig({ targets: { userSex: 2 } }).targets).toEqual({ userSex: 2 })
  })

  it('snapshot status covers gt and range standards', () => {
    const labs = [{ date: '2026-12-01', egfr: 80, bun: 25, hdl: 45 }]
    const rows = latestLabSnapshot(labs)
    expect(rows.find((r) => r.key === 'egfr').status).toBe('below target (not met)')
    expect(rows.find((r) => r.key === 'bun').status).toBe('out of range (7-20)')
    expect(rows.find((r) => r.key === 'hdl').status).toBe('no target (sex not set)')
  })

  it('display name has the medical and everyday Chinese names', () => {
    expect(labName(field('s_gpt'))).toBe('S-GPT 丙胺酸轉胺酶（肝功能指數）')
    expect(labName(field('t_cho'))).toBe('T-Cho 總膽固醇')
  })
})
