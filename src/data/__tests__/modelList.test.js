import { describe, expect, it } from 'vitest'
import {
  MODEL_LIST_MAX_AGE_MS,
  isModelListStale,
  loadModelListCache,
  modelChoices,
  parseGeminiModels,
  parseGrokModels,
} from '../../services/modelList.js'

describe('parseGeminiModels', () => {
  it('keeps gemini models that support generateContent, newest first', () => {
    const json = {
      models: [
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-10-pro', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-live-2.5-flash', supportedGenerationMethods: ['bidiGenerateContent'] },
        { name: 'models/gemma-3-27b-it', supportedGenerationMethods: ['generateContent'] },
      ],
    }
    expect(parseGeminiModels(json).map((m) => m.id)).toEqual(['gemini-10-pro', 'gemini-3.8-flash', 'gemini-2.5-flash'])
  })

  it('handles an empty or malformed response', () => {
    expect(parseGeminiModels(null)).toEqual([])
    expect(parseGeminiModels({ models: [{}] })).toEqual([])
  })
})

describe('parseGrokModels', () => {
  it('reads /v1/language-models with modalities and aliases', () => {
    const json = {
      models: [
        { id: 'grok-4.7', input_modalities: ['text', 'image'], output_modalities: ['text'], aliases: ['grok-4.7-latest'] },
        { id: 'grok-3-mini', input_modalities: ['text'], output_modalities: ['text'], aliases: [] },
        { id: 'grok-imagine-image', input_modalities: ['text'], output_modalities: ['image'] },
      ],
    }
    expect(parseGrokModels(json)).toEqual([
      { id: 'grok-4.7-latest', image: true },
      { id: 'grok-4.7', image: true },
      { id: 'grok-3-mini', image: false },
    ])
  })

  it('reads /v1/models (ids only) and drops image / video models', () => {
    const json = { data: [{ id: 'grok-4.20-0309-non-reasoning' }, { id: 'grok-2-image-1212' }, { id: 'grok-imagine-video' }] }
    expect(parseGrokModels(json)).toEqual([{ id: 'grok-4.20-0309-non-reasoning', image: null }])
  })
})

describe('modelChoices', () => {
  it('uses the built-in list when nothing was fetched', () => {
    expect(modelChoices({ fetched: null, fallback: ['a', 'b'], defaultModel: 'a', current: '' }).map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('keeps the default and the current choice even when the API no longer lists them', () => {
    const ids = modelChoices({
      fetched: [{ id: 'new-model', image: true }],
      fallback: ['old'],
      defaultModel: 'def',
      current: 'mine',
    }).map((m) => m.id)
    expect(ids).toEqual(['def', 'mine', 'new-model'])
  })
})

describe('model list cache', () => {
  it('is stale when missing or older than a day', () => {
    const now = 10 * MODEL_LIST_MAX_AGE_MS
    expect(isModelListStale(null, now)).toBe(true)
    expect(isModelListStale({ at: now - MODEL_LIST_MAX_AGE_MS - 1 }, now)).toBe(true)
    expect(isModelListStale({ at: now - 1000 }, now)).toBe(false)
  })

  it('reads one provider from storage and ignores broken data', () => {
    const store = (v) => ({ getItem: () => v })
    const entry = { at: 1, models: [{ id: 'x', image: null }] }
    expect(loadModelListCache('grok', store(JSON.stringify({ grok: entry })))).toEqual(entry)
    expect(loadModelListCache('gemini', store(JSON.stringify({ grok: entry })))).toBeNull()
    expect(loadModelListCache('grok', store('not json'))).toBeNull()
  })
})
