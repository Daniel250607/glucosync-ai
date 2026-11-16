import { describe, expect, it } from 'vitest'
import {
  grokRequestBody,
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
