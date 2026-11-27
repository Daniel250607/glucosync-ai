// Fetch the models the user's API key can use, so the settings page can offer them in a drop-down
// without a code change for every new model. The list is cached on this device only (not synced);
// the API key itself is never stored here.

const CACHE_KEY = 'glucosync_model_list_v1'
export const MODEL_LIST_MAX_AGE_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 15000

// Gemini models that cannot do this app's text + photo → JSON analysis.
const GEMINI_EXCLUDE = /(embedding|tts|image|audio|live|robotics|computer-use|aqa|learnlm)/i
// Grok models that only generate images / video.
const GROK_EXCLUDE = /(image|imagine|video)/i

function byNewest(a, b) {
  return b.id.localeCompare(a.id, 'en', { numeric: true })
}

/** Gemini `models.list` response → [{ id, image }] usable with generateContent. */
export function parseGeminiModels(json) {
  const seen = new Set()
  const out = []
  for (const m of json?.models || []) {
    const id = String(m?.name || '').replace(/^models\//, '')
    if (!id.startsWith('gemini') || GEMINI_EXCLUDE.test(id) || seen.has(id)) continue
    if (!(m.supportedGenerationMethods || []).includes('generateContent')) continue
    seen.add(id)
    out.push({ id, image: true })
  }
  return out.sort(byNewest)
}

/**
 * xAI `/v1/language-models` ({ models: [...] }, with modalities and aliases) or `/v1/models`
 * ({ data: [...] }, ids only) → [{ id, image }]. `image` is null when the API does not say.
 */
export function parseGrokModels(json) {
  const seen = new Set()
  const out = []
  const add = (id, image) => {
    id = String(id || '').trim()
    if (!id || GROK_EXCLUDE.test(id) || seen.has(id)) return
    seen.add(id)
    out.push({ id, image })
  }
  for (const m of json?.models || []) {
    if (Array.isArray(m?.output_modalities) && !m.output_modalities.includes('text')) continue
    const image = Array.isArray(m?.input_modalities) ? m.input_modalities.includes('image') : null
    add(m?.id, image)
    for (const a of m?.aliases || []) add(a, image)
  }
  for (const m of json?.data || []) add(m?.id, null)
  return out.sort(byNewest)
}

async function getJson(url, headers) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    let res
    try {
      res = await fetch(url, { headers, signal: controller.signal })
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? '查詢逾時' : '網路連線失敗')
    }
    if (!res.ok) {
      const err = new Error(res.status === 401 || res.status === 403 || res.status === 400 ? `金鑰無效或沒有權限（HTTP ${res.status}）` : `HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    return await res.json()
  } finally {
    clearTimeout(timeoutId)
  }
}

async function fetchGemini(apiKey) {
  const json = await getJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
    'x-goog-api-key': apiKey,
  })
  return parseGeminiModels(json)
}

async function fetchGrok(apiKey) {
  const headers = { Authorization: `Bearer ${apiKey}` }
  try {
    return parseGrokModels(await getJson('https://api.x.ai/v1/language-models', headers))
  } catch (e) {
    if (e.status !== 404) throw e
    return parseGrokModels(await getJson('https://api.x.ai/v1/models', headers))
  }
}

export function loadModelListCache(provider, storage = globalThis.localStorage) {
  try {
    const entry = JSON.parse(storage?.getItem(CACHE_KEY) || '{}')[provider]
    return entry && Array.isArray(entry.models) ? entry : null
  } catch {
    return null
  }
}

function saveModelListCache(provider, models, now, storage = globalThis.localStorage) {
  try {
    const all = JSON.parse(storage?.getItem(CACHE_KEY) || '{}')
    all[provider] = { at: now, models }
    storage?.setItem(CACHE_KEY, JSON.stringify(all))
  } catch {
    // Cache is optional; the drop-down still works for this session.
  }
}

export function isModelListStale(entry, now = Date.now()) {
  return !entry || !(now - entry.at < MODEL_LIST_MAX_AGE_MS)
}

/** Query the provider's model list with the given key and cache it. Throws a short Chinese message on failure. */
export async function refreshModelList(provider, apiKey, now = Date.now()) {
  if (!apiKey) throw new Error('請先填入 API Key')
  const models = provider === 'grok' ? await fetchGrok(apiKey) : await fetchGemini(apiKey)
  if (!models.length) throw new Error('沒有查到可用的模型')
  saveModelListCache(provider, models, now)
  return { at: now, models }
}

/**
 * Drop-down options: the fetched list (or the built-in fallback), plus the default and the user's
 * current choice so neither disappears when the API no longer lists it.
 */
export function modelChoices({ fetched, fallback, defaultModel, current }) {
  const list = fetched?.length ? [...fetched] : fallback.map((id) => ({ id, image: null }))
  for (const id of [current, defaultModel]) {
    if (id && !list.some((m) => m.id === id)) list.unshift({ id, image: null })
  }
  return list
}
