<script setup>
import { computed, inject, reactive, ref } from 'vue'
import { LAB_FIELDS, URINE_QUALITATIVE, getBaselineDate, hydrationRangeFromWeight, live, updateCustom, resetCustom } from '../data/presets.js'
import { averageIntake, clampProposedTargets, evaluateLabs, summarizeDay } from '../services/gemini.js'
import { getGeminiKey, todayKey } from '../firebase.js'
import { sanitizeQualitative } from '../data/labContext.js'
import { parseBaselineLabs } from '../data/healthContextImport.js'
import LabTrendChart from './LabTrendChart.vue'
import ClinicReport from './ClinicReport.vue'

const props = defineProps({
  labs: { type: Array, required: true }, // follow-up labs, chronological
  days: { type: Object, required: true },
  patientName: { type: String, default: '' },
})
const emit = defineEmits(['add-lab', 'open-settings', 'apply-targets'])
const showToast = inject('showToast', () => {})

const reportOpen = ref(false)

const latest = computed(() => (props.labs.length ? props.labs[props.labs.length - 1] : null))

function statusOf(field, value) {
  if (value == null || value === '' || field.target == null) return 'none'
  return Number(value) < field.target ? 'met' : 'unmet'
}
const STATUS_STYLE = {
  met: 'bg-emerald-100 text-emerald-800',
  unmet: 'bg-amber-100 text-amber-800',
  none: 'bg-slate-100 text-slate-500',
}
const STATUS_TEXT = { met: '達標', unmet: '未達標', none: '—' }

function delta(field, value) {
  if (value == null || value === '' || field.baseline == null) return ''
  const d = Number(value) - field.baseline
  const sign = d > 0 ? '+' : ''
  return `${sign}${Math.round(d * 100) / 100}`
}

// ---------- form ----------
const today = todayKey()
const form = reactive({ date: today, u_sugar: '', u_ketones: '', note: '' })
for (const f of LAB_FIELDS) form[f.key] = ''
const formError = ref('')

function submit() {
  formError.value = ''
  if (!form.date) {
    formError.value = '請選擇檢驗日期。'
    return
  }
  // Urine dipstick values: normalize to the fixed scale (-, ±, + … ++++); reject anything else.
  const qual = {}
  for (const k of ['u_sugar', 'u_ketones']) {
    const raw = String(form[k] ?? '').trim()
    if (!raw) continue
    const v = sanitizeQualitative(raw)
    if (v == null) {
      formError.value = '尿糖 / 尿酮請填 -、±、+、++、+++、++++（或 陰性、微量）。'
      return
    }
    qual[k] = v
  }
  const lab = { date: form.date, note: form.note || '', u_sugar: qual.u_sugar || '', u_ketones: qual.u_ketones || '' }
  let count = 0
  for (const f of LAB_FIELDS) {
    if (form[f.key] !== '' && !Number.isNaN(Number(form[f.key]))) {
      lab[f.key] = Number(form[f.key])
      count++
    }
  }
  if (!count && !qual.u_sugar && !qual.u_ketones) {
    formError.value = '請至少填寫一項檢驗數值。'
    return
  }
  emit('add-lab', lab)
  for (const f of LAB_FIELDS) form[f.key] = ''
  form.u_sugar = form.u_ketones = form.note = ''
}

// ---------- baseline (personal values live in the custom config, never in the code) ----------
const baselineForm = reactive({ date: '', values: {} })
const baselineMsg = ref('')
function loadBaselineForm() {
  baselineForm.date = live.labBaseline.date || ''
  baselineForm.values = {}
  for (const f of [...LAB_FIELDS, ...URINE_QUALITATIVE]) baselineForm.values[f.key] = live.labBaseline.values[f.key] ?? ''
  baselineMsg.value = ''
}
loadBaselineForm()

/** Fill the baseline form from a local health_context.md (read in the browser, review, then press save). */
async function importBaselineFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  const { date, values } = parseBaselineLabs(await file.text())
  if (!Object.keys(values).length) {
    baselineMsg.value = '檔案裡找不到可辨識的檢驗數值（Glycemic / Lipids / Renal & Urine 區段）。'
    return
  }
  if (date) baselineForm.date = date
  for (const [k, v] of Object.entries(values)) baselineForm.values[k] = v
  baselineMsg.value = `已載入 ${Object.keys(values).length} 項，請檢查後按「儲存基準值」。`
}

function saveBaseline() {
  baselineMsg.value = ''
  if (!baselineForm.date) {
    baselineMsg.value = '請選擇基準檢驗日期。'
    return
  }
  const values = {}
  for (const f of LAB_FIELDS) {
    const raw = baselineForm.values[f.key]
    if (raw !== '' && raw != null && !Number.isNaN(Number(raw))) values[f.key] = Number(raw)
  }
  for (const u of URINE_QUALITATIVE) {
    const raw = String(baselineForm.values[u.key] ?? '').trim()
    if (!raw) continue
    const v = sanitizeQualitative(raw)
    if (v == null) {
      baselineMsg.value = '尿糖 / 尿酮請填 -、±、+、++、+++、++++（或 陰性、微量）。'
      return
    }
    values[u.key] = v
  }
  updateCustom('labBaseline', { date: baselineForm.date, values })
  loadBaselineForm()
  baselineMsg.value = '基準檢驗已儲存。'
}

function clearBaseline() {
  resetCustom('labBaseline')
  loadBaselineForm()
  baselineMsg.value = '已清除基準檢驗。'
}

// ---------- AI evaluation ----------
const evaluating = ref(false)
const evalError = ref('')
const evaluation = ref(null)
const intakeStats = ref(null)
const STATUS_DOT = { green: 'bg-emerald-500', yellow: 'bg-amber-400', red: 'bg-rose-500' }

function recentIntakeDays(days) {
  const start = new Date()
  start.setDate(start.getDate() - 29)
  const startKey = todayKey(start)
  const endKey = todayKey()
  return Object.keys(days)
    .filter((k) => k >= startKey && k <= endKey)
    .sort()
    .map((k) => summarizeDay(days[k]))
}

// Weight-based hydration band shown in the safety note (falls back to the 70 kg default band).
const hydrationBand = computed(() => hydrationRangeFromWeight(live.targets.userWeight))
const safeTargets = computed(() => clampProposedTargets(evaluation.value?.proposed_targets, live.targets))
const targetsMatch = computed(() => {
  const next = safeTargets.value
  if (!next) return false
  return Object.keys(next).every((k) => Number(live.targets[k]) === Number(next[k]))
})

function applyProposed() {
  if (!safeTargets.value || targetsMatch.value) return
  emit('apply-targets', { ...safeTargets.value })
}

async function runEvaluation() {
  evalError.value = ''
  const apiKey = getGeminiKey()
  if (!apiKey) {
    evalError.value = '尚未設定 Gemini API Key。'
    emit('open-settings')
    return
  }
  if (!props.labs.length) {
    evalError.value = '請先新增至少一筆追蹤檢驗結果。'
    return
  }
  evaluating.value = true
  try {
    const recentDays = recentIntakeDays(props.days)
    intakeStats.value = averageIntake(recentDays)
    evaluation.value = await evaluateLabs({ apiKey, labs: props.labs, recentDays })
  } catch (err) {
    evalError.value = err.message || String(err)
    showToast(evalError.value)
  } finally {
    evaluating.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <!-- Baseline vs targets -->
    <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="font-semibold text-slate-800">🧪 檢驗里程碑</h2>
        <button
          type="button"
          class="min-h-11 rounded-xl bg-teal-600 px-4 py-2 text-sm font-semibold text-white active:bg-teal-700"
          data-testid="open-report"
          @click="reportOpen = true"
        >
          🩺 回診報告匯出
        </button>
      </div>
      <p class="text-xs text-slate-500">
        基準日 {{ getBaselineDate() || '尚未設定' }} · 追蹤目標：11-12 個月後
        <span v-if="latest"> · 最新追蹤 {{ latest.date }}</span>
      </p>

      <div class="-mx-4 mt-3 overflow-x-auto px-4">
        <table class="w-full min-w-[420px] text-sm">
          <thead>
            <tr class="text-left text-xs text-slate-400">
              <th class="py-1 pr-2 font-medium">項目</th>
              <th class="py-1 pr-2 text-right font-medium">基準</th>
              <th class="py-1 pr-2 text-right font-medium">目標</th>
              <th class="py-1 pr-2 text-right font-medium">最新</th>
              <th class="py-1 text-right font-medium">狀態</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="f in LAB_FIELDS" :key="f.key">
              <td class="py-2 pr-2 text-slate-700">{{ f.label }}</td>
              <td class="py-2 pr-2 text-right text-slate-600">{{ f.baseline ?? '—' }} <span class="text-xs text-slate-400">{{ f.unit }}</span></td>
              <td class="py-2 pr-2 text-right text-slate-600">{{ f.targetLabel }}</td>
              <td class="py-2 pr-2 text-right font-medium text-slate-800">
                <template v-if="latest && latest[f.key] != null">
                  {{ latest[f.key] }}
                  <span class="text-xs text-slate-400">({{ delta(f, latest[f.key]) }})</span>
                </template>
                <template v-else>—</template>
              </td>
              <td class="py-2 text-right">
                <span class="rounded-full px-2 py-0.5 text-xs" :class="STATUS_STYLE[statusOf(f, latest?.[f.key])]">
                  {{ STATUS_TEXT[statusOf(f, latest?.[f.key])] }}
                </span>
              </td>
            </tr>
            <tr v-for="u in URINE_QUALITATIVE" :key="u.key">
              <td class="py-2 pr-2 text-slate-700">{{ u.label }}</td>
              <td class="py-2 pr-2 text-right text-slate-600">{{ u.baseline ?? '—' }}</td>
              <td class="py-2 pr-2 text-right text-slate-600">{{ u.key === 'u_ketones' ? '陰性' : '改善' }}</td>
              <td class="py-2 pr-2 text-right font-medium text-slate-800">{{ latest?.[u.key] || '—' }}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Baseline entry -->
    <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <details :open="!getBaselineDate()">
        <summary class="cursor-pointer text-sm font-semibold text-slate-800">📌 基準檢驗值（{{ getBaselineDate() || '尚未設定' }}）</summary>
        <p class="mt-1 text-xs text-slate-500">個人健康資料只存在你的瀏覽器與私人 Firestore，不會放進程式碼或公開網頁。</p>
        <label class="mt-3 inline-block cursor-pointer rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700 active:bg-slate-200">
          📂 從檔案匯入（health_context.md）
          <input type="file" accept=".md,.txt,text/plain,text/markdown" class="hidden" @change="importBaselineFile" />
        </label>
        <div class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label class="col-span-2 text-xs text-slate-500 sm:col-span-3">
            基準檢驗日期
            <input v-model="baselineForm.date" type="date" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-base text-slate-800" />
          </label>
          <label v-for="f in LAB_FIELDS" :key="f.key" class="text-xs text-slate-500">
            {{ f.label }} {{ f.unit }}
            <input v-model="baselineForm.values[f.key]" type="number" step="any" inputmode="decimal" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-base text-slate-800" />
          </label>
          <label v-for="u in URINE_QUALITATIVE" :key="u.key" class="text-xs text-slate-500">
            {{ u.label }}
            <input v-model="baselineForm.values[u.key]" placeholder="例如 +" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-base text-slate-800" />
          </label>
        </div>
        <p v-if="baselineMsg" class="mt-2 text-sm text-slate-600">{{ baselineMsg }}</p>
        <div class="mt-3 flex gap-2">
          <button type="button" class="flex-1 rounded-xl bg-teal-700 py-3 font-semibold text-white active:bg-teal-800" @click="saveBaseline">儲存基準值</button>
          <button type="button" class="rounded-xl bg-slate-100 px-4 py-3 text-sm text-slate-700" @click="clearBaseline">清除</button>
        </div>
      </details>
    </section>

    <!-- Lab trend charts -->
    <LabTrendChart :labs="labs" />

    <!-- Entry form -->
    <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <h2 class="font-semibold text-slate-800">➕ 新增追蹤檢驗結果</h2>
      <div class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label class="col-span-2 text-xs text-slate-500 sm:col-span-3">
          檢驗日期
          <input
            v-model="form.date"
            type="date"
            class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-base text-slate-800"
          />
        </label>
        <label v-for="f in LAB_FIELDS" :key="f.key" class="text-xs text-slate-500">
          {{ f.label }} {{ f.unit }}
          <input
            v-model="form[f.key]"
            type="number"
            step="any"
            inputmode="decimal"
            class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-base text-slate-800"
          />
        </label>
        <label class="text-xs text-slate-500">
          U-Sugar
          <input v-model="form.u_sugar" placeholder="例如 +" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-base text-slate-800" />
        </label>
        <label class="text-xs text-slate-500">
          U-Ketones
          <input v-model="form.u_ketones" placeholder="例如 -" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-base text-slate-800" />
        </label>
        <label class="col-span-2 text-xs text-slate-500 sm:col-span-3">
          備註
          <input v-model="form.note" class="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-base text-slate-800" />
        </label>
      </div>
      <p v-if="formError" class="mt-2 text-sm text-rose-600">{{ formError }}</p>
      <button class="mt-3 w-full rounded-xl bg-teal-700 py-3.5 font-semibold text-white active:bg-teal-800" @click="submit">
        儲存檢驗結果
      </button>

      <ul v-if="labs.length" class="mt-4 divide-y divide-slate-100 text-sm">
        <li v-for="l in [...labs].reverse()" :key="l.date" class="py-2 text-slate-600">
          <span class="font-medium text-slate-800">{{ l.date }}</span>
          <span v-for="f in LAB_FIELDS.filter((x) => l[x.key] != null)" :key="f.key" class="ml-2">
            {{ f.label }} {{ l[f.key] }}
          </span>
          <span v-if="l.note" class="ml-2 text-slate-400">— {{ l.note }}</span>
        </li>
      </ul>
    </section>

    <!-- AI evaluation -->
    <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <h2 class="font-semibold text-slate-800">🤖 AI 飲食階段評估</h2>
      <p class="text-xs text-slate-500">根據最新檢驗與近 30 天飲食紀錄，動態調整下一階段飲食方向。</p>
      <button
        class="mt-3 w-full rounded-xl bg-indigo-600 py-3.5 font-semibold text-white disabled:opacity-50 active:bg-indigo-700"
        :disabled="evaluating"
        @click="runEvaluation"
      >
        {{ evaluating ? 'AI 評估中…' : '✨ 以 AI 評估並調整飲食階段' }}
      </button>
      <p v-if="evalError" class="mt-2 rounded-lg bg-rose-50 p-2 text-sm text-rose-700">{{ evalError }}</p>

      <div v-if="evaluation" class="mt-4 space-y-3 text-sm text-slate-700">
        <div class="rounded-2xl bg-amber-50 p-4 ring-1 ring-amber-200">
          <h3 class="text-base font-semibold text-amber-950">動態飲食解封與階段調整建議</h3>
          <p v-if="intakeStats" class="mt-1 text-xs text-amber-800">
            近 30 天平均（{{ intakeStats.logged_days }} 天有紀錄；各項只算有記錄該項的天數）：碳水 {{ intakeStats.avg_carbs_g }} g · 飽和脂肪
            {{ intakeStats.avg_saturated_fat_g }} g（{{ intakeStats.macro_days }} 天）· 飲水 {{ intakeStats.avg_hydration_cc }} cc（{{ intakeStats.hydration_days }} 天）· 運動
            {{ intakeStats.avg_exercise_min }} 分
          </p>
          <p class="mt-2 text-amber-950">{{ evaluation.unlocking_summary || '尚無解封說明。' }}</p>
          <dl v-if="safeTargets" class="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <div class="rounded-lg bg-white/80 p-2">
              <dt class="text-amber-700">碳水 (g)</dt>
              <dd class="font-medium text-slate-800">{{ live.targets.carbsMin }}–{{ live.targets.carbsMax }} → {{ safeTargets.carbsMin }}–{{ safeTargets.carbsMax }}</dd>
            </div>
            <div class="rounded-lg bg-white/80 p-2">
              <dt class="text-amber-700">飽和脂肪 (g)</dt>
              <dd class="font-medium text-slate-800">{{ live.targets.satFatMin }}–{{ live.targets.satFatMax }} → {{ safeTargets.satFatMin }}–{{ safeTargets.satFatMax }}</dd>
            </div>
            <div class="rounded-lg bg-white/80 p-2">
              <dt class="text-amber-700">飲水 (cc)</dt>
              <dd class="font-medium text-slate-800">{{ live.targets.hydrationMin }}–{{ live.targets.hydrationMax }} → {{ safeTargets.hydrationMin }}–{{ safeTargets.hydrationMax }}</dd>
            </div>
            <div class="rounded-lg bg-white/80 p-2">
              <dt class="text-amber-700">運動 (分)</dt>
              <dd class="font-medium text-slate-800">{{ live.targets.exerciseTarget }} → {{ safeTargets.exerciseTarget }}</dd>
            </div>
          </dl>
          <button
            v-if="safeTargets"
            type="button"
            class="mt-3 w-full rounded-xl bg-amber-600 py-3 font-semibold text-white disabled:opacity-60 active:bg-amber-700"
            :disabled="targetsMatch"
            @click="applyProposed"
          >
            {{ targetsMatch ? '目前目標已符合建議' : '✨ 一鍵套用建議目標至設定' }}
          </button>
          <p class="mt-2 text-[11px] text-amber-800">套用時守住安全邊界：碳水 100–180 g、飽和脂肪上限 ≤ 20 g、飲水 {{ hydrationBand.hydrationMin }}–{{ hydrationBand.hydrationMax }} cc（依體重 {{ hydrationBand.userWeight }} kg，下限不低於 2000 cc）、運動 ≥ 20 分。</p>
        </div>
        <div class="rounded-xl bg-indigo-50 p-3">
          <p class="font-semibold text-indigo-900">{{ evaluation.phase_name }}</p>
          <p class="mt-1">{{ evaluation.overall_assessment }}</p>
        </div>
        <ul class="space-y-1">
          <li v-for="m in evaluation.metric_progress" :key="m.metric" class="flex items-start gap-2">
            <span class="mt-1.5 size-2.5 shrink-0 rounded-full" :class="STATUS_DOT[m.status]" />
            <span><b>{{ m.metric }}</b>：{{ m.comment }}</span>
          </li>
        </ul>
        <div>
          <p class="font-medium text-slate-800">飲食調整</p>
          <ul class="ml-5 list-disc">
            <li v-for="(a, i) in evaluation.dietary_adjustments" :key="i">{{ a }}</li>
          </ul>
        </div>
        <p><b>碳水：</b>{{ evaluation.carb_guidance }}</p>
        <p><b>飽和脂肪：</b>{{ evaluation.saturated_fat_guidance }}</p>
        <p><b>水分 / 鈉：</b>{{ evaluation.hydration_sodium_guidance }}</p>
        <div v-if="evaluation.safety_flags?.length" class="rounded-xl bg-rose-50 p-3 text-rose-800">
          <p class="font-medium">⚠️ 安全提醒</p>
          <ul class="ml-5 list-disc">
            <li v-for="(s, i) in evaluation.safety_flags" :key="i">{{ s }}</li>
          </ul>
        </div>
        <p class="text-xs text-slate-400">AI 建議僅供參考，不能取代醫師診斷；用藥調整請與醫師討論。</p>
      </div>
    </section>
    <ClinicReport v-if="reportOpen" :days="days" :labs="labs" :patient-name="patientName" @close="reportOpen = false" />
  </div>
</template>
