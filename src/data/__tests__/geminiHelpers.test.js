import { describe, expect, it } from 'vitest'
import { requestTimeoutMs, targetSafetyWarnings } from '../../services/gemini.js'

describe('requestTimeoutMs', () => {
  it('grows with the thinking budget', () => {
    expect(requestTimeoutMs(0)).toBe(15000)
    expect(requestTimeoutMs(1024)).toBe(25000)
    expect(requestTimeoutMs(4096)).toBe(40000)
    expect(requestTimeoutMs(8192)).toBe(60000)
    expect(requestTimeoutMs('junk')).toBe(15000) // invalid -> default budget 0
  })
})

describe('targetSafetyWarnings', () => {
  it('is empty inside the clinical bounds', () => {
    expect(targetSafetyWarnings({ carbsMin: 100, carbsMax: 180, satFatMax: 20 })).toEqual([])
  })
  it('warns on low carbs, high carbs and high saturated fat', () => {
    const w = targetSafetyWarnings({ carbsMin: 0, carbsMax: 200, satFatMax: 25 })
    expect(w).toHaveLength(3)
    expect(w[0]).toContain('100 g')
  })
  it('ignores empty fields (validation reports those)', () => {
    expect(targetSafetyWarnings({ carbsMin: '', carbsMax: null })).toEqual([])
  })
})
