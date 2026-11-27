import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GROK_MODEL,
  grokRequestBody,
  modelOverride,
  grokTimeoutMs,
  normalizeProvider,
  requestTimeoutMs,
  targetSafetyWarnings,
  toJsonSchema,
} from '../../services/gemini.js'

describe('Grok provider helpers', () => {
  const schema = {
    type: 'OBJECT',
    properties: {
      name: { type: 'STRING' },
      level: { type: 'STRING', enum: ['green', 'red'] },
      items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { n: { type: 'NUMBER' } }, required: ['n'] } },
    },
    required: ['name'],
  }

  it('converts the Gemini schema to strict JSON Schema', () => {
    expect(toJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        level: { type: 'string', enum: ['green', 'red'] },
        items: {
          type: 'array',
          items: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false },
        },
      },
      required: ['name', 'level', 'items'],
      additionalProperties: false,
    })
  })

  it('builds a chat request with system text, user text and images', () => {
    const body = grokRequestBody({
      model: 'grok-x',
      system: 'SYS',
      parts: [{ text: 'meal' }, { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }],
      schema,
    })
    expect(body.model).toBe('grok-x')
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: 'meal' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
    ])
    expect(body.response_format.type).toBe('json_schema')
    expect(body.response_format.json_schema.schema.type).toBe('object')
  })

  it('timeouts and provider normalization', () => {
    expect(grokTimeoutMs('grok-4.20-0309-non-reasoning')).toBe(30000)
    expect(grokTimeoutMs('grok-4.20-0309-reasoning')).toBe(90000)
    expect(normalizeProvider('grok')).toBe('grok')
    expect(normalizeProvider(undefined)).toBe('gemini')
    expect(normalizeProvider('other')).toBe('gemini')
  })
})

describe('modelOverride', () => {
  it('stores blank (= follow the app default) for empty input or the current default', () => {
    expect(modelOverride('', DEFAULT_GROK_MODEL)).toBe('')
    expect(modelOverride(undefined, DEFAULT_GROK_MODEL)).toBe('')
    expect(modelOverride(null, DEFAULT_GEMINI_MODEL)).toBe('')
    expect(modelOverride(`  ${DEFAULT_GROK_MODEL} `, DEFAULT_GROK_MODEL)).toBe('')
    expect(modelOverride(DEFAULT_GEMINI_MODEL, DEFAULT_GEMINI_MODEL)).toBe('')
  })

  it('keeps a model the user picked on purpose', () => {
    expect(modelOverride(' grok-4.7 ', DEFAULT_GROK_MODEL)).toBe('grok-4.7')
    expect(modelOverride('gemini-other', DEFAULT_GEMINI_MODEL)).toBe('gemini-other')
  })
})

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
  const rule = { targets: { satFatMax: 15 } }
  it('is empty inside the guideline rules', () => {
    expect(targetSafetyWarnings({ carbsMin: 130, carbsMax: 180, satFatMax: 15 }, rule)).toEqual([])
  })
  it('warns on low carbs, high carbs and saturated fat above the rule result', () => {
    const w = targetSafetyWarnings({ carbsMin: 100, carbsMax: 200, satFatMax: 20 }, rule)
    expect(w).toHaveLength(3)
    expect(w[0]).toContain('130 g')
    expect(w[2]).toContain('15 g')
  })
  it('skips the saturated-fat check without a rule result', () => {
    expect(targetSafetyWarnings({ carbsMin: 130, carbsMax: 180, satFatMax: 30 })).toEqual([])
  })
  it('ignores empty fields (validation reports those)', () => {
    expect(targetSafetyWarnings({ carbsMin: '', carbsMax: null })).toEqual([])
  })
})
