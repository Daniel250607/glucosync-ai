<script setup>
import { computed, inject, onBeforeUnmount, reactive, ref } from 'vue'
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

// ---------- hydration ----------
const TARGETS = computed(() => live.targets)
const hydrationPct = computed(() =>
  Math.min(100, Math.round(((props.day.hydration_cc || 0) / (TARGETS.value.hydrationMax || 1)) * 100)),
)
const hydrationMinPct = computed(() => (TARGETS.value.hydrationMin / (TARGETS.value.hydrationMax || 1)) * 100)
const hydrationReached = computed(() => (props.day.hydration_cc || 0) >= TARGETS.value.hydrationMin)
function addWater(cc) {
  commit((d) => (d.hydration_cc = Math.max(0, (d.hydration_cc || 0) + cc)))
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

// ---------- exercise (彈性化重構) ----------
const EXERCISE_TYPES = ['餐後踏步', '戶外散步', '慢跑/路跑', '健身房跑步機', '重訓/肌力', '騎車']
const exerciseForm = reactive({ type: '餐後踏步', duration: '', note: '' })

function syncExerciseTotal(d) {
  d.exercise_logs = d.exercise_logs || []
  d.exercise_min = d.exercise_logs.reduce((sum, item) => sum + (Number(item.duration_min) || 0), 0)
}

function addExerciseLog(quickMin = null) {
  const d_min = Number(quickMin) || Number(exerciseForm.duration)
  if (!d_min || d_min <= 0) return

  commit((d) => {
    d.exercise_logs = d.exercise_logs || []
    d.exercise_logs.push({
      id: `ex-${Date.now()}`,
      time: nowTime(),
      type: exerciseForm.type,
      duration_min: d_min,
      note: exerciseForm.note.trim(),
      source: 'manual'
    })
    syncExerciseTotal(d)
  })
  exerciseForm.duration = ''
  exerciseForm.note = ''
}

function removeExerciseLog(id) {
  commit((d) => {
    d.exercise_logs = (d.exercise_logs || []).filter(x => x.id !== id)
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
  elapsedTimer = setInterval(() => { elapsed.value += 1 }, 1000)
}
function stopBusy() {
  busy.value = false
  clearInterval(elapsedTimer)
  elapsedTimer = null
}
onBeforeUnmount(stopBusy)

function applyPreset(p) { mealText.value = p.description }
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
    
    // 餐點標籤運動自動連動扣抵
    if (entry.tags.includes('[餐後踏步 20分]')) {
      d.exercise_logs = d.exercise_logs || []
      d.exercise_logs.push({
        id: `ex-meal-${Date.now()}`,
        time: entry.time,
        type: '餐後踏步',
        duration_min: 20,
        note: `來自餐點標籤連動`,
        source: 'meal_tag'
      })
      syncExerciseTotal(d)
    }
  })
  
  latestId.value = withAI ? id : null
  resetMealForm()
}

function removeMeal(id) {
  commit((d) => (d.meals = d.meals.filter((m) => m.id !== id)))
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
    <!-- Hydration -->
    <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <div class="flex items-baseline justify-between">
        <h2 class="font-semibold text-slate-800">💧 飲水</h2>
        <span class="text-sm" :class="hydrationReached ? 'text-emerald-600 font-semibold' : 'text-slate-500'">
          {{ day.hydration_cc || 0 }} / {{ TARGETS.hydrationMin }}-{{ TARGETS.hydrationMax }} cc
        </span>
      </div>
      <div class="relative mt-3 h-4 overflow-hidden rounded-full bg-slate-100">
        <div class="h-full rounded-full transition-all" :class="hydrationReached ? 'bg-emerald-500' : 'bg-sky-500'" :style="{ width: hydrationPct + '%' }" />
        <div class="absolute inset-y-0 w-0.5 bg-slate-400/70" :style="{ left: hydrationMinPct + '%' }" />
      </div>
      <div class="mt-3 grid grid-cols-3 gap-2">
        <button class="rounded-xl bg-sky-600 py-3 font-medium text-white active:bg-sky-700" @click="addWater(300)">+300cc</button>
        <button class="rounded-xl bg-sky-600 py-3 font-medium text-white active:bg-sky-700" @click="addWater(500)">+500cc</button>
        <button class="rounded-xl bg-slate-100 py-3 text-slate-600 active:bg-slate-200" @click="addWater(-300)">−300cc</button>
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
          <p class="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">{{ slot === 'morning' ? '早上' : '晚上' }}</p>
          <label v-for="m in medsForSlot(slot)" :key="m.id" class="flex min-h-11 items-center gap-3 rounded-lg px-1 py-1.5 active:bg-slate-50">
            <input type="checkbox" class="size-5 accent-emerald-600" :checked="day.meds?.[slot]?.[m.id]" @change="toggleMed(slot, m.id)" />
            <span class="text-sm" :class="day.meds?.[slot]?.[m.id] ? 'text-slate-400 line-through' : 'text-slate-700'">{{ medLabel(m) }}</span>
          </label>
          <p v-if="!medsForSlot(slot).length" class="px-1 text-xs text-slate-400">無藥物 (可於 ⚙️ 設定 → 個人目標與用藥調整 新增)</p>
        </div>
      </div>
    </section>

    <!-- Exercise -->
    <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <div class="flex items-baseline justify-between">
        <h2 class="font-semibold text-slate-800">🏃 運動紀錄</h2>
        <span class="text-sm" :class="exerciseReached ? 'text-emerald-600 font-semibold' : 'text-slate-500'">
          {{ day.exercise_min || 0 }} 分鐘 (目標 {{ TARGETS.exerciseTarget }} 分)
        </span>
      </div>
      
      <div class="mt-3 space-y-3">
        <div class="flex flex-wrap gap-2">
          <button v-for="t in EXERCISE_TYPES" :key="t" class="rounded-md px-2.5 py-1.5 text-sm"
            :class="exerciseForm.type === t ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-700'"
            @click="exerciseForm.type = t">{{ t }}</button>
        </div>

        <div class="flex flex-wrap gap-2">
          <input v-model="exerciseForm.duration" type="number" placeholder="分鐘" class="w-20 rounded-lg border border-slate-300 p-2 text-base text-slate-800" />
          <button class="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700 active:bg-slate-200" @click="addExerciseLog(15)">+15分</button>
          <button class="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700 active:bg-slate-200" @click="addExerciseLog(20)">+20分</button>
          <input v-model="exerciseForm.note" type="text" placeholder="選填備註 (如坡度/配速)" class="min-w-0 flex-1 rounded-lg border border-slate-300 p-2 text-base text-slate-800" />
        </div>
        <button class="w-full rounded-xl bg-teal-600 py-3 font-medium text-white active:bg-teal-700" @click="addExerciseLog()">➕ 新增紀錄</button>
      </div>

      <div v-if="day.exercise_logs?.length" class="mt-4 border-t border-slate-100 pt-3">
        <ul class="divide-y divide-slate-100">
          <li v-for="log in day.exercise_logs" :key="log.id" class="flex items-start gap-2 py-2">
            <span class="mt-0.5 text-xs text-slate-400">{{ log.time }}</span>
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium text-slate-800">
                {{ log.type }} <span class="text-teal-600">{{ log.duration_min }} 分鐘</span>
                <span v-if="log.source === 'meal_tag'" class="ml-2 inline-flex items-center rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-700">餐點連動</span>
              </p>
              <p v-if="log.note" class="mt-0.5 text-xs text-slate-500">{{ log.note }}</p>
            </div>
            <button class="px-2 text-slate-300 active:text-rose-500" @click="removeExerciseLog(log.id)">✕</button>
          </li>
        </ul>
        <button class="mt-2 text-xs text-rose-500 active:text-rose-600" @click="clearExerciseLogs">清空當日運動</button>
      </div>
    </section>

    <!-- Meal logging -->
    <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <div class="flex items-start justify-between gap-2">
        <div>
          <h2 class="font-semibold text-slate-800">🍱 記錄餐點</h2>
          <p class="mt-0.5 text-xs text-slate-500">進食順序：蔬菜 → 蛋白質 → 澱粉 (半份)</p>
        </div>
        <button class="shrink-0 rounded-lg px-3 py-2 text-sm" :class="editMode ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-700 active:bg-slate-200'" @click="editMode = !editMode">
          {{ editMode ? '✓ 完成編輯' : '⚙️ 編輯快選' }}
        </button>
      </div>

      <template v-if="!editMode">
        <div class="mt-3 space-y-2">
          <div v-for="(list, cat) in presetGroups" :key="cat">
            <p class="mb-1 text-xs font-medium text-slate-400">{{ cat }}</p>
            <div class="flex flex-wrap gap-2">
              <button v-for="p in list" :key="p.id" class="rounded-full border px-3 py-1.5 text-sm active:bg-teal-100" :class="mealText === p.description ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-slate-300 text-slate-700'" @click="applyPreset(p)">{{ p.label }}</button>
            </div>
          </div>
          <p v-if="!live.presets.length" class="text-sm text-slate-400">尚無快選按鈕，請按「⚙️ 編輯快選」新增，或直接輸入餐點後按「⭐ 存為常吃快選」。</p>
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          <button v-for="t in live.tags" :key="t" class="rounded-md px-2.5 py-1.5 text-sm" :class="selectedTags.includes(t) ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-700'" @click="toggleTag(t)">{{ t }}</button>
        </div>
      </template>

      <div v-else class="mt-3 space-y-4 rounded-xl border border-teal-200 bg-teal-50/40 p-3">
        <datalist id="preset-categories"><option v-for="c in presetCategories" :key="c" :value="c" /></datalist>
        <p class="text-xs text-slate-500">修改後即自動儲存。分類可輸入任何名稱 (例如：平日、外食、在家、假日或自訂)。</p>
        <div v-for="(list, cat) in presetGroups" :key="cat" class="space-y-2">
          <p class="text-xs font-semibold text-teal-800">{{ cat }}</p>
          <div v-for="p in list" :key="p.id" class="space-y-1.5 rounded-lg bg-white p-2.5 ring-1 ring-slate-200">
            <div class="flex gap-2">
              <input :value="p.label" placeholder="按鈕名稱" class="min-w-0 flex-1 rounded-lg border border-slate-300 p-2 text-base" @change="onPresetEdit(p.id, 'label', $event)" />
              <input :value="p.category" list="preset-categories" placeholder="分類" class="w-24 rounded-lg border border-slate-300 p-2 text-base" @change="onPresetEdit(p.id, 'category', $event)" />
              <button class="grid size-10 shrink-0 place-items-center rounded-lg bg-rose-50 text-rose-600 active:bg-rose-100" aria-label="刪除快選" @click="deletePreset(p.id)">🗑</button>
            </div>
            <textarea :value="p.description" rows="2" placeholder="完整餐點描述" class="w-full rounded-lg border border-slate-300 p-2 text-sm" @change="onPresetEdit(p.id, 'description', $event)" />
          </div>
        </div>
        <div class="space-y-1.5 rounded-lg border border-dashed border-teal-400 bg-white p-2.5">
          <p class="text-sm font-medium text-slate-700">➕ 新增快選按鈕</p>
          <div class="flex gap-2">
            <input v-model="newPreset.label" placeholder="簡短按鈕名稱" class="min-w-0 flex-1 rounded-lg border border-slate-300 p-2 text-base" />
            <input v-model="newPreset.category" list="preset-categories" placeholder="分類" class="w-24 rounded-lg border border-slate-300 p-2 text-base" />
          </div>
          <textarea v-model="newPreset.description" rows="2" placeholder="完整餐點描述" class="w-full rounded-lg border border-slate-300 p-2 text-sm" />
          <button class="w-full rounded-lg bg-teal-600 py-2.5 font-medium text-white active:bg-teal-700" @click="addPreset">新增快選</button>
        </div>
        <div class="space-y-2">
          <p class="text-xs font-semibold text-teal-800">修飾標籤</p>
          <div class="flex flex-wrap gap-2">
            <span v-for="t in live.tags" :key="t" class="inline-flex items-center gap-1 rounded-md bg-white py-1 pl-2.5 pr-1 text-sm text-slate-700 ring-1 ring-slate-200">
              {{ t }}
              <button class="grid size-7 place-items-center rounded text-rose-500 active:bg-rose-50" aria-label="刪除標籤" @click="deleteTag(t)">✕</button>
            </span>
            <span v-if="!live.tags.length" class="text-sm text-slate-400">尚無標籤</span>
          </div>
          <div class="flex gap-2">
            <input v-model="newTag" placeholder="例如：加點燙青菜" class="min-w-0 flex-1 rounded-lg border border-slate-300 p-2 text-base" @keyup.enter="addTag" />
            <button class="shrink-0 rounded-lg bg-teal-600 px-4 py-2 font-medium text-white active:bg-teal-700" @click="addTag">新增標籤</button>
          </div>
        </div>
        <p v-if="manageError" class="rounded-lg bg-rose-50 p-2 text-sm text-rose-700">{{ manageError }}</p>
        <button class="w-full rounded-lg bg-white py-2.5 text-sm text-rose-600 ring-1 ring-rose-200 active:bg-rose-50" @click="resetMenu">↩︎ 恢復預設菜單</button>
      </div>

      <textarea v-model="mealText" rows="3" placeholder="描述餐點，例如：雞腿便當，飯吃一半…" class="mt-3 w-full rounded-xl border border-slate-300 p-3 text-base focus:border-teal-500 focus:outline-none" />

      <div class="mt-2 flex flex-wrap items-center gap-2">
        <button class="rounded-xl bg-amber-50 px-4 py-2.5 text-sm text-amber-800 ring-1 ring-amber-200 active:bg-amber-100" @click="saveAsPreset">⭐ 存為常吃快選</button>
        <label class="cursor-pointer rounded-xl bg-slate-100 px-4 py-2.5 text-sm text-slate-700 active:bg-slate-200">
          📷 拍照 / 上傳
          <input type="file" accept="image/*" capture="environment" class="hidden" @change="onPhoto" />
        </label>
        <div v-if="photo" class="relative">
          <img :src="photo.preview" alt="meal preview" class="size-14 rounded-lg object-cover" />
          <button class="absolute -right-2 -top-2 size-6 rounded-full bg-slate-700 text-xs text-white" @click="photo = null">✕</button>
        </div>
      </div>
      <p v-if="error" class="mt-2 rounded-lg bg-rose-50 p-2 text-sm text-rose-700">{{ error }}</p>
      <div class="mt-3 grid grid-cols-3 gap-2">
        <button class="col-span-2 rounded-xl bg-teal-700 py-3.5 font-semibold text-white disabled:opacity-50 active:bg-teal-800" :disabled="busy" @click="submitMeal(true)">
          {{ busy ? \`AI 分析中… \${elapsed}s\` : '✨ AI 分析並記錄' }}
        </button>
        <button class="rounded-xl bg-slate-100 py-3.5 text-slate-700 disabled:opacity-50 active:bg-slate-200" :disabled="busy" @click="submitMeal(false)">只記錄</button>
      </div>
    </section>

    <!-- Real-time alert cards -->
    <section v-if="mealToShow?.analysis" class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <h2 class="font-semibold text-slate-800">🚦 {{ mealToShow.analysis.meal_name }}</h2>
      <p class="mt-1 text-xs text-slate-500">
        約 {{ Math.round(mealToShow.analysis.estimated_calories_kcal) }} kcal · 蛋白質 {{ mealToShow.analysis.macronutrients.protein_g }}g · 碳水 {{ mealToShow.analysis.macronutrients.carbs_g }}g · 脂肪 {{ mealToShow.analysis.macronutrients.fat_g }}g (飽和 {{ mealToShow.analysis.macronutrients.saturated_fat_g }}g) · 纖維 {{ mealToShow.analysis.macronutrients.dietary_fiber_g }}g · 鈉 {{ mealToShow.analysis.macronutrients.sodium_mg }}mg
      </p>
      <div class="mt-3 grid gap-2 sm:grid-cols-2">
        <div v-for="a in ALERTS" :key="a.key" class="rounded-xl border p-3" :class="LEVEL_STYLE[mealToShow.analysis[a.key]?.level] || 'bg-slate-50 border-slate-200'">
          <div class="flex items-center gap-2 text-sm font-semibold">
            <span class="size-3 rounded-full" :class="DOT_STYLE[mealToShow.analysis[a.key]?.level]" />
            {{ a.title }}
            <span class="ml-auto text-xs font-normal opacity-70">{{ LEVEL_TEXT[mealToShow.analysis[a.key]?.level] }}</span>
          </div>
          <p class="mt-1 text-sm">{{ mealToShow.analysis[a.key]?.message }}</p>
        </div>
      </div>
      <p class="mt-3 rounded-xl bg-slate-50 p-3 text-sm text-slate-700">💡 {{ mealToShow.analysis.actionable_advice }}</p>
    </section>

    <!-- Meal log -->
    <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <div class="flex items-baseline justify-between">
        <h2 class="font-semibold text-slate-800">📋 今日餐點</h2>
        <span class="text-xs text-slate-500">碳水 {{ totals.carbs_g }}g · 飽和脂肪 {{ totals.saturated_fat_g }}g · 鈉 {{ totals.sodium_mg }}mg</span>
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
            <span v-for="a in ALERTS" :key="a.key" class="size-2.5 rounded-full" :class="DOT_STYLE[m.analysis[a.key]?.level]" :title="a.title" />
          </div>
          <button class="px-2 text-slate-300 active:text-rose-500" @click="removeMeal(m.id)">✕</button>
        </li>
      </ul>
    </section>
  </div>
</template>