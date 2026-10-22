<script setup>
import { computed, inject, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { live, medsForSlot, medLabel, updateCustom, resetCustom } from '../data/presets.js'
import { analyzeMeal, summarizeDay } from '../services/gemini.js'
import { getGeminiKey } from '../firebase.js'

const props = defineProps({
  day: { type: Object, required: true },
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

// ---------- hydration & drinks ----------
const TARGETS = computed(() => live.targets)
const hydrationPct = computed(() =>
  Math.min(100, Math.round(((props.day.hydration_cc || 0) / (TARGETS.value.hydrationMax || 1)) * 100)),
)
const hydrationMinPct = computed(() => (TARGETS.value.hydrationMin / (TARGETS.value.hydrationMax || 1)) * 100)
const hydrationReached = computed(() => (props.day.hydration_cc || 0) >= TARGETS.value.hydrationMin)

function addWater(cc) {
  commit((d) => {
    d.hydration_cc = Math.max(0, (d.hydration_cc || 0) + cc)
  })
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
const REPS_EXERCISE_TYPES = ['抬腳跟']

function isRepsExerciseType(type) {
  return REPS_EXERCISE_TYPES.includes(String(type || '').trim())
}

/** Reps mode still stores minutes so charts and daily totals stay compatible. 20 reps ≈ 1 minute. */
function estimateRepsMinutes(reps) {
  return Math.max(1, Math.round((Number(reps) || 0) / 20))
}

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
const repsDurationPreview = computed(() => estimateRepsMinutes(exerciseForm.reps))

function selectExerciseType(type) {
  exerciseForm.type = type
  exerciseForm.mode = isRepsExerciseType(type) ? 'reps' : 'duration'
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
    if (isRepsExerciseType(type)) exerciseForm.mode = 'reps'
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
  let entry
  if (repsMode) {
    const reps = Math.round(Number(exerciseForm.reps) || 0)
    const sets = Math.max(1, Math.round(Number(exerciseForm.sets) || 1))
    if (reps <= 0) {
      exerciseManageError.value = '請輸入大於 0 的次數。'
      return
    }
    entry = {
      id: `ex-${Date.now()}`,
      time: nowTime(),
      type,
      mode: 'reps',
      duration_min: estimateRepsMinutes(reps),
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
      id: `ex-${Date.now()}`,
      time: nowTime(),
      type,
      mode: 'duration',
      duration_min: dMin,
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
}

function deleteExerciseTypePreset(t) {
  const next = live.exerciseTypes.filter((x) => x !== t)
  updateCustom('exerciseTypes', next)
  if (exerciseForm.type === t) {
    exerciseForm.type = next[0] || '餐後踏步'
  }
}

function resetExerciseTypePresets() {
  if (!window.confirm('確定要恢復預設運動類型快選？')) return
  resetCustom(['exerciseTypes'])
  exerciseForm.type = live.exerciseTypes[0] || '餐後踏步'
  exerciseManageError.value = ''
}

const exerciseReached = computed(() => (props.day.exercise_min || 0) >= TARGETS.value.exerciseTarget)

// ---------- meal input ----------
const mealText = ref('')
const selectedTags = ref([])
const photo = ref(null)
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

function onPhoto(e) {
  const file = e.target.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    const img = new Image()
    img.onload = () => {
      const max = 1024
      const scale = Math.min(1, max / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8)
      photo.value = { mimeType: 'image/jpeg', data: dataUrl.split(',')[1], preview: dataUrl }
    }
    img.src = reader.result
  }
  reader.readAsDataURL(file)
  e.target.value = ''
}

function resetMealForm() {
  mealText.value = ''
  selectedTags.value = []
  photo.value = null
}

async function submitMeal(withAI) {
  error.value = ''
  if (!mealText.value.trim() && !photo.value) {
    error.value = '請輸入餐點內容、選擇預設或上傳照片。'
    return
  }
  const id = `${Date.now()}`
  const entry = {
    id,
    time: nowTime(),
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
      const { date, ...ctx } = summarizeDay(props.day)
      entry.analysis = await analyzeMeal({
        apiKey,
        text: entry.text,
        tags: entry.tags,
        image: photo.value ? { mimeType: photo.value.mimeType, data: photo.value.data } : null,
        dayContext: ctx,
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
      })
      syncExerciseTotal(d)
    }
  })
  latestId.value = withAI ? id : null
  resetMealForm()
}

function removeMeal(id) {
  commit((d) => {
    d.meals = d.meals.filter((m) => m.id !== id)
    d.ai_summary = null
  })
  if (latestId.value === id) latestId.value = null
}

const mealToShow = computed(() => {
  const meals = props.day.meals || []
  return (
    meals.find((m) => m.id === latestId.value) ||
    [...meals].reverse().find((m) => m.analysis) ||
    null
  )
})

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
    <!-- Hydration & Drinks -->
    <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <div class="flex items-start justify-between gap-2">
        <div>
          <h2 class="font-semibold text-slate-800">💧 飲水與飲品紀錄</h2>
          <p class="mt-0.5 text-xs" :class="hydrationReached ? 'text-emerald-600 font-semibold' : 'text-slate-500'">
            今日純水分累計：{{ day.hydration_cc || 0 }} / {{ TARGETS.hydrationMin }}-{{ TARGETS.hydrationMax }} cc
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
        <div
          class="h-full rounded-full transition-all"
          :class="hydrationReached ? 'bg-emerald-500' : 'bg-sky-500'"
          :style="{ width: hydrationPct + '%' }"
        />
        <div class="absolute inset-y-0 w-0.5 bg-slate-400/70" :style="{ left: hydrationMinPct + '%' }" />
      </div>

      <!-- Pure water quick buttons -->
      <div class="mt-3 grid grid-cols-3 gap-2">
        <button class="rounded-xl bg-sky-600 py-2.5 text-sm font-medium text-white active:bg-sky-700" @click="addWater(300)">
          純水 +300cc
        </button>
        <button class="rounded-xl bg-sky-600 py-2.5 text-sm font-medium text-white active:bg-sky-700" @click="addWater(500)">
          純水 +500cc
        </button>
        <button class="rounded-xl bg-slate-100 py-2.5 text-sm text-slate-600 active:bg-slate-200" @click="addWater(-300)">
          −300cc
        </button>
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
            <span class="text-xs font-medium text-indigo-700">約折合 {{ repsDurationPreview }} 分鐘</span>
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
        <p class="text-xs text-slate-500">管理常用的運動項目快選標籤，修改後自動儲存。</p>
        <div class="flex flex-wrap gap-2">
          <span
            v-for="t in live.exerciseTypes"
            :key="t"
            class="inline-flex items-center gap-1 rounded-full bg-white py-1 pl-3 pr-1.5 text-xs text-slate-700 ring-1 ring-slate-200"
          >
            {{ t }}
            <button
              type="button"
              class="grid size-6 place-items-center rounded-full text-rose-500 active:bg-rose-50"
              @click="deleteExerciseTypePreset(t)"
            >
              ✕
            </button>
          </span>
          <span v-if="!live.exerciseTypes.length" class="text-xs text-slate-400">尚無運動快選</span>
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
              >{{ log.reps }} 下 ({{ log.sets || 1 }} 組 · 折合 {{ log.duration_min }} 分)</span>
              <span v-else class="ml-1.5 font-semibold text-teal-600">{{ log.duration_min }} 分鐘</span>
              <span
                v-if="log.source === 'meal_tag'"
                class="ml-1.5 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-700"
              >餐點標籤連動</span>
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

      <div class="mt-2 flex flex-wrap items-center gap-2">
        <button
          class="rounded-xl bg-amber-50 px-4 py-2.5 text-sm text-amber-800 ring-1 ring-amber-200 active:bg-amber-100"
          @click="saveAsPreset"
        >
          ⭐ 存為常吃快選
        </button>
        <label class="cursor-pointer rounded-xl bg-slate-100 px-4 py-2.5 text-sm text-slate-700 active:bg-slate-200">
          📷 拍照 / 上傳
          <input type="file" accept="image/*" capture="environment" class="hidden" @change="onPhoto" />
        </label>
        <div v-if="photo" class="relative">
          <img :src="photo.preview" alt="meal preview" class="size-14 rounded-lg object-cover" />
          <button
            class="absolute -right-2 -top-2 size-6 rounded-full bg-slate-700 text-xs text-white"
            @click="photo = null"
          >
            ✕
          </button>
        </div>
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
        <li v-for="m in day.meals" :key="m.id" class="flex items-start gap-2 py-2">
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
          <button class="px-2 text-slate-300 active:text-rose-500" @click="removeMeal(m.id)">✕</button>
        </li>
      </ul>
    </section>
  </div>
</template>