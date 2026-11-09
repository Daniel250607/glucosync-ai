<script setup>
// 檢驗趨勢圖: one small line chart per key lab (baseline + every follow-up value) with its target line,
// plus a body-weight chart (irregular weigh-ins) with the standard weight band from the user's height.
// The x axis is a linear day scale, so points are spaced by the real number of days between dates.
// Values go through sanitizeLabNumber / sanitizeWeight, so typos or imported junk never reach a chart.
// Charts are destroyed before every re-render and on unmount.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Chart, LineController, LineElement, PointElement, LinearScale, Legend, Tooltip, Filler } from 'chart.js'
import { BMI_NORMAL, bmiOf, getBaselineDate, LAB_FIELDS, sanitizeWeight, weightRangeFromHeight } from '../data/presets.js'
import { sanitizeLabDate, sanitizeLabNumber } from '../data/labContext.js'

Chart.register(LineController, LineElement, PointElement, LinearScale, Legend, Tooltip, Filler)

const props = defineProps({
  labs: { type: Array, default: () => [] },
  weights: { type: Array, default: () => [] }, // [{ date, kg }]
  heightCm: { type: Number, default: 0 },
})

const CHART_KEYS = ['hba1c', 'ldl', 'tg', 'uacr', 'ac_sugar', 'egfr']
/** Reference lines for fields without a numeric target in LAB_FIELDS (shown as "參考", not a goal). */
const REFERENCE = { egfr: { value: 90, label: '參考 ≥ 90（正常腎功能）', higherIsBetter: true } }
const COLORS = { line: '#0f766e', met: '#059669', unmet: '#e11d48', neutral: '#0f766e', target: 'rgba(5,150,105,0.9)', band: 'rgba(16,185,129,0.10)' }
const DAY_MS = 86400000

const fields = CHART_KEYS.map((k) => LAB_FIELDS.find((f) => f.key === k)).filter(Boolean)

/** 'YYYY-MM-DD' <-> day number (UTC), so the x axis spaces points by real days. */
const dayNum = (date) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / DAY_MS
const dayStr = (n) => new Date(Math.round(n) * DAY_MS).toISOString().slice(0, 10)

/** Points per field: baseline + follow-ups (one per date; follow-up wins over baseline on the same date). */
const seriesByField = computed(() => {
  const out = {}
  for (const f of fields) {
    const bd = getBaselineDate()
    const byDate = new Map(bd && f.baseline != null ? [[bd, { date: bd, value: f.baseline, baseline: true }]] : [])
    for (const raw of Array.isArray(props.labs) ? props.labs : []) {
      if (!raw || typeof raw !== 'object') continue
      const date = sanitizeLabDate(raw.date)
      const v = sanitizeLabNumber(f.key, raw[f.key])
      if (!date || v == null) continue
      byDate.set(date, { date, value: v, baseline: false })
    }
    out[f.key] = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
  }
  return out
})

const weightSeries = computed(() =>
  (Array.isArray(props.weights) ? props.weights : [])
    .map((w) => ({ date: sanitizeLabDate(w?.date), value: sanitizeWeight(w?.kg) }))
    .filter((p) => p.date && p.value != null)
    .sort((a, b) => a.date.localeCompare(b.date)),
)
const weightRange = computed(() => weightRangeFromHeight(props.heightCm))

const followUpCount = (key) => (seriesByField.value[key] || []).filter((p) => !p.baseline).length
const hasAnyFollowUp = computed(() => fields.some((f) => followUpCount(f.key) > 0))
const chartFields = computed(() => fields.filter((f) => followUpCount(f.key) > 0))
const baselineOnlyFields = computed(() => fields.filter((f) => followUpCount(f.key) === 0))

const canvases = {}
const charts = {}
function setCanvas(key, el) {
  if (el) canvases[key] = el
  else delete canvases[key]
}

function labPointColor(f, v) {
  if (f.dir === 'lt' && f.target != null) return v < f.target ? COLORS.met : COLORS.unmet
  const ref = REFERENCE[f.key]
  if (ref) return v >= ref.value ? COLORS.met : COLORS.unmet
  return COLORS.neutral
}

/**
 * Shared line-chart config on a day-number x axis.
 * lines: horizontal reference lines [{ value, label, fill }] (fill: 'origin' | '-1' | false).
 * yValues: values the y range must include besides the points.
 */
function lineChartConfig({ pts, label, unit, pointColor, lines = [], yValues = [], tooltipLabel }) {
  const xs = pts.map((p) => dayNum(p.date))
  const values = pts.map((p) => p.value)
  const xMin = Math.min(...xs)
  const xMax = Math.max(...xs)
  const xPad = Math.max(3, (xMax - xMin) * 0.05)
  const lo = xMin - xPad
  const hi = xMax + xPad
  const datasets = [
    {
      label,
      data: pts.map((p, i) => ({ x: xs[i], y: p.value })),
      borderColor: COLORS.line,
      backgroundColor: COLORS.line,
      pointBackgroundColor: values.map(pointColor),
      pointBorderColor: values.map(pointColor),
      pointRadius: 5,
      pointHoverRadius: 7,
      borderWidth: 2.5,
      tension: 0.2,
      order: 1,
    },
  ]
  for (const line of lines) {
    datasets.push({
      label: line.label,
      isThreshold: true,
      data: [{ x: lo, y: line.value }, { x: hi, y: line.value }],
      borderColor: COLORS.target,
      backgroundColor: COLORS.band,
      borderDash: [6, 4],
      borderWidth: 1.5,
      pointRadius: 0,
      pointHoverRadius: 0,
      fill: line.fill || false, // shaded band = target zone
      order: 2,
    })
  }
  const all = [...values, ...yValues]
  const min = Math.min(...all)
  const max = Math.max(...all)
  const pad = (max - min || Math.abs(max) || 1) * 0.15
  return {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, padding: 8, font: { size: 11 } } },
        tooltip: {
          filter: (item) => !item.dataset.isThreshold,
          callbacks: {
            title: (items) => {
              const p = items && items[0] ? pts[items[0].dataIndex] : null
              return p ? `${p.date}${p.baseline ? '（基準）' : ''}` : ''
            },
            label: (ctx) => tooltipLabel(ctx.raw.y),
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          min: lo,
          max: hi,
          grid: { display: false },
          ticks: { font: { size: 10 }, maxTicksLimit: 6, precision: 0, callback: (v) => dayStr(v).slice(2).replace(/-/g, '/') },
        },
        y: { suggestedMin: Math.max(0, min - pad), suggestedMax: max + pad, title: { display: Boolean(unit), text: unit } },
      },
    },
  }
}

function labConfig(f) {
  const unit = f.unit || ''
  const lines = []
  if (f.dir === 'lt' && f.target != null) lines.push({ value: f.target, label: `目標 ${f.targetLabel}${unit ? ` ${unit}` : ''}`, fill: 'origin' })
  else if (REFERENCE[f.key]) lines.push({ value: REFERENCE[f.key].value, label: REFERENCE[f.key].label })
  return lineChartConfig({
    pts: seriesByField.value[f.key] || [],
    label: `${f.label}${unit ? ` (${unit})` : ''}`,
    unit,
    pointColor: (v) => labPointColor(f, v),
    lines,
    yValues: lines.map((l) => l.value),
    tooltipLabel: (v) => {
      let status = ''
      if (f.dir === 'lt' && f.target != null) status = v < f.target ? '已達標' : '未達標'
      else if (REFERENCE[f.key]) status = v >= REFERENCE[f.key].value ? '參考範圍內' : '低於參考'
      return `${f.label}：${v}${unit ? ` ${unit}` : ''}${status ? `（${status}）` : ''}`
    },
  })
}

function weightConfig() {
  const pts = weightSeries.value
  const r = weightRange.value
  const values = pts.map((p) => p.value)
  const lines = r
    ? [
        { value: r.min, label: `標準下限 ${r.min} kg（BMI ${BMI_NORMAL[0]}）` },
        { value: r.max, label: `標準上限 ${r.max} kg（BMI ${BMI_NORMAL[1]}）`, fill: '-1' }, // band between the two lines
      ]
    : []
  // Keep the band edge(s) near the data in view without squashing the weight line.
  const yValues = []
  if (r) {
    if (Math.max(...values) >= r.min) yValues.push(r.max)
    if (Math.min(...values) <= r.max) yValues.push(r.min)
  }
  return lineChartConfig({
    pts,
    label: '體重 (kg)',
    unit: 'kg',
    pointColor: (v) => (!r ? COLORS.neutral : v >= r.min && v <= r.max ? COLORS.met : COLORS.unmet),
    lines,
    yValues,
    tooltipLabel: (v) => {
      const bmi = bmiOf(v, props.heightCm)
      const status = r ? (v < r.min ? '低於標準' : v > r.max ? '高於標準' : '標準範圍內') : ''
      return `體重：${v} kg${bmi != null ? ` · BMI ${bmi}` : ''}${status ? `（${status}）` : ''}`
    },
  })
}

function destroyCharts() {
  for (const k of Object.keys(charts)) {
    charts[k]?.destroy()
    delete charts[k]
  }
}

async function render() {
  destroyCharts()
  await nextTick() // canvases for newly added fields are mounted after the DOM update
  destroyCharts() // a concurrent render may have created charts meanwhile
  for (const f of chartFields.value) {
    const el = canvases[f.key]
    if (el) charts[f.key] = new Chart(el, labConfig(f))
  }
  if (weightSeries.value.length && canvases.weight) charts.weight = new Chart(canvases.weight, weightConfig())
}

// Mobile: Chart.js keeps the tooltip open after a tap; hide it when tapping anywhere outside that chart
// (same behavior as TrendChart).
function hideTooltipOnOutsideTap(e) {
  for (const chart of Object.values(charts)) {
    if (!chart || (chart.canvas && chart.canvas.contains(e.target))) continue
    if (!chart.getActiveElements().length && !chart.tooltip?.getActiveElements().length) continue
    chart.setActiveElements([])
    chart.tooltip?.setActiveElements([], { x: 0, y: 0 })
    chart.update('none')
  }
}

onMounted(() => {
  render()
  document.addEventListener('pointerdown', hideTooltipOnOutsideTap)
  document.addEventListener('touchstart', hideTooltipOnOutsideTap, { passive: true })
})
watch([seriesByField, weightSeries, weightRange], render)
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', hideTooltipOnOutsideTap)
  document.removeEventListener('touchstart', hideTooltipOnOutsideTap, { passive: true })
  destroyCharts()
})

const latestWeight = computed(() => weightSeries.value[weightSeries.value.length - 1] || null)
</script>

<template>
  <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200" data-testid="lab-trends">
    <h2 class="font-semibold text-slate-800">📉 檢驗趨勢圖</h2>
    <p class="mt-1 text-xs text-slate-500">基準值（{{ getBaselineDate() || '未設定' }}）＋每次追蹤結果；橫軸依實際日期排列。虛線＝目標值，淺綠帶＝目標範圍。綠點＝已達標、紅點＝未達標。</p>
    <p v-if="!hasAnyFollowUp" class="mt-4 rounded-xl bg-slate-50 p-4 text-center text-sm text-slate-500" data-testid="lab-trends-empty">
      目前只有基準值（{{ getBaselineDate() || '未設定' }}），尚無追蹤檢驗。<br />在下方「新增追蹤檢驗結果」輸入下一次的報告後，這裡就會顯示趨勢圖。
    </p>
    <div v-else class="mt-3 grid gap-4 md:grid-cols-2">
      <div v-for="f in chartFields" :key="f.key" :data-lab-chart="f.key">
        <h3 class="text-sm font-medium text-slate-700">
          {{ f.label }} <span class="text-xs font-normal text-slate-400">{{ f.unit }}{{ f.target != null ? ` · 目標 ${f.targetLabel}` : '' }}</span>
        </h3>
        <div class="mt-1 h-56"><canvas :ref="(el) => setCanvas(f.key, el)" role="img" :aria-label="f.label + ' 趨勢圖'" /></div>
      </div>
    </div>
    <p v-if="hasAnyFollowUp && baselineOnlyFields.length" class="mt-2 text-xs text-slate-400" data-testid="lab-trends-baseline-only">
      尚無追蹤值（只有基準）：{{ baselineOnlyFields.map((f) => f.label).join('、') }}
    </p>

    <div class="mt-4 border-t border-slate-100 pt-3" data-lab-chart="weight">
      <h3 class="text-sm font-medium text-slate-700">
        ⚖️ 體重
        <span class="text-xs font-normal text-slate-400">
          kg<template v-if="weightRange"> · 標準 {{ weightRange.min }}–{{ weightRange.max }}（BMI 18.5–24）· 理想 {{ weightRange.ideal }}</template>
          <template v-if="latestWeight"> · 最新 {{ latestWeight.value }}（{{ latestWeight.date }}）</template>
        </span>
      </h3>
      <div v-if="weightSeries.length" class="mt-1 h-56"><canvas :ref="(el) => setCanvas('weight', el)" role="img" aria-label="體重趨勢圖" /></div>
      <p v-else class="mt-2 rounded-xl bg-slate-50 p-3 text-center text-sm text-slate-500" data-testid="weight-trend-empty">
        尚無體重紀錄。在「今日記錄」的 ⚖️ 體重欄位，或下方追蹤檢驗表單填寫體重後，這裡就會顯示趨勢（不用每天記）。
      </p>
      <p v-if="!weightRange" class="mt-1 text-xs text-slate-400">到「設定 → 個人目標」填寫身高，圖上會標出標準體重範圍。</p>
    </div>
  </section>
</template>
