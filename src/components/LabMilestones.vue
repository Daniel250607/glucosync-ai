<script setup>
import { computed, inject, reactive, ref } from 'vue'
import { LAB_FIELDS, URINE_QUALITATIVE, BASELINE_DATE } from '../data/presets.js'
import { evaluateLabs, summarizeDay } from '../services/gemini.js'
import { getGeminiKey, todayKey } from '../firebase.js'

const props = defineProps({
  labs: { type: Array, required: true }, // follow-up labs, chronological
  days: { type: Object, required: true },
})
const emit = defineEmits(['add-lab', 'open-settings'])
const showToast = inject('showToast', () => {})

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
  if (value == null || value === '') return ''
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
  const lab = { date: form.date, note: form.note || '', u_sugar: form.u_sugar, u_ketones: form.u_ketones }
  let count = 0
  for (const f of LAB_FIELDS) {
    if (form[f.key] !== '' && !Number.isNaN(Number(form[f.key]))) {
      lab[f.key] = Number(form[f.key])
      count++
    }
  }
  if (!count && !form.u_sugar && !form.u_ketones) {
    formError.value = '請至少填寫一項檢驗數值。'
    return
  }
  emit('add-lab', lab)
  for (const f of LAB_FIELDS) form[f.key] = ''
  form.u_sugar = form.u_ketones = form.note = ''
}

// ---------- AI evaluation ----------
const evaluating = ref(false)
const evalError = ref('')
const evaluation = ref(null)
const STATUS_DOT = { green: 'bg-emerald-500', yellow: 'bg-amber-400', red: 'bg-rose-500' }

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
    const recentDays = Object.keys(props.days)
      .sort()
      .slice(-14)
      .map((k) => summarizeDay(props.days[k]))
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
      <h2 class="font-semibold text-slate-800">🧪 檢驗里程碑</h2>
      <p class="text-xs text-slate-500">
        基準日 {{ BASELINE_DATE }}（115/09/05）· 追蹤目標：11-12 個月後
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
              <td class="py-2 pr-2 text-right text-slate-600">{{ f.baseline }} <span class="text-xs text-slate-400">{{ f.unit }}</span></td>
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
              <td class="py-2 pr-2 text-right text-slate-600">{{ u.baseline }}</td>
              <td class="py-2 pr-2 text-right text-slate-600">{{ u.key === 'u_ketones' ? '陰性' : '改善' }}</td>
              <td class="py-2 pr-2 text-right font-medium text-slate-800">{{ latest?.[u.key] || '—' }}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </section>

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
      <p class="text-xs text-slate-500">根據最新檢驗與近 14 天飲食紀錄，動態調整下一階段飲食方向。</p>
      <button
        class="mt-3 w-full rounded-xl bg-indigo-600 py-3.5 font-semibold text-white disabled:opacity-50 active:bg-indigo-700"
        :disabled="evaluating"
        @click="runEvaluation"
      >
        {{ evaluating ? 'AI 評估中…' : '✨ 以 AI 評估並調整飲食階段' }}
      </button>
      <p v-if="evalError" class="mt-2 rounded-lg bg-rose-50 p-2 text-sm text-rose-700">{{ evalError }}</p>

      <div v-if="evaluation" class="mt-4 space-y-3 text-sm text-slate-700">
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
  </div>
</template>
