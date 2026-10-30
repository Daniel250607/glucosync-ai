import { describe, expect, it } from 'vitest'
import { parseBaselineLabs, parseMedications } from '../healthContextImport.js'

// Synthetic sample (not real patient data).
const SAMPLE = `# Health Context (Baseline) — Lab Date: 100/01/02 (2030-01-02)

## Glycemic
- AC Sugar: 111 mg/dL
- HbA1c: 5.5 %

## Lipids
- TG: 90 mg/dL
- LDL-C: 70 mg/dL

## Renal & Urine
- U-Sugar: +
- U-Ketones: -
- U-Specific Gravity: 1.010
- UAcr: 12.5
- Unknown Field: 99

## Medications
- DrugA (GenericA) 500 mg BID
- DrugB (GenericB) 10 mg QD  (note)
- DrugC 5mg QN

## Follow-up Targets
- HbA1c < 7.0 %
`

describe('parseBaselineLabs', () => {
  it('reads date, numeric and qualitative values, ignoring unknown labels and targets', () => {
    const { date, values } = parseBaselineLabs(SAMPLE)
    expect(date).toBe('2030-01-02')
    expect(values).toEqual({
      ac_sugar: 111, hba1c: 5.5, tg: 90, ldl: 70,
      u_sugar: '+', u_ketones: '-', u_sg: 1.01, uacr: 12.5,
    })
  })
  it('handles empty input and CRLF', () => {
    expect(parseBaselineLabs('')).toEqual({ date: '', values: {} })
    expect(parseBaselineLabs(SAMPLE.replace(/\n/g, '\r\n')).values.hba1c).toBe(5.5)
  })
  it('rejects invalid qualitative values', () => {
    expect(parseBaselineLabs('## Renal\n- U-Sugar: lots').values).toEqual({})
  })
})

describe('parseMedications', () => {
  it('parses name, dosage and timing', () => {
    expect(parseMedications(SAMPLE)).toEqual([
      { name: 'DrugA (GenericA)', dosage: '500mg', timing: 'both' },
      { name: 'DrugB (GenericB)', dosage: '10mg', timing: 'morning' },
      { name: 'DrugC', dosage: '5mg', timing: 'evening' },
    ])
  })
  it('returns [] when there is no section', () => {
    expect(parseMedications('# nothing')).toEqual([])
  })
})
