<script setup>
import { computed, onBeforeUnmount, onMounted, provide, reactive, ref, watch } from 'vue'
import DailyTracker from './components/DailyTracker.vue'
import TrendChart from './components/TrendChart.vue'
import LabMilestones from './components/LabMilestones.vue'
import {
  PENDING_QR_PAIR_KEY,
  QR_PAIR_TTL_MS,
  applyPairedSettings,
  base64ToBytes,
  buildBackup,
  bytesToBase64,
  decryptJson,
  deleteQrPairing,
  emptyDay,
  encryptJson,
  ensureFirebaseFromSettings,
  formatAuthError,
  getStoredFirebaseConfig,
  importBackup,
  isAuthorizedEmail,
  isCloudReady,
  isFirebaseConfigured,
  loadCustomConfig,
  loadDays,
  loadLabs,
  loadSettings,
  markNonceUsed,
  nonceWasUsed,
  onAuthStateChanged,
  parseFirebaseConfig,
  randomBytes,
  randomHex,
  readQrPairing,
  saveCustomConfig,
  saveDay,
  saveLab,
  saveSettings,
  signInWithGoogle,
  signOutUser,
  todayKey,
  watchQrPairing,
  writeQrPairing,
} from './firebase.js'
import {
  TARGETS,
  applyCustomConfig,
  getCustomConfig,
  hydrationRangeFromWeight,
  live,
  onCustomConfigChange,
  resetCustom,
  updateCustom,
} from './data/presets.js'
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_THINKING_BUDGET,
  GEMINI_MODEL_OPTIONS,
  THINKING_LEVEL_OPTIONS,
  normalizeThinkingBudget,
} from './services/gemini.js'

const tabs = [
  { id: 'daily', label: '今日記錄', icon: '📝' },
  { id: 'trend', label: '趨勢', icon: '📈' },
  { id: 'labs', label: '檢驗', icon: '🧪' },
]
const tab = ref('daily')

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const days = ref({})
const labs = ref([])
const loaded = ref(false)
const today = computed(() => todayKey())
const selectedDate = ref(todayKey())
const authUser = ref(null)
const authBusy = ref(false)
const authReady = ref(false)
const showFirebaseSetup = ref(false)
const firebaseConfigured = isFirebaseConfigured()

const isAuthorized = computed(() => !!(authUser.value && isAuthorizedEmail(authUser.value.email)))
const currentDay = computed(() => days.value[selectedDate.value] || emptyDay(selectedDate.value))
const isPastDate = computed(() => selectedDate.value !== today.value)
const canGoNext = computed(() => selectedDate.value < today.value)
const selectedWeekday = computed(() => weekdayLabel(selectedDate.value))

function weekdayLabel(iso) {
  const parts = String(iso || '').split('-').map(Number)
  if (parts.length !== 3 || parts.some((n) => !n)) return ''
  return WEEKDAYS[new Date(parts[0], parts[1] - 1, parts[2]).getDay()] || ''
}

function shiftIsoDate(iso, delta) {
  const parts = String(iso || todayKey()).split('-').map(Number)
  const dt = new Date(parts[0], parts[1] - 1, parts[2])
  dt.setDate(dt.getDate() + delta)
  return todayKey(dt)
}

function clampSelectedDate() {
  const cap = todayKey()
  if (!selectedDate.value || selectedDate.value > cap) selectedDate.value = cap
}

function prevDay() {
  selectedDate.value = shiftIsoDate(selectedDate.value, -1)
}

function nextDay() {
  if (!canGoNext.value) return
  selectedDate.value = shiftIsoDate(selectedDate.value, 1)
  clampSelectedDate()
}

function resetToToday() {
  selectedDate.value = todayKey()
}
const synced = computed(() => !!(isAuthorized.value && isCloudReady()))
const syncBadge = computed(() => (synced.value ? '☁️ 已同步' : '💾 本機快取'))
const userInitials = computed(() => {
  const u = authUser.value
  if (!u) return '?'
  const src = String(u.displayName || u.email || '?').trim()
  return src.charAt(0).toUpperCase()
})

// Persist every user edit of presets / tags / targets / medications (localStorage + Firestore).
onCustomConfigChange(() => {
  if (isAuthorized.value) saveCustomConfig(getCustomConfig())
})

async function hydrateFromStorage() {
  applyCustomConfig(await loadCustomConfig())
  days.value = await loadDays()
  labs.value = await loadLabs()
}

function lockApp() {
  authUser.value = null
  days.value = {}
  labs.value = []
  loaded.value = false
  showSettings.value = false
  selectedDate.value = todayKey()
  destroyQrPairing(true)
  applyCustomConfig({})
}

onMounted(() => {
  ingestQrPairHash()
  pendingPairBanner.value = !!readPendingPair()
  onAuthStateChanged(async (user, meta) => {
    authReady.value = true
    if (meta && meta.denied) showToast('⛔ 存取被拒：此帳號未獲授權')
    if (user && isAuthorizedEmail(user.email)) {
      authUser.value = user
      await hydrateFromStorage()
      loaded.value = true
      await consumePendingCloudPair()
      return
    }
    lockApp()
  })
})

onBeforeUnmount(() => {
  destroyQrPairing(true)
})

async function updateDay(day) {
  days.value = { ...days.value, [day.date]: day }
  await saveDay(day)
}

async function addLab(lab) {
  labs.value = [...labs.value.filter((l) => l.date !== lab.date), lab].sort((a, b) =>
    a.date.localeCompare(b.date),
  )
  await saveLab(lab)
}

function applyProposedTargets(targets) {
  if (!targets) return
  const merged = { ...live.targets, ...targets }
  updateCustom('targets', { ...merged, ...hydrationRangeFromWeight(merged.userWeight) })
  if (showSettings.value) loadDraft()
  showToast('已套用建議目標至設定')
}

// ---------- settings ----------
const showSettings = ref(false)
const settingsTab = ref('system')
const showApiKey = ref(false)
const settings = reactive({
  geminiApiKey: '',
  firebaseConfig: '',
  geminiModel: DEFAULT_GEMINI_MODEL,
  thinkingBudget: DEFAULT_THINKING_BUDGET,
})
const settingsError = ref('')
const pendingPairBanner = ref(false)
const qrPair = reactive({
  active: false,
  busy: false,
  mode: '',
  token: '',
  svg: '',
  remainSec: 0,
})
let qrTimer = null
let qrUnsub = null
let qrSelfDestroy = false
const thinkingLevelHint = computed(() => {
  const opt = THINKING_LEVEL_OPTIONS.find((o) => o.budget === Number(settings.thinkingBudget))
  return opt
    ? opt.budget === 0
      ? `${opt.hint}。思考預算 0 會略過長推理。`
      : `${opt.hint}（thinkingBudget ${opt.budget}）。`
    : '自訂思考預算。'
})

// Global toast: visible 6s, manual dismiss. Used so Gemini errors are not buried in the console.
const toast = ref('')
let toastTimer = null
function showToast(msg) {
  if (!msg) return
  toast.value = String(msg)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = ''
  }, 6000)
}
function dismissToast() {
  toast.value = ''
  clearTimeout(toastTimer)
}
provide('showToast', showToast)

async function handleSignIn() {
  if (authBusy.value) return
  authBusy.value = true
  try {
    await signInWithGoogle()
  } catch (err) {
    showToast(formatAuthError(err))
  } finally {
    authBusy.value = false
  }
}

async function handleSignOut() {
  if (authBusy.value) return
  authBusy.value = true
  try {
    await signOutUser()
    lockApp()
  } catch (err) {
    showToast(formatAuthError(err))
  } finally {
    authBusy.value = false
  }
}

function openFirebaseSetup() {
  const s = loadSettings()
  settings.firebaseConfig = s.firebaseConfig || ''
  settingsError.value = ''
  showFirebaseSetup.value = true
}

function submitFirebaseSetup() {
  settingsError.value = ''
  const text = settings.firebaseConfig.trim()
  if (text) {
    const cfg = parseFirebaseConfig(text)
    if (!cfg || !cfg.projectId) {
      settingsError.value = 'Firebase 設定格式錯誤，需包含 projectId。'
      return
    }
  }
  const prev = loadSettings()
  saveSettings({
    ...prev,
    geminiApiKey: prev.geminiApiKey || '',
    firebaseConfig: text,
    geminiModel: prev.geminiModel || DEFAULT_GEMINI_MODEL,
    thinkingBudget: normalizeThinkingBudget(prev.thinkingBudget),
  })
  showFirebaseSetup.value = false
  location.reload()
}

// Draft copy of targets + medications: only applied when the user presses 儲存.
const draft = reactive({ targets: { ...TARGETS }, medications: [] })

const TARGET_FIELDS = [
  { label: '碳水 最低 (g)', key: 'carbsMin' },
  { label: '碳水 最高 (g)', key: 'carbsMax' },
  { label: '飽和脂肪 警示 (g)', key: 'satFatMin' },
  { label: '飽和脂肪 上限 (g)', key: 'satFatMax' },
  { label: '體重 (kg)', key: 'userWeight' },
  { label: '飲水 下限 (cc)', key: 'hydrationMin', readonly: true },
  { label: '飲水 上限 (cc)', key: 'hydrationMax', readonly: true },
  { label: '運動目標 (分)', key: 'exerciseTarget' },
]

watch(
  () => Number(draft.targets.userWeight),
  (w) => {
    const range = hydrationRangeFromWeight(w)
    draft.targets.hydrationMin = range.hydrationMin
    draft.targets.hydrationMax = range.hydrationMax
  },
)

function loadDraft() {
  draft.targets = { ...live.targets }
  draft.medications = JSON.parse(JSON.stringify(live.medications))
}

function addDraftMed() {
  draft.medications.push({ id: `med-${Date.now()}`, name: '', dosage: '', timing: 'morning' })
}
function removeDraftMed(i) {
  draft.medications.splice(i, 1)
}

function resetTargetsAndMeds() {
  if (!window.confirm('確定要恢復預設的個人目標與用藥清單？')) return
  resetCustom(['targets', 'medications'])
  loadDraft()
}

function openSettings(initialTab) {
  settingsTab.value = initialTab === 'targets' ? 'targets' : 'system'
  showApiKey.value = false
  const s = loadSettings()
  settings.geminiApiKey = s.geminiApiKey || ''
  settings.firebaseConfig = s.firebaseConfig || ''
  settings.geminiModel = s.geminiModel || DEFAULT_GEMINI_MODEL
  settings.thinkingBudget = normalizeThinkingBudget(
    s.thinkingBudget != null && s.thinkingBudget !== '' ? s.thinkingBudget : DEFAULT_THINKING_BUDGET,
  )
  settingsError.value = ''
  dataMsg.value = ''
  loadDraft()
  showSettings.value = true
}

function closeSettings() {
  destroyQrPairing(true)
  showSettings.value = false
}

function validateDraft() {
  const t = draft.targets
  for (const f of TARGET_FIELDS) {
    const v = Number(t[f.key])
    if (t[f.key] === '' || t[f.key] == null || !Number.isFinite(v) || v < 0) return `「${f.label}」必須是 0 以上的數字。`
  }
  if (Number(t.carbsMin) > Number(t.carbsMax)) return '碳水最低值不可大於最高值。'
  if (Number(t.satFatMin) > Number(t.satFatMax)) return '飽和脂肪警示值不可大於上限。'
  if (!(Number(t.userWeight) > 0)) return '體重必須大於 0 kg。'
  if (Number(t.hydrationMin) > Number(t.hydrationMax)) return '飲水下限不可大於上限。'
  if (draft.medications.some((m) => !m.name.trim())) return '藥物名稱不可空白 (不需要的請刪除)。'
  return ''
}

function submitSettings() {
  settingsError.value = ''
  const text = settings.firebaseConfig.trim()
  if (text) {
    const cfg = parseFirebaseConfig(text)
    if (!cfg || !cfg.projectId) {
      settingsError.value = 'Firebase 設定格式錯誤，需包含 projectId。'
      return
    }
  }
  const problem = validateDraft()
  if (problem) {
    settingsError.value = problem
    return
  }
  const prev = loadSettings()
  saveSettings({
    ...prev,
    geminiApiKey: settings.geminiApiKey.trim(),
    firebaseConfig: text,
    geminiModel: settings.geminiModel.trim() || DEFAULT_GEMINI_MODEL,
    thinkingBudget: normalizeThinkingBudget(settings.thinkingBudget),
  })
  // Only write an override when something actually differs from the current effective config.
  const nums = Object.fromEntries(Object.entries(draft.targets).map(([k, v]) => [k, Number(v)]))
  if (JSON.stringify(nums) !== JSON.stringify(live.targets)) updateCustom('targets', nums)
  if (JSON.stringify(draft.medications) !== JSON.stringify(live.medications)) {
    updateCustom('medications', draft.medications)
  }
  closeSettings()
  // Firebase is initialised at load time, so reload when its config changed.
  if ((prev.firebaseConfig || '') !== text) location.reload()
}

// ---------- backup: export / import (API key & Firebase config are NOT included) ----------
const dataMsg = ref('')
const dataMsgOk = ref(true)

function exportData() {
  const blob = new Blob([JSON.stringify(buildBackup(getCustomConfig()), null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `glucosync-backup-${todayKey()}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  dataMsgOk.value = true
  dataMsg.value = '已匯出備份檔 (含記錄、檢驗與自訂快選/目標/用藥)。'
}

async function importData(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file) return
  try {
    const res = await importBackup(JSON.parse(await file.text()))
    if (res.customConfig) {
      applyCustomConfig(res.customConfig)
      await saveCustomConfig(getCustomConfig())
      loadDraft()
    }
    days.value = await loadDays()
    labs.value = await loadLabs()
    dataMsgOk.value = true
    dataMsg.value = `已匯入 ${res.days} 天記錄、${res.labs} 筆檢驗${res.customConfig ? '，並還原自訂快選/目標/用藥' : ''}。`
  } catch (err) {
    dataMsgOk.value = false
    dataMsg.value = `匯入失敗：${err.message || err}`
  }
}

// ---------- One-time dynamic QR pairing ----------
function readPendingPair() {
  try {
    return JSON.parse(sessionStorage.getItem(PENDING_QR_PAIR_KEY) || 'null')
  } catch {
    return null
  }
}

function writePendingPair(payload) {
  if (!payload) sessionStorage.removeItem(PENDING_QR_PAIR_KEY)
  else sessionStorage.setItem(PENDING_QR_PAIR_KEY, JSON.stringify(payload))
  pendingPairBanner.value = !!payload
}

function stripLocationHash() {
  try {
    history.replaceState(null, '', `${location.pathname}${location.search}`)
  } catch {
    location.hash = ''
  }
}

function parseQrPairHash() {
  const h = String(location.hash || '')
  if (h.indexOf('#qrpair=') !== 0) return null
  try {
    return JSON.parse(atob(decodeURIComponent(h.slice('#qrpair='.length))))
  } catch {
    return null
  }
}

function buildPairingUrl(payload) {
  const encoded = encodeURIComponent(btoa(JSON.stringify(payload)))
  const base =
    location.protocol === 'file:'
      ? String(location.href || '').split('#')[0]
      : `${location.origin}${location.pathname}`
  return `${base}#qrpair=${encoded}`
}

function loadQrLib() {
  if (window.qrcode) return Promise.resolve(window.qrcode)
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js'
    s.onload = () => (window.qrcode ? resolve(window.qrcode) : reject(new Error('QR 函式庫載入失敗')))
    s.onerror = () => reject(new Error('無法載入 QR 函式庫'))
    document.head.appendChild(s)
  })
}

function renderQrSvg(text) {
  const qr = window.qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({ scalable: true, margin: 2 })
}

function persistPairFirebase(fb) {
  if (!fb) return false
  const prev = loadSettings()
  const text = typeof fb === 'string' ? fb : JSON.stringify(fb)
  if (!parseFirebaseConfig(text)) return false
  saveSettings({ ...prev, firebaseConfig: text })
  return !isFirebaseConfigured()
}

function ingestQrPairHash() {
  const payload = parseQrPairHash()
  if (!payload) {
    pendingPairBanner.value = !!readPendingPair()
    return
  }
  stripLocationHash()
  if (payload.m === 'local') {
    consumeLocalPair(payload)
    return
  }
  if (payload.m === 'cloud' && payload.t && payload.k) {
    const needsReload = persistPairFirebase(payload.fb)
    writePendingPair({ t: payload.t, k: payload.k })
    if (needsReload) {
      location.reload()
      return
    }
    ensureFirebaseFromSettings()
    pendingPairBanner.value = true
  }
}

function consumeLocalPair(payload) {
  if (!payload || Date.now() >= Number(payload.exp) || !payload.n || nonceWasUsed(payload.n)) {
    showToast('⛔ 此 QR Code 已失效或已被使用過')
    return false
  }
  applyPairedSettings({
    geminiKey: payload.gk,
    geminiModel: payload.gm,
    thinkingBudget: normalizeThinkingBudget(payload.tb),
    firebaseConfig: payload.fb,
  })
  markNonceUsed(payload.n)
  const s = loadSettings()
  settings.geminiApiKey = s.geminiApiKey || ''
  settings.firebaseConfig = s.firebaseConfig || ''
  settings.geminiModel = s.geminiModel || DEFAULT_GEMINI_MODEL
  settings.thinkingBudget = normalizeThinkingBudget(s.thinkingBudget)
  showToast('🎉 手機配對完成！')
  if (payload.fb && !isFirebaseConfigured()) location.reload()
  return true
}

async function consumePendingCloudPair() {
  const pending = readPendingPair()
  if (!pending || !pending.t || !pending.k) return
  try {
    ensureFirebaseFromSettings()
    const rec = await readQrPairing(pending.t)
    if (!rec || Date.now() >= Number(rec.expiresAt)) {
      if (rec) await deleteQrPairing(pending.t)
      writePendingPair(null)
      showToast('⛔ 此 QR Code 已失效或已被使用過')
      return
    }
    const data = await decryptJson(rec.ciphertext, rec.iv, base64ToBytes(pending.k))
    applyPairedSettings({
      geminiKey: data.geminiKey,
      geminiModel: data.geminiModel,
      thinkingBudget: normalizeThinkingBudget(data.thinkingBudget),
    })
    await deleteQrPairing(pending.t)
    writePendingPair(null)
    const s = loadSettings()
    settings.geminiApiKey = s.geminiApiKey || ''
    settings.firebaseConfig = s.firebaseConfig || ''
    settings.geminiModel = s.geminiModel || DEFAULT_GEMINI_MODEL
    settings.thinkingBudget = normalizeThinkingBudget(s.thinkingBudget)
    showToast('🎉 手機配對完成！金鑰與設定已成功匯入，QR Code 已銷毀失效')
  } catch (err) {
    showToast(err.message || String(err))
  }
}

function clearQrView() {
  if (qrTimer) {
    clearInterval(qrTimer)
    qrTimer = null
  }
  if (qrUnsub) {
    qrUnsub()
    qrUnsub = null
  }
  qrPair.active = false
  qrPair.busy = false
  qrPair.mode = ''
  qrPair.token = ''
  qrPair.svg = ''
  qrPair.remainSec = 0
}

async function destroyQrPairing(silent) {
  const token = qrPair.token
  const mode = qrPair.mode
  qrSelfDestroy = true
  if (mode === 'cloud' && token) await deleteQrPairing(token)
  clearQrView()
  qrSelfDestroy = false
  if (!silent && mode) showToast('此 QR Code 已銷毀失效')
}

function startQrCountdown() {
  if (qrTimer) clearInterval(qrTimer)
  qrTimer = setInterval(() => {
    qrPair.remainSec -= 1
    if (qrPair.remainSec <= 0) destroyQrPairing(true)
  }, 1000)
}

async function generateQrPairing() {
  await destroyQrPairing(true)
  qrPair.busy = true
  try {
    const fbObj = parseFirebaseConfig(settings.firebaseConfig) || getStoredFirebaseConfig()
    const expiresAt = Date.now() + QR_PAIR_TTL_MS
    let payload
    if (isCloudReady() && window.crypto && crypto.subtle) {
      const token = randomHex(16)
      const keyBytes = randomBytes(16)
      const enc = await encryptJson(
        {
          geminiKey: settings.geminiApiKey.trim(),
          geminiModel: settings.geminiModel.trim() || DEFAULT_GEMINI_MODEL,
          thinkingBudget: normalizeThinkingBudget(settings.thinkingBudget),
        },
        keyBytes,
      )
      await writeQrPairing(token, {
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        createdAt: Date.now(),
        expiresAt,
      })
      payload = { m: 'cloud', t: token, k: bytesToBase64(keyBytes), fb: fbObj || undefined }
      qrPair.mode = 'cloud'
      qrPair.token = token
      let sawDoc = false
      qrUnsub = watchQrPairing(token, (data) => {
        if (data) {
          sawDoc = true
          return
        }
        if (!sawDoc || qrSelfDestroy) return
        clearQrView()
        showToast('✅ 手機配對成功，此 QR Code 已自動銷毀失效！')
      })
    } else {
      const n = randomHex(16)
      payload = {
        m: 'local',
        n,
        exp: expiresAt,
        gk: settings.geminiApiKey.trim(),
        gm: settings.geminiModel.trim() || DEFAULT_GEMINI_MODEL,
        tb: normalizeThinkingBudget(settings.thinkingBudget),
        fb: fbObj || undefined,
      }
      qrPair.mode = 'local'
      qrPair.token = n
    }
    await loadQrLib()
    qrPair.svg = renderQrSvg(buildPairingUrl(payload))
    qrPair.active = true
    qrPair.remainSec = Math.floor(QR_PAIR_TTL_MS / 1000)
    startQrCountdown()
  } catch (err) {
    await destroyQrPairing(true)
    showToast(err.message || String(err))
  } finally {
    qrPair.busy = false
  }
}

const qrCountdownLabel = computed(() => {
  const s = Math.max(0, Number(qrPair.remainSec) || 0)
  const m = Math.floor(s / 60)
  const sec = String(s % 60).padStart(2, '0')
  return `${m}:${sec}`
})
</script>

<template>
  <div>
    <!-- Global error toast (top of viewport, 6s / dismiss) -->
    <div v-if="toast" class="fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-3 pointer-events-none">
      <div
        role="alert"
        class="pointer-events-auto flex w-full max-w-4xl items-start gap-3 rounded-xl bg-rose-600 px-4 py-3 text-sm text-white shadow-lg"
      >
        <p class="min-w-0 flex-1 break-words">{{ toast }}</p>
        <button
          class="grid size-8 shrink-0 place-items-center rounded-full bg-white/20 text-base active:bg-white/30"
          aria-label="關閉"
          @click="dismissToast"
        >
          ✕
        </button>
      </div>
    </div>

    <div v-if="!authReady" class="grid min-h-screen place-items-center bg-slate-50">
      <div class="flex flex-col items-center gap-3 text-slate-500">
        <div class="size-10 animate-spin rounded-full border-4 border-slate-200 border-t-teal-600"></div>
        <p class="text-sm">驗證登入狀態…</p>
      </div>
    </div>

    <div v-else-if="!isAuthorized" class="grid min-h-screen place-items-center bg-slate-50 px-4">
      <div class="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-lg ring-1 ring-slate-200">
        <h1 class="text-xl font-bold text-slate-800">GlucoSync｜個人代謝與健康管理系統</h1>
        <p class="mt-3 text-sm text-slate-500">此系統僅限授權帳號存取，請登入以檢視紀錄</p>
        <p
          v-if="pendingPairBanner"
          class="mt-4 rounded-xl bg-teal-50 px-3 py-2.5 text-left text-sm text-teal-800 ring-1 ring-teal-200"
        >
          📱 偵測到手機配對請求，請點擊下方 Google 登入以解密金鑰並完成設定配對
        </p>
        <button
          class="mt-8 w-full rounded-xl bg-teal-700 py-3.5 text-base font-semibold text-white active:bg-teal-800 disabled:opacity-60"
          :disabled="authBusy"
          @click="handleSignIn"
        >🔑 使用 Google 帳號登入</button>
        <button class="mt-4 text-xs text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline" @click="openFirebaseSetup">
          {{ firebaseConfigured ? '重新設定 Firebase' : 'Firebase 尚未設定？貼上設定' }}
        </button>
      </div>
    </div>

    <div
      v-if="!isAuthorized && showFirebaseSetup"
      class="fixed inset-0 z-30 flex items-end bg-black/40 sm:items-center sm:justify-center"
      @click.self="showFirebaseSetup = false"
    >
      <div class="w-full rounded-t-2xl bg-white p-5 sm:max-w-lg sm:rounded-2xl">
        <h2 class="text-lg font-semibold text-slate-800">Firebase 設定</h2>
        <p class="mt-1 text-xs text-slate-500">僅用於初始化登入，不會顯示個人紀錄。</p>
        <textarea
          v-model="settings.firebaseConfig"
          rows="6"
          spellcheck="false"
          placeholder='{"apiKey":"...","authDomain":"...","projectId":"...","storageBucket":"...","messagingSenderId":"...","appId":"..."}'
          class="mt-4 w-full rounded-lg border border-slate-300 p-2.5 font-mono text-xs"
        />
        <p v-if="settingsError" class="mt-3 rounded-lg bg-rose-50 p-2 text-sm text-rose-600">{{ settingsError }}</p>
        <div class="mt-5 grid grid-cols-2 gap-3">
          <button class="rounded-xl bg-slate-100 py-3 text-slate-700" @click="showFirebaseSetup = false">取消</button>
          <button class="rounded-xl bg-teal-700 py-3 font-semibold text-white" @click="submitFirebaseSetup">儲存並重新載入</button>
        </div>
      </div>
    </div>

    <div v-if="isAuthorized" class="min-h-screen pb-24 md:pb-8">
    <header class="sticky top-0 z-20 bg-teal-700 text-white shadow">
      <div class="mx-auto flex max-w-4xl items-center gap-2 px-4 py-3">
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-base font-bold sm:text-lg">GlucoSync｜AI 控糖降脂健康儀表板</h1>
          <p class="text-xs text-teal-100">
            {{ today }} ·
            <span
              class="ml-0.5 rounded-full px-1.5 py-0.5 text-[10px] sm:text-xs"
              :class="synced ? 'bg-emerald-400/25 text-emerald-50' : 'bg-white/10 text-teal-50'"
            >{{ syncBadge }}</span>
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          <img
            v-if="authUser.photoURL"
            :src="authUser.photoURL"
            alt=""
            class="size-8 rounded-full object-cover ring-1 ring-white/40"
            referrerpolicy="no-referrer"
          />
          <span
            v-else
            class="grid size-8 place-items-center rounded-full bg-white/20 text-sm font-semibold"
          >{{ userInitials }}</span>
          <span class="max-w-[7rem] truncate text-[10px] text-teal-50 sm:max-w-[11rem] sm:text-xs">{{ authUser.email }}</span>
          <button
            class="rounded-full bg-white/15 px-2.5 py-1.5 text-xs active:bg-white/25 disabled:opacity-60"
            :disabled="authBusy"
            @click="handleSignOut"
          >登出</button>
          <button
            class="grid size-11 place-items-center rounded-full bg-white/10 text-xl active:bg-white/20"
            aria-label="設定"
            @click="openSettings"
          >
            ⚙️
          </button>
        </div>
      </div>
      <!-- Desktop tabs -->
      <nav class="mx-auto hidden max-w-4xl gap-1 px-4 md:flex">
        <button
          v-for="t in tabs"
          :key="t.id"
          class="rounded-t-lg px-5 py-2 text-sm font-medium"
          :class="tab === t.id ? 'bg-slate-50 text-teal-800' : 'text-teal-100 hover:bg-white/10'"
          @click="tab = t.id"
        >
          {{ t.icon }} {{ t.label }}
        </button>
      </nav>
    </header>

    <main class="mx-auto max-w-4xl p-4">
      <p v-if="!loaded" class="py-10 text-center text-slate-400">載入中…</p>
      <template v-else>
        <div v-show="tab === 'daily'" class="space-y-4">
          <section class="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="shrink-0 rounded-xl bg-slate-100 px-3 py-2.5 text-sm text-slate-700 active:bg-slate-200"
                @click="prevDay"
              >◀ 前一天</button>
              <div class="min-w-0 flex-1 text-center">
                <input
                  v-model="selectedDate"
                  type="date"
                  :max="today"
                  class="w-full rounded-lg border border-slate-300 px-2 py-2 text-center text-base text-slate-800"
                  @change="clampSelectedDate"
                />
                <p class="mt-1 text-xs text-slate-500">{{ selectedDate }} ({{ selectedWeekday }})</p>
              </div>
              <button
                type="button"
                class="shrink-0 rounded-xl bg-slate-100 px-3 py-2.5 text-sm text-slate-700 active:bg-slate-200 disabled:opacity-40"
                :disabled="!canGoNext"
                @click="nextDay"
              >後一天 ▶</button>
            </div>
            <div
              v-if="isPastDate"
              class="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200"
            >
              <p>⚠️ 正在補登 / 檢視：{{ selectedDate }}</p>
              <button
                type="button"
                class="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200"
                @click="resetToToday"
              >↩ 回到今天</button>
            </div>
          </section>
          <DailyTracker :day="currentDay" @update="updateDay" @open-settings="openSettings" />
        </div>
        <TrendChart v-show="tab === 'trend'" :days="days" />
        <LabMilestones
          v-show="tab === 'labs'"
          :labs="labs"
          :days="days"
          @add-lab="addLab"
          @open-settings="openSettings"
          @apply-targets="applyProposedTargets"
        />
      </template>
    </main>

    <!-- Mobile bottom tabs (one-handed) -->
    <nav
      class="fixed inset-x-0 bottom-0 z-20 grid grid-cols-3 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <button
        v-for="t in tabs"
        :key="t.id"
        class="flex flex-col items-center gap-0.5 py-2.5 text-xs"
        :class="tab === t.id ? 'font-semibold text-teal-700' : 'text-slate-500'"
        @click="tab = t.id"
      >
        <span class="text-xl leading-none">{{ t.icon }}</span>
        {{ t.label }}
      </button>
    </nav>

    <!-- Settings modal -->
    <div
      v-if="isAuthorized && showSettings"
      class="fixed inset-0 z-30 flex items-end bg-black/40 sm:items-center sm:justify-center"
      @click.self="closeSettings"
    >
      <div class="max-h-[90vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 sm:max-w-lg sm:rounded-2xl">
        <h2 class="text-lg font-semibold text-slate-800">設定</h2>
        <p class="mt-1 text-xs text-slate-500">
          金鑰僅儲存於此瀏覽器的 localStorage，不會寫入程式碼。亦可使用 .env 的 VITE_* 變數。
        </p>

        <div class="mt-4 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
          <button
            type="button"
            class="rounded-lg px-2 py-2 text-xs font-medium sm:text-sm"
            :class="settingsTab === 'system' ? 'bg-white text-teal-800 shadow-sm' : 'text-slate-500'"
            @click="settingsTab = 'system'"
          >🔌 系統與 AI 設定</button>
          <button
            type="button"
            class="rounded-lg px-2 py-2 text-xs font-medium sm:text-sm"
            :class="settingsTab === 'targets' ? 'bg-white text-teal-800 shadow-sm' : 'text-slate-500'"
            @click="settingsTab = 'targets'"
          >🎯 個人目標與用藥調整</button>
        </div>

        <div v-show="settingsTab === 'system'">
        <label class="mt-4 block text-sm font-medium text-slate-700">
          Gemini API Key
          <div class="mt-1 flex gap-2">
            <input
              v-model="settings.geminiApiKey"
              :type="showApiKey ? 'text' : 'password'"
              autocomplete="off"
              placeholder="AIza..."
              class="min-w-0 flex-1 rounded-lg border border-slate-300 p-2.5 text-base"
            />
            <button
              type="button"
              class="shrink-0 rounded-lg bg-slate-100 px-3 text-xs text-slate-600"
              @click="showApiKey = !showApiKey"
            >{{ showApiKey ? '隱藏' : '顯示' }}</button>
          </div>
        </label>

        <label class="mt-4 block text-sm font-medium text-slate-700">
          Gemini 模型名稱 (Model ID)
          <input
            v-model="settings.geminiModel"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="gemini-3.8-flash"
            class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 font-mono text-sm"
          />
        </label>
        <div class="mt-2 flex flex-wrap gap-2">
          <button
            v-for="m in GEMINI_MODEL_OPTIONS"
            :key="m"
            type="button"
            class="rounded-full px-3 py-1.5 text-xs"
            :class="settings.geminiModel === m ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-700'"
            @click="settings.geminiModel = m"
          >
            {{ m }}
          </button>
        </div>
        <p class="mt-1 text-xs text-slate-400">
          預設 {{ DEFAULT_GEMINI_MODEL }}。可在欄位填入其他有效模型名稱；舊版 gemini-2.0-flash / gemini-1.5-flash 已不適用新金鑰。
        </p>

        <p class="mt-4 text-sm font-medium text-slate-700">🧠 AI 思考程度 (Thinking Level)</p>
        <div class="mt-2 flex flex-wrap gap-2">
          <button
            v-for="opt in THINKING_LEVEL_OPTIONS"
            :key="opt.budget"
            type="button"
            class="rounded-full px-3 py-1.5 text-xs"
            :class="Number(settings.thinkingBudget) === opt.budget ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-700'"
            @click="settings.thinkingBudget = opt.budget"
          >
            {{ opt.label }}
          </button>
        </div>
        <p class="mt-1 text-xs text-slate-400">{{ thinkingLevelHint }}</p>

        <label class="mt-4 block text-sm font-medium text-slate-700">
          Firebase 設定 (JSON，可留空使用本機儲存)
          <textarea
            v-model="settings.firebaseConfig"
            rows="5"
            spellcheck="false"
            placeholder='{"apiKey":"...","authDomain":"...","projectId":"...","storageBucket":"...","messagingSenderId":"...","appId":"..."}'
            class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 font-mono text-xs"
          />
        </label>

        <div class="mt-5 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
          <p class="text-sm font-medium text-slate-800">📱 產生手機配對動態 QR Code</p>
          <p class="mt-1 text-xs text-slate-500">掃碼一次即匯入金鑰與設定，配對後 QR 立即銷毀。有效時間 5 分鐘。</p>
          <button
            type="button"
            class="mt-3 w-full rounded-lg bg-teal-700 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
            :disabled="qrPair.busy"
            @click="generateQrPairing"
          >{{ qrPair.active ? '重新產生 QR Code' : '📱 產生手機配對動態 QR Code' }}</button>
          <div v-if="qrPair.active" class="mt-3 text-center">
            <div class="mx-auto max-w-[220px] overflow-hidden rounded-xl bg-white p-2 ring-1 ring-slate-200" v-html="qrPair.svg"></div>
            <p class="mt-2 text-sm font-semibold text-slate-700">剩餘 {{ qrCountdownLabel }}</p>
            <p class="text-xs text-slate-400">{{ qrPair.mode === 'cloud' ? '雲端單次銷毀模式' : '離線時效 / 單次 nonce 模式' }}</p>
            <button type="button" class="mt-2 text-sm text-rose-600" @click="destroyQrPairing(false)">✕ 立即銷毀 QR Code</button>
          </div>
        </div>

        <hr class="my-5 border-slate-200" />
        <h3 class="text-sm font-semibold text-slate-800">資料備份 / 轉移</h3>
        <p class="mt-1 text-xs text-slate-500">
          匯出每日記錄、檢驗結果與自訂快選/標籤/目標/用藥 (不含 API Key 與 Firebase 設定)；匯入時會合併，同日期以匯入檔為準。
        </p>
        <div class="mt-3 grid grid-cols-2 gap-3">
          <button class="rounded-xl bg-slate-100 py-3 text-slate-700 active:bg-slate-200" @click="exportData">
            ⬇️ 匯出 JSON
          </button>
          <label class="cursor-pointer rounded-xl bg-slate-100 py-3 text-center text-slate-700 active:bg-slate-200">
            ⬆️ 匯入 JSON
            <input type="file" accept="application/json,.json" class="hidden" @change="importData" />
          </label>
        </div>
        <p v-if="dataMsg" class="mt-2 text-sm" :class="dataMsgOk ? 'text-emerald-700' : 'text-rose-600'">{{ dataMsg }}</p>
        </div>

        <div v-show="settingsTab === 'targets'">
        <p class="mt-4 text-xs text-slate-500">
          回診後可直接在此調整每日目標與用藥，儲存後「今日記錄」與「趨勢」圖會立即套用。
        </p>

        <div class="mt-3 grid grid-cols-2 gap-3">
          <label v-for="f in TARGET_FIELDS" :key="f.key" class="text-xs text-slate-500">
            {{ f.label }}
            <input
              v-model="draft.targets[f.key]"
              type="number"
              min="0"
              step="any"
              inputmode="decimal"
              :readonly="f.readonly"
              class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-base text-slate-800"
              :class="f.readonly ? 'bg-slate-50 text-slate-600' : ''"
            />
          </label>
        </div>
        <p class="mt-1 text-xs text-slate-400">預設：碳水 100-180g、飽和脂肪 15-20g、飲水依體重（70 kg → 2100-2660cc，下限不低於 2000cc）、運動 20 分。</p>

        <p class="mt-4 text-sm font-medium text-slate-700">用藥清單</p>
        <div class="mt-2 space-y-2">
          <div v-for="(m, i) in draft.medications" :key="m.id" class="space-y-1.5 rounded-lg bg-slate-50 p-2.5 ring-1 ring-slate-200">
            <div class="flex gap-2">
              <input
                v-model="m.name"
                placeholder="藥名 (例如 [REDACTED] ([REDACTED]))"
                class="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white p-2 text-base"
              />
              <button
                class="grid size-10 shrink-0 place-items-center rounded-lg bg-rose-50 text-rose-600 active:bg-rose-100"
                aria-label="刪除藥物"
                @click="removeDraftMed(i)"
              >
                🗑
              </button>
            </div>
            <div class="flex gap-2">
              <input
                v-model="m.dosage"
                placeholder="劑量 (例如 850mg)"
                class="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white p-2 text-base"
              />
              <select v-model="m.timing" class="rounded-lg border border-slate-300 bg-white p-2 text-base">
                <option value="morning">早上</option>
                <option value="evening">晚上</option>
                <option value="both">早 + 晚</option>
              </select>
            </div>
          </div>
        </div>
        <button class="mt-2 w-full rounded-lg bg-slate-100 py-2.5 text-sm text-slate-700 active:bg-slate-200" @click="addDraftMed">
          ＋ 新增藥物
        </button>
        <button class="mt-2 w-full rounded-lg py-2 text-sm text-rose-600 active:bg-rose-50" @click="resetTargetsAndMeds">
          ↩︎ 恢復預設目標與用藥
        </button>
        </div>

        <p v-if="settingsError" class="mt-3 rounded-lg bg-rose-50 p-2 text-sm text-rose-600">{{ settingsError }}</p>

        <div class="mt-5 grid grid-cols-2 gap-3">
          <button class="rounded-xl bg-slate-100 py-3 text-slate-700" @click="closeSettings">取消</button>
          <button class="rounded-xl bg-teal-700 py-3 font-semibold text-white" @click="submitSettings">儲存</button>
        </div>
      </div>
    </div>
    </div>
  </div>
</template>
