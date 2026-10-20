// Persistence layer: Firestore when configured, otherwise localStorage.
// No secrets are hardcoded: config comes from user settings (localStorage)
// or Vite environment variables (VITE_*).
import { initializeApp } from 'firebase/app'
import { getFirestore, collection, doc, getDoc, getDocs, setDoc } from 'firebase/firestore'

const SETTINGS_KEY = 'glucosync.settings'
const DAYS_KEY = 'glucosync.days'
const LABS_KEY = 'glucosync.labs'
const CONFIG_KEY = 'glucosync.customConfig'

// ---------- Settings ----------
export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}
  } catch {
    return {}
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

export function getGeminiKey() {
  return loadSettings().geminiApiKey || import.meta.env.VITE_GEMINI_API_KEY || ''
}

// Accepts strict JSON or a pasted JS object literal ({ apiKey: "..." }).
export function parseFirebaseConfig(text) {
  if (!text || !text.trim()) return null
  let src = text.trim()
  const m = src.match(/\{[\s\S]*\}/)
  if (m) src = m[0]
  try {
    return JSON.parse(src)
  } catch {
    try {
      const fixed = src
        .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
        .replace(/'/g, '"')
        .replace(/,\s*}/g, '}')
      return JSON.parse(fixed)
    } catch {
      return null
    }
  }
}

function resolveFirebaseConfig() {
  const fromSettings = parseFirebaseConfig(loadSettings().firebaseConfig)
  if (fromSettings && fromSettings.projectId) return fromSettings
  const e = import.meta.env
  if (e.VITE_FIREBASE_API_KEY && e.VITE_FIREBASE_PROJECT_ID) {
    return {
      apiKey: e.VITE_FIREBASE_API_KEY,
      authDomain: e.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: e.VITE_FIREBASE_PROJECT_ID,
      storageBucket: e.VITE_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: e.VITE_FIREBASE_MESSAGING_SENDER_ID,
      appId: e.VITE_FIREBASE_APP_ID,
    }
  }
  return null
}

let db = null
try {
  const cfg = resolveFirebaseConfig()
  if (cfg) db = getFirestore(initializeApp(cfg))
} catch (err) {
  console.warn('[GlucoSync] Firebase init failed, using localStorage.', err)
  db = null
}

export const backend = db ? 'firestore' : 'localStorage'

// ---------- Helpers ----------
export function todayKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function emptyDay(date) {
  return {
    date,
    hydration_cc: 0,
    exercise_min: 0,
    meds: {
      morning: { eutomin: false, forxiga: false, glitos: false, roty: false },
      evening: { eutomin: false },
    },
    meals: [],
  }
}

function readLocal(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || {}
  } catch {
    return {}
  }
}

function writeLocal(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
}

// ---------- Daily logs ----------
export async function loadDays() {
  const local = readLocal(DAYS_KEY)
  if (!db) return local
  try {
    const snap = await getDocs(collection(db, 'days'))
    const remote = {}
    snap.forEach((d) => (remote[d.id] = d.data()))
    const merged = { ...local, ...remote }
    writeLocal(DAYS_KEY, merged)
    return merged
  } catch (err) {
    console.warn('[GlucoSync] Firestore read failed, using local cache.', err)
    return local
  }
}

export async function saveDay(day) {
  const all = readLocal(DAYS_KEY)
  all[day.date] = day
  writeLocal(DAYS_KEY, all)
  if (!db) return
  try {
    await setDoc(doc(db, 'days', day.date), day)
  } catch (err) {
    console.warn('[GlucoSync] Firestore write failed (kept in localStorage).', err)
  }
}

// ---------- Custom UI configuration (presets, tags, targets, medications) ----------
// Stored in localStorage under `glucosync.customConfig` and, when Firestore is
// configured, mirrored to the `config/custom` document. The newer `updated_at` wins.
export async function loadCustomConfig() {
  const local = readLocal(CONFIG_KEY)
  if (!db) return local
  try {
    const snap = await getDoc(doc(db, 'config', 'custom'))
    if (snap.exists()) {
      const remote = snap.data()
      if ((remote.updated_at || 0) > (local.updated_at || 0)) {
        writeLocal(CONFIG_KEY, remote)
        return remote
      }
    }
    if (local.updated_at) setDoc(doc(db, 'config', 'custom'), local).catch(() => {})
  } catch (err) {
    console.warn('[GlucoSync] Firestore config read failed, using local copy.', err)
  }
  return local
}

/** `cfg` = overrides only (see getCustomConfig in presets.js). Empty object = all defaults. */
export async function saveCustomConfig(cfg) {
  const payload = { ...JSON.parse(JSON.stringify(cfg || {})), updated_at: Date.now() }
  writeLocal(CONFIG_KEY, payload)
  if (!db) return
  try {
    await setDoc(doc(db, 'config', 'custom'), payload)
  } catch (err) {
    console.warn('[GlucoSync] Firestore write failed (kept in localStorage).', err)
  }
}

// ---------- Backup (export / import) ----------
/** Everything the user can move between devices. API key / Firebase config are NOT included. */
export function buildBackup(customConfig = {}) {
  return {
    app: 'glucosync-ai',
    version: 2,
    exported_at: new Date().toISOString(),
    days: readLocal(DAYS_KEY),
    labs: readLocal(LABS_KEY),
    customConfig,
  }
}

/**
 * Merge a backup into storage (imported entries win on the same date).
 * Returns counts plus the raw `customConfig` section (if any) for the caller to apply.
 */
export async function importBackup(data) {
  if (!data || data.app !== 'glucosync-ai' || typeof data.days !== 'object') {
    throw new Error('不是有效的 GlucoSync 備份檔。')
  }
  let days = 0
  let labs = 0
  for (const d of Object.values(data.days || {})) {
    if (d && d.date) {
      await saveDay(d)
      days++
    }
  }
  const labList = Array.isArray(data.labs) ? data.labs : Object.values(data.labs || {})
  for (const l of labList) {
    if (l && l.date) {
      await saveLab(l)
      labs++
    }
  }
  const hasConfig = data.customConfig && typeof data.customConfig === 'object'
  return { days, labs, customConfig: hasConfig ? data.customConfig : null }
}

// ---------- Lab results ----------
export async function loadLabs() {
  const local = readLocal(LABS_KEY)
  let merged = local
  if (db) {
    try {
      const snap = await getDocs(collection(db, 'labs'))
      const remote = {}
      snap.forEach((d) => (remote[d.id] = d.data()))
      merged = { ...local, ...remote }
      writeLocal(LABS_KEY, merged)
    } catch (err) {
      console.warn('[GlucoSync] Firestore read failed, using local cache.', err)
    }
  }
  return Object.values(merged).sort((a, b) => a.date.localeCompare(b.date))
}

export async function saveLab(lab) {
  const all = readLocal(LABS_KEY)
  all[lab.date] = lab
  writeLocal(LABS_KEY, all)
  if (!db) return
  try {
    await setDoc(doc(db, 'labs', lab.date), lab)
  } catch (err) {
    console.warn('[GlucoSync] Firestore write failed (kept in localStorage).', err)
  }
}
