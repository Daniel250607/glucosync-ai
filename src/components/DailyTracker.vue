<script setup>
import { computed, inject, onBeforeUnmount, reactive, ref, watch } from 'vue'
import {
  equivalentMinutes,
  exerciseKcal,
  exerciseProfile,
  live,
  medsForSlot,
  medLabel,
  repsToMinutes,
  updateCustom,
  resetCustom,
} from '../data/presets.js'
import { MAX_MEAL_IMAGES, analyzeHydrationSchedule, analyzeMeal, suggestExerciseProfile, summarizeDay, summarizeDayAI } from '../services/gemini.js'
import { getGeminiKey } from '../firebase.js'
import { isClockTime, sortMealsByTime } from '../data/mealTime.js'
import { SICK_NOTE_MAX, SICK_SYMPTOMS, isHighRiskSick, sanitizeSick, sickLabels } from '../data/sickDay.js'

const props = defineProps({
  day: { type: Object, required: true },
  // Follow-up lab records (App state); gemini.js sanitizes them into the LAB DATA prompt block.
  labs: { type: Array, default: () => [] },
})
const emit = defineEmits(['update', 'open-settings'])
const showToast = inject('showToast', () => {})

// ---------- helpers ----------
const clone = (o) => JSON.parse(JSON.stringify(o))
function commit(mutator) {
  const next = clone(props.day)
  mutator(next)
  emit('update', next)
}
function nowTime() {
  return new Date().toTimeString().slice(0, 5)
}
function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// ---------- undo snackbar (one-tap adds) ----------
// Only the most recent one-tap action can be undone; the bar disappears after ~6 s, when the
// selected date changes, or when the component unmounts. The undo is bound to the date it was made on.
const UNDO_MS = 6000
const undoBar = ref(null) // { key, text, date, undo }
let undoTimer = null
function dismissUndo() {
  clearTimeout(undoTimer)
  undoTimer = null
  undoBar.value = null
}
function offerUndo(text, undo) {
  clearTimeout(undoTimer)
  undoBar.value = { key: uid('undo'), text, date: props.day.date, undo }
  undoTimer = setTimeout(dismissUndo, UNDO_MS)
}
function runUndo() {
  const u = undoBar.value
  dismissUndo()
  if (!u || u.date !== props.day.date || typeof u.undo !== 'function') return
  u.undo()
}
watch(() => props.day.date, dismissUndo)
onBeforeUnmount(dismissUndo)

// ---------- sick day (身體不適) ----------
const sickInfo = computed(() => sanitizeSick(props.day.sick))
const sickHighRisk = computed(() => isHighRiskSick(props.day.sick))
const sickEditing = ref(false)
const sickForm = reactive({ symptoms: [], note: '' })
const sickError = ref('')
function openSickEditor() {
  const cur = sickInfo.value
  sickForm.symptoms = cur ? [...cur.symptoms] : []
  sickForm.note = cur ? cur.note : ''
  sickError.value = ''
  sickEditing.value = true
}
function toggleSickSymptom(key) {
  const i = sickForm.symptoms.indexOf(key)
  if (i >= 0) sickForm.symptoms.splice(i, 1)
  else sickForm.symptoms.push(key)
}
function saveSick() {
  const rec = sanitizeSick({ symptoms: sickForm.symptoms, note: sickForm.note, time: sickInfo.value?.time || nowTime() })
  if (!rec) {
    sickError.value = '請至少選擇一個症狀，或在「其他」填寫說明。'
    return
  }
  if (sickForm.symptoms.includes('other') && !rec.note) {
    sickError.value = '選擇「其他」時請簡短說明症狀。'
    return
  }
  commit((d) => {
    d.sick = rec
  })
  sickEditing.value = false
}
function clearSick() {
  if (!window.confirm('確定要清除今天的身體不適紀錄？')) return
  commit((d) => {
    delete d.sick
  })
  sickEditing.value = false
}
watch(() => props.day.date, () => {
  sickEditing.value = false
})

// ---------- hydration & drinks ----------
const TARGETS = computed(() => live.targets)
const drinks = computed(() => props.day.drinks || [])
const drinksTotalCc = computed(() => drinks.value.reduce((sum, d) => sum + (Number(d.volume_cc) || 0), 0))
const drinkWaterCc = computed(() =>
  drinks.value.reduce((sum, d) => sum + (d.counts_as_water ? Number(d.volume_cc) || 0 : 0), 0),
)
const effectiveWaterCc = computed(() => Math.max(0, Number(props.day.hydration_cc) || 0))
const pureWaterCc = computed(() => Math.max(0, effectiveWaterCc.value - drinkWaterCc.value))
const totalFluidCc = computed(() => pureWaterCc.value + drinksTotalCc.value)
const hydrationMinPct = computed(() => (TARGETS.value.hydrationMin / (TARGETS.value.hydrationMax || 1)) * 100)
const hydrationReached = computed(() => effectiveWaterCc.value >= TARGETS.value.hydrationMin)
const hydrationBar = computed(() => {
  const max = TARGETS.value.hydrationMax || 1
  const pure = pureWaterCc.value
  const drink = drinkWaterCc.value
  const sum = pure + drink
  const cap = Math.min(sum, max)
  const purePart = sum > 0 ? (pure / sum) * cap : 0
  return {
    purePct: (purePart / max) * 100,
    drinkPct: ((cap - purePart) / max) * 100,
  }
})

const HYDRATION_PATTERN = {
  'front-loaded': '偏前段',
  'back-loaded': '偏後段',
  optimal: '分配適當',
}
const hydrationAdvice = ref('')
const hydrationPattern = ref('')
const hydrationAdviceLoading = ref(false)
const hydrationAdviceError = ref('')

function addWater(cc) {
  let applied = 0
  commit((d) => {
    const before = Math.max(0, Number(d.hydration_cc) || 0)
    d.hydration_cc = Math.max(0, before + cc)
    applied = d.hydration_cc - before // actual change after clamping at 0
  })
  if (!applied) return
  offerUndo(applied > 0 ? `已記錄 純水 +${applied}cc` : `已扣除 純水 ${applied}cc`, () => {
    commit((d) => {
      const cur = Math.max(0, Number(d.hydration_cc) || 0)
      // Reverse exactly the applied amount (never below 0 if the value changed meanwhile).
      d.hydration_cc = Math.max(0, cur - applied)
    })
  })
}

const waterInputCc = ref(300)
const waterError = ref('')

function logCustomWater() {
  waterError.value = ''
  const cc = Math.round(Number(waterInputCc.value))
  if (!Number.isFinite(cc) || cc < 1) {
    waterError.value = '請輸入 1 cc 以上的純水量。'
    return
  }
  addWater(cc)
}

async function askHydrationSchedule() {
  hydrationAdviceError.value = ''
  const apiKey = getGeminiKey()
  if (!apiKey) {
    hydrationAdviceError.value = '尚未設定 Gemini API Key。'
    emit('open-settings')
    return
  }
  hydrationAdviceLoading.value = true
  try {
    const res = await analyzeHydrationSchedule({
      apiKey,
      currentWater: effectiveWaterCc.value,
      targetMin: TARGETS.value.hydrationMin,
      targetMax: TARGETS.value.hydrationMax,
      drinks: drinks.value,
      currentTime: nowTime(),
      labs: props.labs,
      sick: props.day.sick || null,
    })
    hydrationPattern.value = HYDRATION_PATTERN[res.pattern] || ''
    hydrationAdvice.value = String(res.advice || '').trim()
  } catch (err) {
    hydrationAdvice.value = ''
    hydrationPattern.value = ''
    hydrationAdviceError.value = err.message || String(err)
  } finally {
    hydrationAdviceLoading.value = false
  }
}

const drinkForm = reactive({ name: '', volume_cc: 350, counts_as_water: true, note: '' })
const drinkEditMode = ref(false)
const drinkManageError = ref('')
const newDrinkPreset = reactive({ name: '', default_cc: 350, counts_as_water: true })

function applyDrinkPreset(p) {
  drinkForm.name = p.name
  drinkForm.volume_cc = p.default_cc || 350
  drinkForm.counts_as_water = Boolean(p.counts_as_water)
}

function addDrinkLog() {
  drinkManageError.value = ''
  const name = drinkForm.name.trim()
  const vol = Number(drinkForm.volume_cc) || 0
  if (!name) {
    drinkManageError.value = '請輸入或選擇飲品名稱。'
    return
  }
  if (vol <= 0) {
    drinkManageError.value = '請輸入有效的容量 (cc)。'
    return
  }
  commit((d) => {
    d.drinks = d.drinks || []
    d.drinks.push({
      id: `drk-${Date.now()}`,
      time: nowTime(),
      name,
      volume_cc: vol,
      counts_as_water: Boolean(drinkForm.counts_as_water),
      note: drinkForm.note.trim(),
    })
    if (drinkForm.counts_as_water) {
      d.hydration_cc = Math.max(0, (d.hydration_cc || 0) + vol)
    }
  })
  drinkForm.name = ''
  drinkForm.note = ''
}

function removeDrinkLog(id) {
  commit((d) => {
    const list = d.drinks || []
    const target = list.find((x) => x.id === id)
    if (target && target.counts_as_water && target.volume_cc) {
      d.hydration_cc = Math.max(0, (d.hydration_cc || 0) - Number(target.volume_cc))
    }
    d.drinks = list.filter((x) => x.id !== id)
  })
}

function onDrinkPresetEdit(id, field, val) {
  drinkManageError.value = ''
  const list = clone(live.drinkPresets)
  const item = list.find((x) => x.id === id)
  if (!item) return
  if (field === 'name') {
    const v = String(val).trim()
    if (!v) {
      drinkManageError.value = '飲品名稱不可空白。'
      return
    }
    item.name = v
  } else if (field === 'default_cc') {
    item.default_cc = Math.max(0, Number(val) || 0)
  } else if (field === 'counts_as_water') {
    item.counts_as_water = Boolean(val)
  }
  updateCustom('drinkPresets', list)
}

function addDrinkPreset() {
  drinkManageError.value = ''
  const name = newDrinkPreset.name.trim()
  if (!name) {
    drinkManageError.value = '請輸入快選飲品名稱。'
    return
  }
  const list = clone(live.drinkPresets)
  list.push({
    id: `drk-${Date.now()}`,
    name,
    default_cc: Math.max(0, Number(newDrinkPreset.default_cc) || 350),
    counts_as_water: Boolean(newDrinkPreset.counts_as_water),
  })
  updateCustom('drinkPresets', list)
  newDrinkPreset.name = ''
  newDrinkPreset.default_cc = 350
  newDrinkPreset.counts_as_water = true
}

function deleteDrinkPreset(id) {
  updateCustom('drinkPresets', live.drinkPresets.filter((x) => x.id !== id))
}

function resetDrinkPresets() {
  if (!window.confirm('確定要恢復預設飲品快選清單？')) return
  resetCustom(['drinkPresets'])
  drinkManageError.value = ''
}

// ---------- medications ----------
function toggleMed(slot, id) {
  commit((d) => {
    d.meds ||= {}
    d.meds[slot] ||= {}
    d.meds[slot][id] = !d.meds[slot][id]
  })
}
const medDone = computed(() => {
  let done = 0
  let total = 0
  for (const slot of ['morning', 'evening']) {
    for (const m of medsForSlot(slot)) {
      total++
      if (props.day.meds?.[slot]?.[m.id]) done++
    }
  }
  return { done, total }
})

// ---------- exercise & exercise type presets ----------
// Every log stores duration_min = walking-equivalent minutes (counts toward the target), plus
// actual_min, factor and a reference-only kcal estimate. Reps are turned into minutes with the
// type's pace (repsPerMin), so charts and daily totals stay in minutes.

function isRepsLog(log) {
  return !!(log && (log.mode === 'reps' || Number(log.reps) > 0))
}

const exerciseForm = reactive({
  type: live.exerciseTypes[0] || '餐後踏步',
  duration: 20,
  note: '',
  mode: 'duration',
  reps: 50,
  sets: 3,
})
const currentProfile = computed(() => exerciseProfile(exerciseForm.type))
const currentFactor = computed(() => currentProfile.value.factor)
const repsActualPreview = computed(() =>
  repsToMinutes(exerciseForm.reps, exerciseForm.sets, currentProfile.value.repsPerMin),
)
const repsDurationPreview = computed(() => equivalentMinutes(repsActualPreview.value, currentFactor.value))
const durationEquivalent = computed(() => equivalentMinutes(exerciseForm.duration, currentFactor.value))
const kcalPreview = computed(() =>
  exerciseKcal(
    currentProfile.value.met,
    live.targets.userWeight,
    exerciseForm.mode === 'reps' ? repsActualPreview.value : Number(exerciseForm.duration) || 0,
  ),
)
const exerciseKcalTotal = computed(() =>
  (props.day.exercise_logs || []).reduce((sum, x) => sum + (Number(x?.kcal) || 0), 0),
)

function selectExerciseType(type) {
  exerciseForm.type = type
  exerciseForm.mode = exerciseProfile(type).mode
}

function setExerciseMode(mode) {
  exerciseForm.mode = mode === 'reps' ? 'reps' : 'duration'
}

function bumpReps(amount) {
  exerciseForm.reps = Math.max(0, (Number(exerciseForm.reps) || 0) + amount)
}

watch(
  () => exerciseForm.type,
  (type) => {
    exerciseForm.mode = exerciseProfile(type).mode
  },
)
const exerciseEditMode = ref(false)
const exerciseManageError = ref('')
const newExerciseType = ref('')

function syncExerciseTotal(d) {
  d.exercise_logs = d.exercise_logs || []
  d.exercise_min = d.exercise_logs.reduce((sum, item) => sum + (Number(item.duration_min) || 0), 0)
}

function addExerciseLog(quickMin = null) {
  exerciseManageError.value = ''
  const type = (exerciseForm.type || '').trim() || '餐後踏步'
  const repsMode = quickMin == null && exerciseForm.mode === 'reps'
  const profile = exerciseProfile(type)
  const weight = live.targets.userWeight
  let entry
  if (repsMode) {
    const reps = Math.round(Number(exerciseForm.reps) || 0)
    const sets = Math.max(1, Math.round(Number(exerciseForm.sets) || 1))
    if (reps <= 0) {
      exerciseManageError.value = '請輸入大於 0 的次數。'
      return
    }
    const actual = repsToMinutes(reps, sets, profile.repsPerMin)
    entry = {
      id: uid('ex'),
      time: nowTime(),
      type,
      mode: 'reps',
      duration_min: equivalentMinutes(actual, profile.factor),
      actual_min: actual,
      factor: profile.factor,
      met: profile.met,
      kcal: exerciseKcal(profile.met, weight, actual),
      reps,
      sets,
      note: exerciseForm.note.trim(),
      source: 'manual',
    }
  } else {
    const dMin = Number(quickMin != null ? quickMin : exerciseForm.duration)
    if (!dMin || dMin <= 0) {
      exerciseManageError.value = '請輸入大於 0 的運動分鐘數。'
      return
    }
    entry = {
      id: uid('ex'),
      time: nowTime(),
      type,
      mode: 'duration',
      duration_min: equivalentMinutes(dMin, profile.factor),
      actual_min: dMin,
      factor: profile.factor,
      met: profile.met,
      kcal: exerciseKcal(profile.met, weight, dMin),
      note: exerciseForm.note.trim(),
      source: 'manual',
    }
  }
  commit((d) => {
    // Migrate legacy single number if logs array was previously empty
    if ((!d.exercise_logs || !d.exercise_logs.length) && d.exercise_min > 0) {
      d.exercise_logs = [
        {
          id: `ex-legacy-${Date.now() - 1}`,
          time: '先前',
          type: '餐後踏步',
          mode: 'duration',
          duration_min: Number(d.exercise_min),
          note: '既有紀錄',
          source: 'manual',
        },
      ]
    }
    d.exercise_logs = d.exercise_logs || []
    d.exercise_logs.push(entry)
    syncExerciseTotal(d)
  })
  exerciseForm.note = ''
  const amount = entry.mode === 'reps' ? `${entry.reps} 下 × ${entry.sets} 組` : `${entry.actual_min} 分`
  const entryId = entry.id
  offerUndo(`已記錄 ${entry.type} ${amount}`, () => {
    // Remove exactly that entry (by its unique id); no-op if it was already deleted.
    if (!(props.day.exercise_logs || []).some((x) => x && x.id === entryId)) return
    removeExerciseLog(entryId)
  })
}

function removeExerciseLog(id) {
  commit((d) => {
    d.exercise_logs = (d.exercise_logs || []).filter((x) => x.id !== id)
    syncExerciseTotal(d)
  })
}

function clearExerciseLogs() {
  if (!window.confirm('確定要清空當日所有運動紀錄？')) return
  commit((d) => {
    d.exercise_logs = []
    d.exercise_min = 0
  })
}

function addExerciseTypePreset() {
  exerciseManageError.value = ''
  const t = newExerciseType.value.trim()
  if (!t) return
  if (live.exerciseTypes.includes(t)) {
    exerciseManageError.value = '此運動類型已存在。'
    return
  }
  updateCustom('exerciseTypes', [...live.exerciseTypes, t])
  exerciseForm.type = t
  newExerciseType.value = ''
  // New type: ask AI right away when a key is set; otherwise the name-based guess applies.
  if (getGeminiKey()) askProfileSuggestion(t)
}

function deleteExerciseTypePreset(t) {
  const next = live.exerciseTypes.filter((x) => x !== t)
  updateCustom('exerciseTypes', next)
  if (exerciseForm.type === t) {
    exerciseForm.type = next[0] || '餐後踏步'
  }
}

// AI suggestions for exercise types: [{ type, busy, error, mode, repsPerMin, factor, met, reason }].
// Nothing is saved until the user presses 採用.
const profileSuggestions = ref([])
const evaluatingAll = ref(false)

async function askProfileSuggestion(t) {
  const apiKey = getGeminiKey()
  if (!apiKey) {
    exerciseManageError.value = '尚未設定 Gemini API Key。'
    emit('open-settings')
    return
  }
  const item = reactive({ type: t, busy: true, error: '' })
  profileSuggestions.value = [...profileSuggestions.value.filter((s) => s.type !== t), item]
  try {
    const p = exerciseProfile(t)
    const recent = (props.day.exercise_logs || []).filter((e) => e && e.type === t)
    const current = { mode: p.mode, repsPerMin: p.repsPerMin, factor: p.factor, met: p.metEstimated ? null : p.met }
    Object.assign(item, await suggestExerciseProfile({ apiKey, type: t, current, recent }))
  } catch (err) {
    item.error = err.message || String(err)
  } finally {
    item.busy = false
  }
}

async function evaluateAllTypes() {
  if (!getGeminiKey()) return askProfileSuggestion(live.exerciseTypes[0])
  evaluatingAll.value = true
  try {
    for (const t of [...live.exerciseTypes]) await askProfileSuggestion(t)
  } finally {
    evaluatingAll.value = false
  }
}

function adoptProfileSuggestion(s) {
  if (s.busy || s.error) return
  setExerciseProfile(s.type, { mode: s.mode, repsPerMin: s.repsPerMin, met: s.met })
  setExerciseFactor(s.type, s.factor)
  dismissProfileSuggestion(s)
}

function adoptAllSuggestions() {
  for (const s of [...profileSuggestions.value]) adoptProfileSuggestion(s)
}

function dismissProfileSuggestion(s) {
  profileSuggestions.value = profileSuggestions.value.filter((x) => x !== s)
}

const MODE_LABEL = { reps: '次數', duration: '時間' }

function setExerciseProfile(t, patch) {
  if (patch.repsPerMin != null && !(Number(patch.repsPerMin) >= 1 && Number(patch.repsPerMin) <= 200)) {
    exerciseManageError.value = '每分鐘次數請填 1 ～ 200。'
    return
  }
  if (patch.met != null && patch.met !== '' && !(Number(patch.met) >= 1 && Number(patch.met) <= 20)) {
    exerciseManageError.value = 'MET 請填 1 ～ 20（散步約 3.5）。'
    return
  }
  exerciseManageError.value = ''
  const next = { ...(live.exerciseProfiles[t] || {}), ...patch }
  if (patch.met === '') delete next.met // cleared -> estimate from the factor again
  updateCustom('exerciseProfiles', { ...live.exerciseProfiles, [t]: next })
  if (exerciseForm.type === t) exerciseForm.mode = exerciseProfile(t).mode
}

function setExerciseFactor(t, value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0.1 || n > 5) {
    exerciseManageError.value = '換算係數請填 0.1 ～ 5（1 = 與散步相同）。'
    return
  }
  exerciseManageError.value = ''
  updateCustom('exerciseFactors', { ...live.exerciseFactors, [t]: n })
}

function resetExerciseTypePresets() {
  if (!window.confirm('確定要恢復預設運動類型快選、記錄方式與換算係數？')) return
  resetCustom(['exerciseTypes', 'exerciseFactors', 'exerciseProfiles'])
  exerciseForm.type = live.exerciseTypes[0] || '餐後踏步'
  exerciseManageError.value = ''
}

const exerciseReached = computed(() => (props.day.exercise_min || 0) >= TARGETS.value.exerciseTarget)

// ---------- meal input ----------
const mealText = ref('')
const mealTime = ref('') // HH:MM the meal was eaten; '' = now
const selectedTags = ref([])
const photos = ref([]) // [{ id, mimeType, data, preview }] compressed JPEGs, max MAX_MEAL_IMAGES
const photoPending = ref(0) // photos still being decoded/compressed
let photoGeneration = 0 // bumped on form reset so late results are discarded
const busy = ref(false)
const elapsed = ref(0)
const error = ref('')
const latestId = ref(null)
let elapsedTimer = null
function startBusy() {
  busy.value = true
  elapsed.value = 0
  clearInterval(elapsedTimer)
  elapsedTimer = setInterval(() => {
    elapsed.value += 1
  }, 1000)
}
function stopBusy() {
  busy.value = false
  clearInterval(elapsedTimer)
  elapsedTimer = null
}
onBeforeUnmount(stopBusy)

function applyPreset(p) {
  mealText.value = p.description
}
function toggleTag(t) {
  const i = selectedTags.value.indexOf(t)
  if (i >= 0) selectedTags.value.splice(i, 1)
  else selectedTags.value.push(t)
}

// ---------- preset / tag manager ----------
const editMode = ref(false)
const manageError = ref('')
const newPreset = reactive({ category: '', label: '', description: '' })
const newTag = ref('')

function onPresetEdit(id, field, e) {
  manageError.value = ''
  const list = clone(live.presets)
  const p = list.find((x) => x.id === id)
  if (!p) return
  let value = e.target.value.trim()
  if (field === 'label' && !value) {
    manageError.value = '按鈕名稱不可空白。'
    e.target.value = p.label
    return
  }
  if (field === 'category' && !value) value = '自訂'
  p[field] = value
  updateCustom('presets', list)
}

function deletePreset(id) {
  manageError.value = ''
  updateCustom('presets', live.presets.filter((p) => p.id !== id))
}

function addPreset() {
  manageError.value = ''
  const label = newPreset.label.trim()
  const description = newPreset.description.trim()
  if (!label || !description) {
    manageError.value = '請填寫按鈕名稱與完整餐點描述。'
    return
  }
  const list = clone(live.presets)
  list.push({
    id: `custom-${Date.now()}`,
    category: newPreset.category.trim() || '自訂',
    label,
    description,
  })
  updateCustom('presets', list)
  newPreset.category = newPreset.label = newPreset.description = ''
}

function deleteTag(t) {
  updateCustom('tags', live.tags.filter((x) => x !== t))
  selectedTags.value = selectedTags.value.filter((x) => x !== t)
}

function addTag() {
  manageError.value = ''
  let t = newTag.value.trim()
  if (!t) return
  if (!/^\[.*\]$/.test(t)) t = `[${t}]`
  if (live.tags.includes(t)) {
    manageError.value = '此標籤已存在。'
    return
  }
  updateCustom('tags', [...live.tags, t])
  newTag.value = ''
}

function resetMenu() {
  if (!window.confirm('確定要恢復預設菜單？\n自訂的快選按鈕與修飾標籤都會被移除。')) return
  resetCustom(['presets', 'tags'])
  selectedTags.value = []
  manageError.value = ''
}

function saveAsPreset() {
  error.value = ''
  const text = mealText.value.trim()
  if (!text) {
    error.value = '請先在下方輸入餐點描述，再存為常吃快選。'
    return
  }
  const label = window.prompt('快選按鈕名稱 (簡短)', text.slice(0, 8))
  if (label === null) return
  if (!label.trim()) {
    error.value = '快選名稱不可空白。'
    return
  }
  const cats = presetCategories.value
  const category = window.prompt(
    `分類 (${cats.join(' / ')}，或輸入新分類)`,
    cats.includes('外食') ? '外食' : cats[0] || '自訂',
  )
  if (category === null) return
  const list = clone(live.presets)
  list.push({
    id: `custom-${Date.now()}`,
    category: category.trim() || '自訂',
    label: label.trim(),
    description: text,
  })
  updateCustom('presets', list)
}

const MAX_PHOTO_BYTES = 15 * 1024 * 1024 // raw file limit before compression
const PHOTO_TYPE_RE = /^image\/(jpeg|png|webp|gif|bmp|heic|heif|avif)$/i
const PHOTO_EXT_RE = /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i

/** Decode via a temporary object URL (always revoked), resize to max 1024px, re-encode as JPEG 0.8. */
function compressPhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      try {
        const max = 1024
        const scale = Math.min(1, max / Math.max(img.width, img.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(img.width * scale))
        canvas.height = Math.max(1, Math.round(img.height * scale))
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8)
        resolve({ mimeType: 'image/jpeg', data: dataUrl.split(',')[1], preview: dataUrl })
      } catch (err) {
        reject(err)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('decode failed'))
    }
    img.src = url
  })
}

function onPhoto(e) {
  const files = Array.from(e.target.files || [])
  e.target.value = '' // allow re-selecting the same file
  if (!files.length) return
  error.value = ''
  const problems = []
  const free = MAX_MEAL_IMAGES - photos.value.length - photoPending.value
  if (free <= 0) {
    error.value = `每餐最多 ${MAX_MEAL_IMAGES} 張照片。`
    return
  }
  const valid = files.filter((f) => {
    const typeOk = PHOTO_TYPE_RE.test(f.type) || (!f.type && PHOTO_EXT_RE.test(f.name || ''))
    if (!typeOk) problems.push('僅支援 JPEG / PNG / WebP / HEIC 等圖片檔。')
    else if (f.size > MAX_PHOTO_BYTES) problems.push('單張照片需小於 15 MB。')
    return typeOk && f.size <= MAX_PHOTO_BYTES
  })
  if (valid.length > free) problems.push(`每餐最多 ${MAX_MEAL_IMAGES} 張照片，多出的已略過。`)
  const gen = photoGeneration
  for (const file of valid.slice(0, free)) {
    photoPending.value += 1
    compressPhoto(file)
      .then((p) => {
        if (gen !== photoGeneration || photos.value.length >= MAX_MEAL_IMAGES) return
        photos.value = [...photos.value, { id: `ph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...p }]
      })
      .catch(() => {
        if (gen === photoGeneration) error.value = '有照片無法讀取，請改用 JPEG / PNG 再試一次。'
      })
      .finally(() => {
        if (gen === photoGeneration) photoPending.value = Math.max(0, photoPending.value - 1)
      })
  }
  if (problems.length) error.value = [...new Set(problems)].join(' ')
}

function removePhoto(id) {
  photos.value = photos.value.filter((p) => p.id !== id)
}

function resetMealForm() {
  mealText.value = ''
  mealTime.value = ''
  selectedTags.value = []
  photos.value = []
  photoPending.value = 0
  photoGeneration += 1
}

async function submitMeal(withAI) {
  error.value = ''
  if (photoPending.value > 0) {
    error.value = '照片處理中，請稍候再送出。'
    return
  }
  if (!mealText.value.trim() && !photos.value.length) {
    error.value = '請輸入餐點內容、選擇預設或上傳照片。'
    return
  }
  if (mealTime.value && !isClockTime(mealTime.value)) {
    error.value = '用餐時間格式不正確。'
    return
  }
  const id = `${Date.now()}`
  const entry = {
    id,
    time: mealTime.value || nowTime(),
    text: mealText.value.trim(),
    tags: [...selectedTags.value],
    analysis: null,
  }
  if (withAI) {
    const apiKey = getGeminiKey()
    if (!apiKey) {
      error.value = '尚未設定 Gemini API Key。'
      emit('open-settings')
      return
    }
    startBusy()
    try {
      const { date, ...ctx } = summarizeDay(props.day, { beforeTime: entry.time })
      entry.analysis = await analyzeMeal({
        apiKey,
        mealTime: entry.time,
        text: entry.text,
        tags: entry.tags,
        images: photos.value.map((p) => ({ mimeType: p.mimeType, data: p.data })),
        dayContext: ctx,
        labs: props.labs,
      })
    } catch (err) {
      const msg = err.message || String(err)
      error.value = msg
      showToast(msg)
      stopBusy()
      return
    }
    stopBusy()
  }
  commit((d) => {
    d.meals.push(entry)
    d.ai_summary = null
    // Auto-sync exercise if meal modifier tag '[餐後踏步 20分]' is checked
    if (entry.tags.includes('[餐後踏步 20分]')) {
      d.exercise_logs = d.exercise_logs || []
      d.exercise_logs.push({
        id: `ex-meal-${Date.now()}`,
        time: entry.time,
        type: '餐後踏步',
        mode: 'duration',
        duration_min: 20,
        note: `來自餐點「${entry.analysis?.meal_name || entry.text.slice(0, 12) || '餐點'}」標籤連動`,
        source: 'meal_tag',
        meal_id: entry.id, // removed together with the meal (removeMeal)
      })
      syncExerciseTotal(d)
    }
  })
  latestId.value = withAI ? id : null
  resetMealForm()
}

function removeMeal(id) {
  commit((d) => {
    const meal = (d.meals || []).find((m) => m.id === id)
    d.meals = (d.meals || []).filter((m) => m.id !== id)
    d.ai_summary = null
    // Remove the exercise auto-added by this meal's '[餐後踏步 20分]' tag, so deleting the meal
    // does not leave a phantom 20-min exercise. Legacy links (no meal_id) match on time + meal name.
    const logs = d.exercise_logs || []
    const name = meal ? meal.analysis?.meal_name || (meal.text || '').slice(0, 12) || '餐點' : null
    const linked = (x) =>
      x &&
      x.source === 'meal_tag' &&
      (x.meal_id === id || (!x.meal_id && meal && x.time === meal.time && String(x.note || '').includes(`「${name}」`)))
    if (logs.some(linked)) {
      d.exercise_logs = logs.filter((x) => !linked(x))
      syncExerciseTotal(d)
    }
  })
  if (latestId.value === id) latestId.value = null
}

const mealsSorted = computed(() => sortMealsByTime(props.day.meals))

const mealToShow = computed(() => {
  const meals = props.day.meals || []
  return (
    meals.find((m) => m.id === latestId.value) ||
    [...meals].reverse().find((m) => m.analysis) ||
    null
  )
})

// ---------- End-of-day AI summary ----------
const summaryBusy = ref(false)
const summaryError = ref('')
async function runDaySummary() {
  summaryError.value = ''
  const apiKey = getGeminiKey()
  if (!apiKey) {
    summaryError.value = '尚未設定 Gemini API Key。'
    emit('open-settings')
    return
  }
  if (!(props.day.meals || []).length) {
    summaryError.value = '請先記錄至少一餐。'
    return
  }
  summaryBusy.value = true
  try {
    const result = await summarizeDayAI({
      apiKey,
      totals: summarizeDay(props.day),
      meals: sortMealsByTime(props.day.meals).map((m) => ({
        time: m.time,
        name: m.analysis?.meal_name || m.text,
        tags: m.tags,
        analyzed: !!m.analysis,
      })),
      meds: props.day.meds,
      labs: props.labs,
    })
    commit((d) => {
      d.ai_summary = result
    })
  } catch (err) {
    summaryError.value = err.message || String(err)
    showToast(summaryError.value)
  } finally {
    summaryBusy.value = false
  }
}

const ALERTS = [
  { key: 'glycemic_tg_alert', title: '血糖 / 三酸甘油酯' },
  { key: 'ldl_saturated_fat_alert', title: 'LDL / 飽和脂肪' },
  { key: 'renal_hydration_alert', title: '腎臟 / 水分鈉量' },
  { key: 'sglt2_ketone_safety_alert', title: 'SGLT-2 酮酸安全' },
]
const LEVEL_STYLE = {
  green: 'bg-emerald-50 border-emerald-300 text-emerald-900',
  yellow: 'bg-amber-50 border-amber-300 text-amber-900',
  red: 'bg-rose-50 border-rose-300 text-rose-900',
}
const DOT_STYLE = { green: 'bg-emerald-500', yellow: 'bg-amber-400', red: 'bg-rose-500' }
const LEVEL_TEXT = { green: '綠燈', yellow: '黃燈', red: '紅燈' }

const totals = computed(() => summarizeDay(props.day))
const presetGroups = computed(() => {
  const g = {}
  for (const p of live.presets) (g[p.category] ||= []).push(p)
  return g
})
const presetCategories = computed(() => [...new Set(live.presets.map((p) => p.category))])
</script>

<template>
  <div class="space-y-4">
    <!-- Sick day (身體不適) -->
    <section
      class="rounded-2xl p-4 shadow-sm ring-1"
      :class="sickInfo ? 'bg-rose-50 ring-rose-200' : 'bg-white ring-slate-200'"
      data-testid="sick-section"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="font-semibold text-slate-800">{{ sickInfo ? '🤒 身體不適紀錄' : '🩺 身體狀況' }}</h2>
        <div class="flex gap-2">
          <button
            v-if="!sickInfo && !sickEditing"
            type="button"
            class="min-h-11 rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white active:bg-rose-700"
            data-testid="sick-open"
            @click="openSickEditor"
          >
            🤒 今天不舒服
          </button>
          <template v-else-if="sickInfo && !sickEditing">
            <button type="button" class="min-h-11 rounded-xl bg-white px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-200" @click="openSickEditor">✏️ 編輯</button>
            <button type="button" class="min-h-11 rounded-xl bg-white px-3 py-2 text-sm text-slate-600 ring-1 ring-slate-200" data-testid="sick-clear" @click="clearSick">已好轉，清除</button>
          </template>
        </div>
      </div>

      <div v-if="sickEditing" class="mt-3 space-y-3" data-testid="sick-editor">
        <p class="text-xs text-slate-500">選擇目前的症狀（可複選）：</p>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="sym in SICK_SYMPTOMS"
            :key="sym.key"
            type="button"
            class="min-h-11 rounded-full border px-4 py-2 text-sm"
            :class="sickForm.symptoms.includes(sym.key) ? 'border-rose-600 bg-rose-600 text-white font-medium' : 'border-slate-300 bg-white text-slate-700'"
            :aria-pressed="sickForm.symptoms.includes(sym.key)"
            @click="toggleSickSymptom(sym.key)"
          >
            {{ sym.label }}
          </button>
        </div>
        <input
          v-model="sickForm.note"
          type="text"
          :maxlength="SICK_NOTE_MAX"
          placeholder="補充說明（選擇「其他」時必填，例如：頭暈、喉嚨痛）"
          class="w-full rounded-lg border border-slate-300 p-2 text-sm text-slate-800"
          data-testid="sick-note"
        />
        <p v-if="sickError" class="text-xs text-rose-600" role="alert">{{ sickError }}</p>
        <div class="flex gap-2">
          <button type="button" class="min-h-11 flex-1 rounded-xl bg-rose-600 py-2 text-sm font-semibold text-white active:bg-rose-700" data-testid="sick-save" @click="saveSick">儲存</button>
          <button type="button" class="min-h-11 rounded-xl bg-slate-100 px-4 py-2 text-sm text-slate-600" @click="sickEditing = false">取消</button>
        </div>
      </div>

      <div v-if="sickInfo && !sickEditing" class="mt-2 text-sm text-rose-900" data-testid="sick-summary">
        <p>
          症狀：<b>{{ sickLabels(sickInfo).join('、') }}</b><span v-if="sickInfo.time" class="text-xs text-rose-700"> · {{ sickInfo.time }}</span>
        </p>
        <p v-if="sickInfo.note" class="mt-0.5 break-words">說明：{{ sickInfo.note }}</p>
      </div>

      <div
        v-if="sickInfo"
        class="mt-3 rounded-xl border p-3 text-sm leading-relaxed"
        :class="sickHighRisk ? 'border-rose-300 bg-white text-rose-950' : 'border-amber-300 bg-white text-amber-950'"
        role="note"
        data-testid="sick-safety-card"
      >
        <p class="font-semibold">⚠️ 身體不適日（Sick day）注意事項 · 一般衛教資訊</p>
        <ul class="mt-1 ml-5 list-disc space-y-0.5">
          <li>服用 SGLT-2 抑制劑期間，嘔吐、腹瀉、發燒、吃不下或大量飲酒會增加脫水及「血糖正常的酮酸中毒（euDKA）」風險，即使血糖不高也可能發生。</li>
          <li>一般建議少量多次補充水分；若吃得下，維持少量容易消化的含醣食物，避免空腹或禁食。</li>
          <li><b>請聯絡您的醫師，詢問是否需要暫停 SGLT-2 抑制劑</b>（以及其他藥物）、何時恢復；本 App 不提供停藥或調整劑量的指示。</li>
          <li><b>若出現噁心／嘔吐、腹痛、呼吸困難或呼吸急促、嗜睡或意識不清，請立即就醫（急診）。</b></li>
        </ul>
        <p class="mt-1 text-xs opacity-80">此紀錄會同步到雲端，並提供給 AI 分析與回診報告參考。</p>
      </div>
    </section>

    <!-- Hydration & Drinks -->
    <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <div class="flex items-start justify-between gap-2">
        <div>
          <div class="flex items-center gap-2">
            <h2 class="font-semibold text-slate-800">💧 飲水與飲品紀錄</h2>
            <label class="flex items-center text-xs text-slate-500">
              ⚖️ 體重
              <input
                type="number"
                min="20"
                max="250"
                step="0.5"
                inputmode="decimal"
                v-model.lazy="live.targets.userWeight"
                @change="updateCustom('targets', live.targets)"
                class="mx-1 w-14 rounded border border-slate-300 bg-slate-50 p-0.5 text-center text-xs text-slate-800 focus:bg-white"
              />
              kg
            </label>
          </div>
          <p class="mt-0.5 text-xs" :class="hydrationReached ? 'text-emerald-600 font-semibold' : 'text-slate-500'">
            有效水分 {{ effectiveWaterCc }} / {{ TARGETS.hydrationMin }}-{{ TARGETS.hydrationMax }} cc
          </p>
          <p class="mt-0.5 text-xs text-slate-500">
            總液體 {{ totalFluidCc }} cc · 純水 {{ pureWaterCc }} cc · 飲品 {{ drinksTotalCc }} cc
          </p>
        </div>
        <button
          class="shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium"
          :class="drinkEditMode ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-700 active:bg-slate-200'"
          @click="drinkEditMode = !drinkEditMode"
        >
          {{ drinkEditMode ? '✓ 完成編輯' : '⚙️ 編輯飲品快選' }}
        </button>
      </div>

      <div class="relative mt-3 h-4 overflow-hidden rounded-full bg-slate-100">
        <div class="absolute inset-y-0 left-0 bg-sky-500" :style="{ width: hydrationBar.purePct + '%' }" />
        <div
          class="absolute inset-y-0 bg-teal-400"
          :style="{ left: hydrationBar.purePct + '%', width: hydrationBar.drinkPct + '%' }"
        />
        <div class="absolute inset-y-0 w-0.5 bg-slate-400/70" :style="{ left: hydrationMinPct + '%' }" />
      </div>
      <p class="mt-1 flex flex-wrap gap-3 text-[11px] text-slate-400">
        <span class="inline-flex items-center gap-1"><span class="inline-block size-2 rounded-sm bg-sky-500" />純水</span>
        <span class="inline-flex items-center gap-1"><span class="inline-block size-2 rounded-sm bg-teal-400" />計水飲品</span>
        <span>灰線為下限</span>
      </p>

      <div class="mt-3 space-y-2">
        <div class="flex gap-2">
          <input
            v-model="waterInputCc"
            type="number"
            min="1"
            step="10"
            inputmode="numeric"
            placeholder="cc"
            class="w-28 rounded-lg border border-slate-300 p-2.5 text-base text-slate-800"
          />
          <button
            type="button"
            class="min-w-0 flex-1 rounded-xl bg-sky-600 px-3 py-2.5 text-sm font-medium text-white active:bg-sky-700"
            @click="logCustomWater"
          >
            💧 記錄純水 +{{ waterInputCc }}cc
          </button>
        </div>
        <div class="grid grid-cols-4 gap-2">
          <button type="button" class="rounded-xl bg-sky-50 py-2.5 text-sm font-medium text-sky-800 ring-1 ring-sky-200 active:bg-sky-100" @click="addWater(100)">+100cc</button>
          <button type="button" class="rounded-xl bg-sky-50 py-2.5 text-sm font-medium text-sky-800 ring-1 ring-sky-200 active:bg-sky-100" @click="addWater(300)">+300cc</button>
          <button type="button" class="rounded-xl bg-sky-50 py-2.5 text-sm font-medium text-sky-800 ring-1 ring-sky-200 active:bg-sky-100" @click="addWater(500)">+500cc</button>
          <button type="button" class="rounded-xl bg-slate-100 py-2.5 text-sm text-slate-600 active:bg-slate-200" @click="addWater(-100)">−100cc</button>
        </div>
        <p v-if="waterError" class="text-xs text-rose-600">{{ waterError }}</p>
      </div>

      <div class="mt-3">
        <button
          type="button"
          class="w-full rounded-xl bg-amber-50 py-2.5 text-sm font-medium text-amber-900 ring-1 ring-amber-200 active:bg-amber-100 disabled:opacity-60"
          :disabled="hydrationAdviceLoading"
          @click="askHydrationSchedule"
        >
          {{ hydrationAdviceLoading ? '分析中…' : '💡 AI 飲水分配建議' }}
        </button>
        <p v-if="hydrationAdviceError" class="mt-1 text-xs text-rose-600">{{ hydrationAdviceError }}</p>
        <p v-if="hydrationAdvice" class="mt-2 rounded-lg bg-amber-50 p-2.5 text-sm leading-relaxed text-amber-950">
          <span v-if="hydrationPattern" class="mr-1 font-semibold">{{ hydrationPattern }}。</span>{{ hydrationAdvice }}
        </p>
      </div>

      <!-- Drink logging normal mode -->
      <div v-if="!drinkEditMode" class="mt-4 border-t border-slate-100 pt-3">
        <p class="mb-2 text-xs font-medium text-slate-500">🍵 飲品快選 (點選帶入，可微調容量或直接輸入)：</p>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="dp in live.drinkPresets"
            :key="dp.id"
            type="button"
            class="rounded-full border px-3 py-1 text-xs active:bg-sky-50"
            :class="drinkForm.name === dp.name ? 'border-sky-600 bg-sky-50 text-sky-800 font-medium' : 'border-slate-300 text-slate-700'"
            @click="applyDrinkPreset(dp)"
          >
            {{ dp.name }} ({{ dp.default_cc }}cc{{ dp.counts_as_water ? '·計水' : '' }})
          </button>
        </div>

        <div class="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-12">
          <input
            v-model="drinkForm.name"
            type="text"
            placeholder="輸入飲品 (如：無糖綠茶、拿鐵)"
            class="rounded-lg border border-slate-300 p-2 text-sm text-slate-800 sm:col-span-5"
          />
          <div class="flex items-center gap-1.5 sm:col-span-3">
            <input
              v-model="drinkForm.volume_cc"
              type="number"
              min="0"
              step="50"
              placeholder="容量"
              class="w-full rounded-lg border border-slate-300 p-2 text-sm text-slate-800"
            />
            <span class="shrink-0 text-xs text-slate-500">cc</span>
          </div>
          <label class="flex items-center gap-1.5 px-1 text-xs text-slate-700 sm:col-span-4">
            <input v-model="drinkForm.counts_as_water" type="checkbox" class="size-4 accent-sky-600" />
            計入每日純水總量
          </label>
        </div>
        <div class="mt-2 flex gap-2">
          <input
            v-model="drinkForm.note"
            type="text"
            placeholder="選填備註 (如：微冰、加鮮奶)"
            class="min-w-0 flex-1 rounded-lg border border-slate-300 p-2 text-sm text-slate-800"
            @keyup.enter="addDrinkLog"
          />
          <button
            type="button"
            class="shrink-0 rounded-xl bg-sky-700 px-4 py-2 text-sm font-medium text-white active:bg-sky-800"
            @click="addDrinkLog"
          >
            ➕ 記錄飲品
          </button>
        </div>
        <p v-if="drinkManageError" class="mt-2 rounded-lg bg-rose-50 p-2 text-xs text-rose-700">{{ drinkManageError }}</p>
      </div>

      <!-- Drink presets edit mode -->
      <div v-else class="mt-4 space-y-3 rounded-xl border border-sky-200 bg-sky-50/40 p-3">
        <p class="text-xs text-slate-500">自訂常用飲品快選與預設容量，勾選「計水」代表記錄時會自動累加至每日飲水進度條。</p>
        <div class="space-y-2">
          <div
            v-for="dp in live.drinkPresets"
            :key="dp.id"
            class="flex flex-wrap items-center gap-2 rounded-lg bg-white p-2 ring-1 ring-slate-200"
          >
            <input
              :value="dp.name"
              placeholder="飲品名稱"
              class="min-w-[7rem] flex-1 rounded-lg border border-slate-300 p-1.5 text-sm"
              @change="onDrinkPresetEdit(dp.id, 'name', $event.target.value)"
            />
            <input
              :value="dp.default_cc"
              type="number"
              min="0"
              step="50"
              class="w-20 rounded-lg border border-slate-300 p-1.5 text-sm"
              @change="onDrinkPresetEdit(dp.id, 'default_cc', $event.target.value)"
            />
            <span class="text-xs text-slate-500">cc</span>
            <label class="flex items-center gap-1 text-xs text-slate-700">
              <input
                type="checkbox"
                class="size-4 accent-sky-600"
                :checked="dp.counts_as_water"
                @change="onDrinkPresetEdit(dp.id, 'counts_as_water', $event.target.checked)"
              />
              計水
            </label>
            <button
              type="button"
              class="grid size-8 place-items-center rounded-lg bg-rose-50 text-rose-600 active:bg-rose-100"
              @click="deleteDrinkPreset(dp.id)"
            >
              🗑
            </button>
          </div>
        </div>

        <div class="space-y-2 rounded-lg border border-dashed border-sky-400 bg-white p-2.5">
          <p class="text-xs font-semibold text-slate-700">➕ 新增飲品快選</p>
          <div class="flex flex-wrap items-center gap-2">
            <input
              v-model="newDrinkPreset.name"
              placeholder="名稱 (如：無糖麥茶)"
              class="min-w-[7rem] flex-1 rounded-lg border border-slate-300 p-1.5 text-sm"
            />
            <input
              v-model="newDrinkPreset.default_cc"
              type="number"
              min="0"
              step="50"
              placeholder="cc"
              class="w-20 rounded-lg border border-slate-300 p-1.5 text-sm"
            />
            <label class="flex items-center gap-1 text-xs text-slate-700">
              <input v-model="newDrinkPreset.counts_as_water" type="checkbox" class="size-4 accent-sky-600" />
              計入純水
            </label>
            <button
              type="button"
              class="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white active:bg-sky-700"
              @click="addDrinkPreset"
            >
              新增
            </button>
          </div>
        </div>

        <p v-if="drinkManageError" class="rounded-lg bg-rose-50 p-2 text-xs text-rose-700">{{ drinkManageError }}</p>
        <button
          type="button"
          class="w-full rounded-lg bg-white py-2 text-xs text-rose-600 ring-1 ring-rose-200 active:bg-rose-50"
          @click="resetDrinkPresets"
        >
          ↩︎ 恢復預設飲品快選
        </button>
      </div>

      <!-- Logged drinks list today -->
      <div v-if="day.drinks?.length" class="mt-3 border-t border-slate-100 pt-2.5">
        <p class="text-xs font-medium text-slate-400">今日飲品明細</p>
        <ul class="mt-1 divide-y divide-slate-100">
          <li v-for="drk in day.drinks" :key="drk.id" class="flex items-center gap-2 py-1.5 text-sm">
            <span class="text-xs text-slate-400">{{ drk.time }}</span>
            <div class="min-w-0 flex-1">
              <span class="font-medium text-slate-800">{{ drk.name }}</span>
              <span class="ml-1.5 text-xs text-sky-700">{{ drk.volume_cc }}cc</span>
              <span
                v-if="drk.counts_as_water"
                class="ml-1.5 rounded bg-sky-50 px-1.5 py-0.5 text-[10px] text-sky-700"
              >已計入純水</span>
              <span
                v-else
                class="ml-1.5 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700"
              >僅記錄飲品</span>
              <span v-if="drk.note" class="ml-1.5 text-xs text-slate-400">· {{ drk.note }}</span>
            </div>
            <button class="px-2 text-slate-300 active:text-rose-500" @click="removeDrinkLog(drk.id)">✕</button>
          </li>
        </ul>
      </div>
    </section>

    <!-- Medications -->
    <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <div class="flex items-baseline justify-between">
        <h2 class="font-semibold text-slate-800">💊 用藥</h2>
        <span class="text-sm text-slate-500">{{ medDone.done }} / {{ medDone.total }}</span>
      </div>
      <div class="mt-2 grid gap-4 sm:grid-cols-2">
        <div v-for="slot in ['morning', 'evening']" :key="slot">
          <p class="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
            {{ slot === 'morning' ? '早上' : '晚上' }}
          </p>
          <label
            v-for="m in medsForSlot(slot)"
            :key="m.id"
            class="flex min-h-11 items-center gap-3 rounded-lg px-1 py-1.5 active:bg-slate-50"
          >
            <input
              type="checkbox"
              class="size-5 accent-emerald-600"
              :checked="day.meds?.[slot]?.[m.id]"
              @change="toggleMed(slot, m.id)"
            />
            <span class="text-sm" :class="day.meds?.[slot]?.[m.id] ? 'text-slate-400 line-through' : 'text-slate-700'">
              {{ medLabel(m) }}
            </span>
          </label>
          <p v-if="!medsForSlot(slot).length" class="px-1 text-xs text-slate-400">
            無藥物 (可於 ⚙️ 設定 → 個人目標與用藥調整 新增)
          </p>
        </div>
      </div>
    </section>

    <!-- Exercise (Flexible + Preset Editor) -->
    <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <div class="flex items-start justify-between gap-2">
        <div>
          <h2 class="font-semibold text-slate-800">🏃 運動紀錄</h2>
          <p class="mt-0.5 text-xs" :class="exerciseReached ? 'text-emerald-600 font-semibold' : 'text-slate-500'">
            今日累計：{{ day.exercise_min || 0 }} 分鐘 (目標 {{ TARGETS.exerciseTarget }} 分)
            <span v-if="exerciseKcalTotal" class="font-normal text-slate-500"> · 約 {{ exerciseKcalTotal }} kcal（參考）</span>
          </p>
        </div>
        <button
          class="shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium"
          :class="exerciseEditMode ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-700 active:bg-slate-200'"
          @click="exerciseEditMode = !exerciseEditMode"
        >
          {{ exerciseEditMode ? '✓ 完成編輯' : '⚙️ 編輯運動快選' }}
        </button>
      </div>

      <!-- Normal mode -->
      <div v-if="!exerciseEditMode" class="mt-3 space-y-3">
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="t in live.exerciseTypes"
            :key="t"
            type="button"
            class="rounded-full border px-3 py-1 text-xs transition-colors"
            :class="exerciseForm.type === t ? 'border-teal-600 bg-teal-600 text-white font-medium' : 'border-slate-300 bg-white text-slate-700'"
            @click="selectExerciseType(t)"
          >
            {{ t }}
          </button>
        </div>

        <div class="flex gap-1">
          <button
            type="button"
            class="rounded-lg px-3 py-1.5 text-xs font-medium"
            :class="exerciseForm.mode !== 'reps' ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-600'"
            @click="setExerciseMode('duration')"
          >
            時間模式
          </button>
          <button
            type="button"
            class="rounded-lg px-3 py-1.5 text-xs font-medium"
            :class="exerciseForm.mode === 'reps' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'"
            @click="setExerciseMode('reps')"
          >
            次數模式
          </button>
        </div>

        <div class="grid grid-cols-1 gap-2 sm:grid-cols-12">
          <input
            v-model="exerciseForm.type"
            type="text"
            placeholder="運動類型 (可自行輸入)"
            class="rounded-lg border border-slate-300 p-2 text-sm text-slate-800 sm:col-span-4"
          />
          <div v-if="exerciseForm.mode !== 'reps'" class="flex flex-wrap items-center gap-1.5 sm:col-span-8">
            <input
              v-model="exerciseForm.duration"
              type="number"
              min="1"
              placeholder="分鐘"
              class="w-20 rounded-lg border border-slate-300 p-2 text-sm text-slate-800"
            />
            <span class="text-xs text-slate-500">分</span>
            <span class="text-xs font-medium text-indigo-700">
              <template v-if="currentFactor !== 1">× {{ currentFactor }} ≈ {{ durationEquivalent }} 分（折合散步）· </template>約 {{ kcalPreview }} kcal
            </span>
            <button
              type="button"
              class="rounded-lg bg-teal-50 px-2.5 py-2 text-xs font-medium text-teal-800 ring-1 ring-teal-200 active:bg-teal-100"
              @click="addExerciseLog(15)"
            >
              +15分
            </button>
            <button
              type="button"
              class="rounded-lg bg-teal-50 px-2.5 py-2 text-xs font-medium text-teal-800 ring-1 ring-teal-200 active:bg-teal-100"
              @click="addExerciseLog(20)"
            >
              +20分
            </button>
            <button
              type="button"
              class="rounded-lg bg-teal-50 px-2.5 py-2 text-xs font-medium text-teal-800 ring-1 ring-teal-200 active:bg-teal-100"
              @click="addExerciseLog(30)"
            >
              +30分
            </button>
          </div>
          <div v-else class="flex flex-wrap items-center gap-1.5 sm:col-span-8">
            <input
              v-model="exerciseForm.reps"
              type="number"
              min="1"
              placeholder="次數"
              class="w-20 rounded-lg border border-slate-300 p-2 text-sm text-slate-800"
            />
            <span class="text-xs text-slate-500">下</span>
            <input
              v-model="exerciseForm.sets"
              type="number"
              min="1"
              placeholder="組數"
              class="w-16 rounded-lg border border-slate-300 p-2 text-sm text-slate-800"
            />
            <span class="text-xs text-slate-500">組</span>
            <button
              type="button"
              class="rounded-lg bg-indigo-50 px-2.5 py-2 text-xs font-medium text-indigo-800 ring-1 ring-indigo-200 active:bg-indigo-100"
              @click="bumpReps(20)"
            >
              +20下
            </button>
            <button
              type="button"
              class="rounded-lg bg-indigo-50 px-2.5 py-2 text-xs font-medium text-indigo-800 ring-1 ring-indigo-200 active:bg-indigo-100"
              @click="bumpReps(50)"
            >
              +50下
            </button>
            <button
              type="button"
              class="rounded-lg bg-indigo-50 px-2.5 py-2 text-xs font-medium text-indigo-800 ring-1 ring-indigo-200 active:bg-indigo-100"
              @click="bumpReps(100)"
            >
              +100下
            </button>
            <span class="text-xs font-medium text-indigo-700">
              約 {{ repsActualPreview }} 分（每分鐘 {{ currentProfile.repsPerMin }} 下）<template v-if="currentFactor !== 1"> × {{ currentFactor }}</template>
              ≈ 折合散步 {{ repsDurationPreview }} 分 · 約 {{ kcalPreview }} kcal
            </span>
          </div>
        </div>

        <div class="flex gap-2">
          <input
            v-model="exerciseForm.note"
            type="text"
            placeholder="選填備註 (如：坡度 3%、時速 5.5km、公里數或重訓組數)"
            class="min-w-0 flex-1 rounded-lg border border-slate-300 p-2 text-sm text-slate-800"
            @keyup.enter="addExerciseLog()"
          />
          <button
            type="button"
            class="shrink-0 rounded-xl bg-teal-600 px-4 py-2 text-sm font-medium text-white active:bg-teal-700"
            @click="addExerciseLog()"
          >
            ➕ 新增運動
          </button>
        </div>
        <p v-if="exerciseManageError" class="rounded-lg bg-rose-50 p-2 text-xs text-rose-700">{{ exerciseManageError }}</p>
      </div>

      <!-- Edit mode: manage exercise type presets -->
      <div v-else class="mt-3 space-y-3 rounded-xl border border-teal-200 bg-teal-50/40 p-3">
        <p class="text-xs text-slate-500">
          每個運動項目可設定：記錄方式（時間或次數）、每分鐘大約幾下（次數換算成分鐘用）、換算係數（1＝與散步每分鐘效果相同，&gt;1 表示強度較高），以及 MET（估算卡路里用，散步約 3.5；留空則由係數推估）。
          計入目標的是「折合散步分鐘」；卡路里只是參考。按「AI」可取得建議，確認後才會儲存。數值為粗略估計，建議與醫師或教練確認。
        </p>
        <button
          type="button"
          class="w-full rounded-lg bg-indigo-600 py-2 text-xs font-medium text-white active:bg-indigo-700 disabled:opacity-50"
          :disabled="evaluatingAll || !live.exerciseTypes.length"
          @click="evaluateAllTypes"
        >
          {{ evaluatingAll ? 'AI 評估中…' : '🤖 AI 評估全部項目' }}
        </button>
        <div class="space-y-2">
          <div v-for="t in live.exerciseTypes" :key="t" class="rounded-lg bg-white p-2 text-xs text-slate-700 ring-1 ring-slate-200">
            <div class="flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate font-medium text-slate-800">{{ t }}</span>
              <button
                type="button"
                class="rounded-full bg-indigo-50 px-2.5 py-1 text-[11px] text-indigo-700 ring-1 ring-indigo-200 active:bg-indigo-100 disabled:opacity-50"
                :disabled="profileSuggestions.some((s) => s.type === t && s.busy)"
                :aria-label="`AI 評估 ${t}`"
                @click="askProfileSuggestion(t)"
              >
                AI
              </button>
              <button
                type="button"
                class="grid size-6 place-items-center rounded-full text-rose-500 active:bg-rose-50"
                :aria-label="`刪除 ${t}`"
                @click="deleteExerciseTypePreset(t)"
              >
                ✕
              </button>
            </div>
            <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-slate-500">
              <label class="flex items-center gap-1">
                記錄
                <select
                  :value="exerciseProfile(t).mode"
                  class="rounded border border-slate-200 px-1 py-0.5 text-xs text-slate-800"
                  @change="setExerciseProfile(t, { mode: $event.target.value })"
                >
                  <option value="duration">時間</option>
                  <option value="reps">次數</option>
                </select>
              </label>
              <label v-if="exerciseProfile(t).mode === 'reps'" class="flex items-center gap-1">
                每分鐘
                <input
                  :value="exerciseProfile(t).repsPerMin"
                  type="number"
                  min="1"
                  max="200"
                  class="w-14 rounded border border-slate-200 px-1 py-0.5 text-center text-xs text-slate-800"
                  @change="setExerciseProfile(t, { repsPerMin: Number($event.target.value) })"
                />
                下
              </label>
              <label class="flex items-center gap-1">
                係數
                <input
                  :value="live.exerciseFactors[t] ?? 1"
                  type="number"
                  step="0.1"
                  min="0.1"
                  max="5"
                  class="w-14 rounded border border-slate-200 px-1 py-0.5 text-center text-xs text-slate-800"
                  @change="setExerciseFactor(t, $event.target.value)"
                />
              </label>
              <label class="flex items-center gap-1">
                MET
                <input
                  :value="exerciseProfile(t).metEstimated ? '' : exerciseProfile(t).met"
                  :placeholder="String(exerciseProfile(t).met)"
                  type="number"
                  step="0.1"
                  min="1"
                  max="20"
                  class="w-14 rounded border border-slate-200 px-1 py-0.5 text-center text-xs text-slate-800"
                  @change="setExerciseProfile(t, { met: $event.target.value === '' ? '' : Number($event.target.value) })"
                />
              </label>
            </div>
          </div>
          <p v-if="!live.exerciseTypes.length" class="text-xs text-slate-400">尚無運動快選</p>
        </div>

        <div v-if="profileSuggestions.length" class="space-y-2 rounded-lg bg-indigo-50 p-2.5 text-xs text-indigo-900 ring-1 ring-indigo-200">
          <div class="flex items-center justify-between gap-2">
            <p class="font-medium">AI 建議（按「採用」才會儲存）</p>
            <button
              v-if="profileSuggestions.filter((s) => !s.busy && !s.error).length > 1"
              type="button"
              class="rounded-lg bg-indigo-600 px-2.5 py-1 text-white active:bg-indigo-700"
              @click="adoptAllSuggestions"
            >
              全部採用
            </button>
          </div>
          <div v-for="s in profileSuggestions" :key="s.type" class="rounded-lg bg-white/70 p-2">
            <p class="font-medium text-indigo-950">{{ s.type }}</p>
            <p v-if="s.busy" class="mt-0.5">評估中…</p>
            <p v-else-if="s.error" class="mt-0.5 text-rose-700">{{ s.error }}</p>
            <template v-else>
              <p class="mt-0.5">
                記錄：{{ MODE_LABEL[s.mode] }}<template v-if="s.mode === 'reps'"> · 每分鐘 {{ s.repsPerMin }} 下</template>
                · 係數 {{ s.factor }} · MET {{ s.met }}
              </p>
              <p v-if="s.reason" class="mt-0.5 text-indigo-800">{{ s.reason }}</p>
            </template>
            <div class="mt-1.5 flex gap-2">
              <button
                v-if="!s.busy && !s.error"
                type="button"
                class="rounded-lg bg-indigo-600 px-3 py-1 text-white active:bg-indigo-700"
                @click="adoptProfileSuggestion(s)"
              >
                採用
              </button>
              <button
                type="button"
                class="rounded-lg bg-white px-3 py-1 text-slate-700 ring-1 ring-slate-300 active:bg-slate-50"
                @click="dismissProfileSuggestion(s)"
              >
                {{ s.busy || s.error ? '關閉' : '略過' }}
              </button>
            </div>
          </div>
          <p class="text-[11px] text-indigo-700">僅為粗略參考，不是醫療建議；採用前建議與醫師或教練確認。</p>
        </div>
        <div class="flex gap-2">
          <input
            v-model="newExerciseType"
            type="text"
            placeholder="新增運動類型 (如：超慢跑、游泳)"
            class="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white p-2 text-sm"
            @keyup.enter="addExerciseTypePreset"
          />
          <button
            type="button"
            class="shrink-0 rounded-lg bg-teal-600 px-4 py-2 text-xs font-medium text-white active:bg-teal-700"
            @click="addExerciseTypePreset"
          >
            新增類型
          </button>
        </div>
        <p v-if="exerciseManageError" class="rounded-lg bg-rose-50 p-2 text-xs text-rose-700">{{ exerciseManageError }}</p>
        <button
          type="button"
          class="w-full rounded-lg bg-white py-2 text-xs text-rose-600 ring-1 ring-rose-200 active:bg-rose-50"
          @click="resetExerciseTypePresets"
        >
          ↩︎ 恢復預設運動類型
        </button>
      </div>

      <!-- Exercise logs list -->
      <div v-if="day.exercise_logs?.length" class="mt-3 border-t border-slate-100 pt-2.5">
        <div class="flex items-center justify-between">
          <p class="text-xs font-medium text-slate-400">今日運動明細</p>
          <button class="text-xs text-rose-500 active:text-rose-600" @click="clearExerciseLogs">清空當日運動</button>
        </div>
        <ul class="mt-1 divide-y divide-slate-100">
          <li v-for="log in day.exercise_logs" :key="log.id" class="flex items-start gap-2 py-1.5 text-sm">
            <span class="mt-0.5 text-xs text-slate-400">{{ log.time }}</span>
            <div class="min-w-0 flex-1">
              <span class="font-medium text-slate-800">{{ log.type }}</span>
              <span
                v-if="isRepsLog(log)"
                class="ml-1.5 rounded bg-indigo-100 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-800"
              >{{ log.reps }} 下 × {{ log.sets || 1 }} 組 · 折合 {{ log.duration_min }} 分</span>
              <span v-else class="ml-1.5 font-semibold text-teal-600">
                <template v-if="log.factor && log.factor !== 1">{{ log.actual_min }} 分 × {{ log.factor }} = {{ log.duration_min }} 分（折合散步）</template>
                <template v-else>{{ log.duration_min }} 分鐘</template>
              </span>
              <span
                v-if="log.source === 'meal_tag'"
                class="ml-1.5 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-700"
              >餐點標籤連動</span>
              <span v-if="log.kcal" class="ml-1.5 text-[11px] text-slate-400">約 {{ log.kcal }} kcal</span>
              <p v-if="log.note" class="mt-0.5 text-xs text-slate-500">{{ log.note }}</p>
            </div>
            <button class="px-2 text-slate-300 active:text-rose-500" @click="removeExerciseLog(log.id)">✕</button>
          </li>
        </ul>
      </div>
    </section>

    <!-- Meal logging -->
    <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <div class="flex items-start justify-between gap-2">
        <div>
          <h2 class="font-semibold text-slate-800">🍱 記錄餐點</h2>
          <p class="mt-0.5 text-xs text-slate-500">進食順序：蔬菜 → 蛋白質 → 澱粉 (半份)</p>
        </div>
        <button
          class="shrink-0 rounded-lg px-3 py-2 text-sm"
          :class="editMode ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-700 active:bg-slate-200'"
          @click="editMode = !editMode"
        >
          {{ editMode ? '✓ 完成編輯' : '⚙️ 編輯快選' }}
        </button>
      </div>

      <!-- Normal mode: one-click presets + modifier tags -->
      <template v-if="!editMode">
        <div class="mt-3 space-y-2">
          <div v-for="(list, cat) in presetGroups" :key="cat">
            <p class="mb-1 text-xs font-medium text-slate-400">{{ cat }}</p>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="p in list"
                :key="p.id"
                class="rounded-full border px-3 py-1.5 text-sm active:bg-teal-100"
                :class="mealText === p.description ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-slate-300 text-slate-700'"
                @click="applyPreset(p)"
              >
                {{ p.label }}
              </button>
            </div>
          </div>
          <p v-if="!live.presets.length" class="text-sm text-slate-400">
            尚無快選按鈕，請按「⚙️ 編輯快選」新增，或直接輸入餐點後按「⭐ 存為常吃快選」。
          </p>
        </div>

        <div class="mt-3 flex flex-wrap gap-2">
          <button
            v-for="t in live.tags"
            :key="t"
            class="rounded-md px-2.5 py-1.5 text-sm"
            :class="selectedTags.includes(t) ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-700'"
            @click="toggleTag(t)"
          >
            {{ t }}
          </button>
        </div>
      </template>

      <!-- Edit mode: manage presets & modifier tags -->
      <div v-else class="mt-3 space-y-4 rounded-xl border border-teal-200 bg-teal-50/40 p-3">
        <datalist id="preset-categories">
          <option v-for="c in presetCategories" :key="c" :value="c" />
        </datalist>
        <p class="text-xs text-slate-500">修改後即自動儲存。分類可輸入任何名稱 (例如：平日、外食、在家、假日或自訂)。</p>

        <div v-for="(list, cat) in presetGroups" :key="cat" class="space-y-2">
          <p class="text-xs font-semibold text-teal-800">{{ cat }}</p>
          <div v-for="p in list" :key="p.id" class="space-y-1.5 rounded-lg bg-white p-2.5 ring-1 ring-slate-200">
            <div class="flex gap-2">
              <input
                :value="p.label"
                placeholder="按鈕名稱"
                class="min-w-0 flex-1 rounded-lg border border-slate-300 p-2 text-base"
                @change="onPresetEdit(p.id, 'label', $event)"
              />
              <input
                :value="p.category"
                list="preset-categories"
                placeholder="分類"
                class="w-24 rounded-lg border border-slate-300 p-2 text-base"
                @change="onPresetEdit(p.id, 'category', $event)"
              />
              <button
                class="grid size-10 shrink-0 place-items-center rounded-lg bg-rose-50 text-rose-600 active:bg-rose-100"
                aria-label="刪除快選"
                @click="deletePreset(p.id)"
              >
                🗑
              </button>
            </div>
            <textarea
              :value="p.description"
              rows="2"
              placeholder="完整餐點描述"
              class="w-full rounded-lg border border-slate-300 p-2 text-sm"
              @change="onPresetEdit(p.id, 'description', $event)"
            />
          </div>
        </div>

        <!-- Add new preset -->
        <div class="space-y-1.5 rounded-lg border border-dashed border-teal-400 bg-white p-2.5">
          <p class="text-sm font-medium text-slate-700">➕ 新增快選按鈕</p>
          <div class="flex gap-2">
            <input
              v-model="newPreset.label"
              placeholder="簡短按鈕名稱"
              class="min-w-0 flex-1 rounded-lg border border-slate-300 p-2 text-base"
            />
            <input
              v-model="newPreset.category"
              list="preset-categories"
              placeholder="分類"
              class="w-24 rounded-lg border border-slate-300 p-2 text-base"
            />
          </div>
          <textarea
            v-model="newPreset.description"
            rows="2"
            placeholder="完整餐點描述"
            class="w-full rounded-lg border border-slate-300 p-2 text-sm"
          />
          <button class="w-full rounded-lg bg-teal-600 py-2.5 font-medium text-white active:bg-teal-700" @click="addPreset">
            新增快選
          </button>
        </div>

        <!-- Modifier tags -->
        <div class="space-y-2">
          <p class="text-xs font-semibold text-teal-800">修飾標籤</p>
          <div class="flex flex-wrap gap-2">
            <span
              v-for="t in live.tags"
              :key="t"
              class="inline-flex items-center gap-1 rounded-md bg-white py-1 pl-2.5 pr-1 text-sm text-slate-700 ring-1 ring-slate-200"
            >
              {{ t }}
              <button class="grid size-7 place-items-center rounded text-rose-500 active:bg-rose-50" aria-label="刪除標籤" @click="deleteTag(t)">
                ✕
              </button>
            </span>
            <span v-if="!live.tags.length" class="text-sm text-slate-400">尚無標籤</span>
          </div>
          <div class="flex gap-2">
            <input
              v-model="newTag"
              placeholder="例如：加點燙青菜"
              class="min-w-0 flex-1 rounded-lg border border-slate-300 p-2 text-base"
              @keyup.enter="addTag"
            />
            <button class="shrink-0 rounded-lg bg-teal-600 px-4 py-2 font-medium text-white active:bg-teal-700" @click="addTag">
              新增標籤
            </button>
          </div>
        </div>

        <p v-if="manageError" class="rounded-lg bg-rose-50 p-2 text-sm text-rose-700">{{ manageError }}</p>

        <button class="w-full rounded-lg bg-white py-2.5 text-sm text-rose-600 ring-1 ring-rose-200 active:bg-rose-50" @click="resetMenu">
          ↩︎ 恢復預設菜單
        </button>
      </div>

      <textarea
        v-model="mealText"
        rows="3"
        placeholder="描述餐點，例如：雞腿便當，飯吃一半…"
        class="mt-3 w-full rounded-xl border border-slate-300 p-3 text-base focus:border-teal-500 focus:outline-none"
      />

      <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <label class="flex items-center gap-1.5">
          用餐時間
          <input v-model="mealTime" type="time" class="rounded-lg border border-slate-300 p-1.5 text-sm text-slate-800" />
        </label>
        <button v-if="mealTime" type="button" class="rounded-lg bg-slate-100 px-2.5 py-1.5 text-slate-700 active:bg-slate-200" @click="mealTime = ''">
          改回現在
        </button>
        <span v-else>不填＝現在；補記請填實際用餐時間</span>
      </div>

      <div class="mt-2 flex flex-wrap items-center gap-2">
        <button
          class="rounded-xl bg-amber-50 px-4 py-2.5 text-sm text-amber-800 ring-1 ring-amber-200 active:bg-amber-100"
          @click="saveAsPreset"
        >
          ⭐ 存為常吃快選
        </button>
        <label
          class="cursor-pointer rounded-xl bg-slate-100 px-4 py-2.5 text-sm text-slate-700 active:bg-slate-200"
          :class="{ 'pointer-events-none opacity-50': photos.length + photoPending >= MAX_MEAL_IMAGES }"
        >
          📷 {{ photos.length ? '再加一張' : '拍照 / 上傳' }} ({{ photos.length }}/{{ MAX_MEAL_IMAGES }})
          <input
            type="file"
            accept="image/*"
            multiple
            class="hidden"
            :disabled="photos.length + photoPending >= MAX_MEAL_IMAGES"
            @change="onPhoto"
          />
        </label>
        <div v-for="(p, i) in photos" :key="p.id" class="relative">
          <img :src="p.preview" :alt="`meal preview ${i + 1}`" class="size-14 rounded-lg object-cover" />
          <button
            type="button"
            class="absolute -right-2 -top-2 size-6 rounded-full bg-slate-700 text-xs text-white"
            :aria-label="`移除第 ${i + 1} 張照片`"
            @click="removePhoto(p.id)"
          >
            ✕
          </button>
        </div>
        <span v-if="photoPending" class="text-xs text-slate-500">照片處理中…</span>
      </div>

      <p v-if="error" class="mt-2 rounded-lg bg-rose-50 p-2 text-sm text-rose-700">{{ error }}</p>

      <div class="mt-3 grid grid-cols-3 gap-2">
        <button
          class="col-span-2 rounded-xl bg-teal-700 py-3.5 font-semibold text-white disabled:opacity-50 active:bg-teal-800"
          :disabled="busy"
          @click="submitMeal(true)"
        >
          {{ busy ? `AI 分析中… ${elapsed}s` : '✨ AI 分析並記錄' }}
        </button>
        <button
          class="rounded-xl bg-slate-100 py-3.5 text-slate-700 disabled:opacity-50 active:bg-slate-200"
          :disabled="busy"
          @click="submitMeal(false)"
        >
          只記錄
        </button>
      </div>
    </section>

    <!-- Real-time alert cards -->
    <section v-if="mealToShow?.analysis" class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <h2 class="font-semibold text-slate-800">🚦 {{ mealToShow.analysis.meal_name }}</h2>
      <p class="mt-1 text-xs text-slate-500">
        約 {{ Math.round(mealToShow.analysis.estimated_calories_kcal) }} kcal ·
        蛋白質 {{ mealToShow.analysis.macronutrients.protein_g }}g ·
        碳水 {{ mealToShow.analysis.macronutrients.carbs_g }}g ·
        脂肪 {{ mealToShow.analysis.macronutrients.fat_g }}g
        (飽和 {{ mealToShow.analysis.macronutrients.saturated_fat_g }}g) ·
        纖維 {{ mealToShow.analysis.macronutrients.dietary_fiber_g }}g ·
        鈉 {{ mealToShow.analysis.macronutrients.sodium_mg }}mg
      </p>
      <div class="mt-3 grid gap-2 sm:grid-cols-2">
        <div
          v-for="a in ALERTS"
          :key="a.key"
          class="rounded-xl border p-3"
          :class="LEVEL_STYLE[mealToShow.analysis[a.key]?.level] || 'bg-slate-50 border-slate-200'"
        >
          <div class="flex items-center gap-2 text-sm font-semibold">
            <span class="size-3 rounded-full" :class="DOT_STYLE[mealToShow.analysis[a.key]?.level]" />
            {{ a.title }}
            <span class="ml-auto text-xs font-normal opacity-70">
              {{ LEVEL_TEXT[mealToShow.analysis[a.key]?.level] }}
            </span>
          </div>
          <p class="mt-1 text-sm">{{ mealToShow.analysis[a.key]?.message }}</p>
        </div>
      </div>
      <p class="mt-3 rounded-xl bg-slate-50 p-3 text-sm text-slate-700">
        💡 {{ mealToShow.analysis.actionable_advice }}
      </p>
    </section>

    <!-- Meal log -->
    <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <div class="flex items-baseline justify-between">
        <h2 class="font-semibold text-slate-800">📋 今日餐點</h2>
        <span class="text-xs text-slate-500">
          碳水 {{ totals.carbs_g }}g · 飽和脂肪 {{ totals.saturated_fat_g }}g · 鈉 {{ totals.sodium_mg }}mg
        </span>
      </div>
      <p v-if="!day.meals?.length" class="mt-3 text-sm text-slate-400">尚未記錄餐點。</p>
      <ul class="mt-2 divide-y divide-slate-100">
        <li v-for="m in mealsSorted" :key="m.id" class="flex items-start gap-2 py-2">
          <span class="mt-0.5 text-xs text-slate-400">{{ m.time }}</span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm text-slate-800">{{ m.analysis?.meal_name || m.text || '(照片)' }}</p>
            <p v-if="m.tags?.length" class="text-xs text-slate-400">{{ m.tags.join(' ') }}</p>
          </div>
          <div v-if="m.analysis" class="flex items-center gap-1 pt-1">
            <span
              v-for="a in ALERTS"
              :key="a.key"
              class="size-2.5 rounded-full"
              :class="DOT_STYLE[m.analysis[a.key]?.level]"
              :title="a.title"
            />
          </div>
          <button
            type="button"
            class="px-2 text-slate-300 active:text-rose-500"
            :aria-label="`刪除餐點 ${m.analysis?.meal_name || m.text || '(照片)'}`"
            @click="removeMeal(m.id)"
          >✕</button>
        </li>
      </ul>
    </section>

    <!-- Daily AI summary (ported from the standalone build) -->
    <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <h2 class="font-semibold text-slate-800">🧠 今日 AI 總結</h2>
      <button
        type="button"
        class="mt-3 w-full rounded-xl bg-indigo-600 py-3.5 font-semibold text-white disabled:opacity-50 active:bg-indigo-700"
        :disabled="summaryBusy"
        @click="runDaySummary"
      >
        {{ summaryBusy ? 'AI 總結中…' : day.ai_summary ? '🔄 重新產生今日總結' : '✨ 產生今日總結' }}
      </button>
      <p v-if="summaryError" class="mt-2 rounded-lg bg-rose-50 p-2 text-sm text-rose-700">{{ summaryError }}</p>
      <div v-if="day.ai_summary" class="mt-3 space-y-3 text-sm text-slate-700">
        <p class="rounded-xl bg-indigo-50 p-3 text-indigo-900">{{ day.ai_summary.overall_assessment }}</p>
        <div class="grid gap-2 sm:grid-cols-2">
          <div
            v-for="a in ALERTS"
            :key="a.key"
            class="rounded-xl border p-3"
            :class="LEVEL_STYLE[day.ai_summary[a.key]?.level] || 'bg-slate-50 border-slate-200'"
          >
            <div class="flex items-center gap-2 text-sm font-semibold">
              <span class="size-3 rounded-full" :class="DOT_STYLE[day.ai_summary[a.key]?.level]" />{{ a.title }}
            </div>
            <p class="mt-1 text-sm">{{ day.ai_summary[a.key]?.message }}</p>
          </div>
        </div>
        <div v-if="day.ai_summary.highlights?.length">
          <p class="font-medium text-slate-800">做得好</p>
          <ul class="ml-5 list-disc"><li v-for="(h, i) in day.ai_summary.highlights" :key="i">{{ h }}</li></ul>
        </div>
        <div v-if="day.ai_summary.improvements?.length">
          <p class="font-medium text-slate-800">可改善</p>
          <ul class="ml-5 list-disc"><li v-for="(h, i) in day.ai_summary.improvements" :key="i">{{ h }}</li></ul>
        </div>
        <p><b>明日重點：</b>{{ day.ai_summary.tomorrow_focus }}</p>
        <p class="text-xs text-slate-400">AI 建議僅供參考，不能取代醫師診斷。</p>
      </div>
    </section>

    <!-- Undo snackbar for one-tap adds -->
    <div
      v-if="undoBar"
      :key="undoBar.key"
      class="fixed inset-x-0 bottom-20 z-40 flex justify-center px-3 md:bottom-6"
      data-testid="undo-bar"
    >
      <div class="flex max-w-md items-center gap-3 rounded-xl bg-slate-900/95 py-2 pr-2 pl-4 text-sm text-white shadow-lg" role="status" aria-live="polite">
        <span>{{ undoBar.text }}</span>
        <button type="button" class="min-h-10 rounded-lg px-3 font-semibold text-teal-300 active:bg-white/10" data-testid="undo-btn" @click="runUndo">復原</button>
        <button type="button" class="min-h-10 rounded-lg px-2 text-slate-300 active:bg-white/10" aria-label="關閉" @click="dismissUndo">✕</button>
      </div>
    </div>
  </div>
</template>
