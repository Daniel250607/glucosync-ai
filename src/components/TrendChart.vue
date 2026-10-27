<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Chart,
  BarController,
  LineController,
  BarElement,
  LineElement,
  PointElement,
  CategoryScale,
  LinearScale,
  Legend,
  Tooltip,
  Filler,
} from 'chart.js'
import { live } from '../data/presets.js'
import { compliance, dayFlags } from '../data/report.js'

Chart.register(
  BarController,
  LineController,
  BarElement,
  LineElement,
  PointElement,
  CategoryScale,
  LinearScale,
  Legend,
  Tooltip,
  Filler,
)

const props = defineProps({
  days: { type: Object, required: true }, // { 'YYYY-MM-DD': day }
})

const range = ref(14)
// One canvas per chart: carbs + saturated fat, water, exercise.
const macroCanvas = ref(null)
const waterCanvas = ref(null)
const exerciseCanvas = ref(null)
// Chart section wrappers (scorecard click scrolls to the related chart).
const macroSection = ref(null)
const waterSection = ref(null)
const exerciseSection = ref(null)
const charts = { macro: null, water: null, exercise: null }

const series = computed(() => {
  const keys = Object.keys(props.days).sort().slice(-range.value)
  return keys.map((k) => dayFlags(props.days[k]))
})

// Per-day logged flags are shared with the clinic report (src/data/report.js).

// ---------- Colors (single source for bars, legend and footnote) ----------
const COLORS = {
  carbsOk: 'rgba(251,146,60,0.85)', // orange: inside carbsMin–carbsMax
  carbsHigh: 'rgba(244,63,94,0.8)', // red: > carbsMax
  carbsLow: 'rgba(234,179,8,0.9)', // yellow: < carbsMin (ketoacidosis risk on [REDACTED])
  exMet: '#0d9488', // dark teal: goal met
  exUnmet: 'rgba(13,148,136,0.4)', // light teal: goal not met
}

// Per-chart "has data" flags for empty-data notes.
const hasMacroData = computed(() => series.value.some((d) => d.meals_analyzed > 0))
const hasWaterData = computed(() => series.value.some((d) => d.has_water))
const hasExerciseData = computed(() => series.value.some((d) => d.has_exercise))

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
function fullDateLabel(date) {
  const d = new Date(`${date}T00:00:00`)
  return Number.isNaN(d.getTime()) ? date : `${date}（週${WEEKDAYS[d.getDay()]}）`
}
const fmtNum = (v) => (Math.round((Number(v) || 0) * 10) / 10).toLocaleString('zh-TW')

function carbStatus(d, t) {
  if (!d.meals_analyzed) return '未記錄'
  if (d.carbs_g > t.carbsMax) return `超標 > ${t.carbsMax} g`
  if (d.carbs_g < t.carbsMin) return `過低 < ${t.carbsMin} g`
  return '範圍內'
}
function satStatus(d, t) {
  if (!d.meals_analyzed) return '未記錄'
  if (d.saturated_fat_g > t.satFatMax) return `超過上限 ${t.satFatMax} g`
  if (d.saturated_fat_g > t.satFatMin) return `超過建議 ${t.satFatMin} g`
  return '建議範圍內'
}
function waterStatus(d, t) {
  if (!d.has_water) return '未記錄'
  if (d.hydration_cc < t.hydrationMin) return `低於下限（差 ${t.hydrationMin - d.hydration_cc} cc）`
  if (d.hydration_cc > t.hydrationMax) return '高於上限'
  return '安全區內'
}
function exStatus(d, t) {
  if (!d.has_exercise) return '未記錄'
  const m = d.exercise_min || 0
  return m >= t.exerciseTarget ? '達標' : `未達標（差 ${t.exerciseTarget - m} 分）`
}

const scorecards = computed(() => {
  const keys = Object.keys(props.days).sort()
  const curr = series.value
  const prev = keys
    .slice(Math.max(0, keys.length - range.value * 2), Math.max(0, keys.length - range.value))
    .map((k) => dayFlags(props.days[k]))
  const t = live.targets
  const defs = [
    {
      id: 'carbs',
      label: '碳水安全',
      hint: `${t.carbsMin}–${t.carbsMax} g`,
      has: (d) => d.meals_analyzed > 0,
      test: (d) => d.carbs_g >= t.carbsMin && d.carbs_g <= t.carbsMax,
    },
    {
      id: 'sat',
      label: '飽和脂肪',
      hint: `≤ ${t.satFatMax} g`,
      has: (d) => d.meals_analyzed > 0,
      test: (d) => d.saturated_fat_g <= t.satFatMax,
    },
    {
      id: 'water',
      label: '飲水',
      hint: `≥ ${t.hydrationMin} cc`,
      has: (d) => d.has_water,
      test: (d) => d.hydration_cc >= t.hydrationMin,
    },
    {
      id: 'ex',
      label: '運動',
      hint: `≥ ${t.exerciseTarget} 分`,
      has: (d) => d.has_exercise,
      test: (d) => d.exercise_min >= t.exerciseTarget,
    },
  ]
  return defs.map((def) => {
    const now = compliance(curr, def.test, def.has)
    const before = compliance(prev, def.test, def.has)
    // Compare whenever the previous period has at least one recorded day (day counts may differ).
    const delta = before.total > 0 && now.pct != null && before.pct != null ? now.pct - before.pct : null
    let badge = '尚無對照'
    let badgeClass = 'bg-slate-100 text-slate-500'
    if (delta != null) {
      if (delta > 0) {
        badge = `▲ +${delta}`
        badgeClass = 'bg-emerald-100 text-emerald-800'
      } else if (delta < 0) {
        badge = `▼ ${delta}`
        badgeClass = 'bg-rose-100 text-rose-800'
      } else {
        badge = '持平'
        badgeClass = 'bg-slate-100 text-slate-600'
      }
    }
    return { id: def.id, label: def.label, hint: def.hint, ...now, badge, badgeClass }
  })
})

// Scorecard id -> chart section to scroll to.
const SECTION_FOR_CARD = { carbs: macroSection, sat: macroSection, water: waterSection, ex: exerciseSection }

function scrollToChart(id) {
  const el = SECTION_FOR_CARD[id]?.value
  if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

const EX_SOURCE = { meal_tag: '（餐點標籤連動）' }
function exerciseExtras(day) {
  const lines = []
  const rawLogs = day.raw?.exercise_logs || day.exercise_logs || []
  const logs = rawLogs.filter((e) => e && (e.type || Number(e.duration_min) || Number(e.reps)))
  if (logs.length) {
    lines.push(
      `🏃 ${logs.map((e) => {
        const reps = Number(e.reps) || 0
        if (e.mode === 'reps' || reps > 0) {
          const sets = Number(e.sets) || 1
          return `${e.type || '運動'} ${reps}下(${sets}組) ${Number(e.duration_min) || 0}m${EX_SOURCE[e.source] || ''}`
        }
        return `${e.type || '運動'} ${Number(e.duration_min) || 0}m${EX_SOURCE[e.source] || ''}${e.time ? ` @${e.time}` : ''}`
      }).join(', ')}`,
    )
  } else if (day.exercise_min > 0) {
    lines.push(`🏃 運動 ${day.exercise_min}m（舊版 exercise_min 欄位，無明細）`)
  }
  return lines
}

function drinkExtras(day) {
  const drinks = (day.drinks || []).filter((d) => d && d.name)
  return drinks.length ? [`🍵 ${drinks.map((d) => `${d.name} ${Number(d.volume_cc) || 0}cc`).join(', ')}`] : []
}

/** Tooltip extra lines. kind: 'exercise' | 'drinks' | undefined (both). */
function tooltipExtras(day, kind) {
  if (!day) return []
  const lines = []
  if (!kind || kind === 'exercise') lines.push(...exerciseExtras(day))
  if (!kind || kind === 'drinks') lines.push(...drinkExtras(day))
  return lines
}

function labels() {
  return series.value.map((d) => d.date.slice(5))
}

function flat(v) {
  return series.value.map(() => v)
}

// ---------- Chart 1: carbs (bars, left) + saturated fat (line, right) ----------
function buildMacroData() {
  const TARGETS = live.targets // user-configurable (Settings), read fresh on every render
  const s = series.value
  return {
    labels: labels(),
    datasets: [
      {
        type: 'bar',
        label: '碳水 (g)',
        tipName: '碳水',
        unit: 'g',
        tipStatus: s.map((d) => carbStatus(d, TARGETS)),
        data: s.map((d) => (d.meals_analyzed ? d.carbs_g : null)), // null = not logged (no bar)
        yAxisID: 'yG',
        backgroundColor: s.map((d) =>
          !d.meals_analyzed ? COLORS.carbsOk : d.carbs_g > TARGETS.carbsMax ? COLORS.carbsHigh : d.carbs_g < TARGETS.carbsMin ? COLORS.carbsLow : COLORS.carbsOk,
        ),
        // One legend entry per conditional color (all toggle this same dataset).
        legendItems: [
          { text: `碳水 (範圍內 ${TARGETS.carbsMin}–${TARGETS.carbsMax} g)`, color: COLORS.carbsOk },
          { text: `碳水超標 (> ${TARGETS.carbsMax} g)`, color: COLORS.carbsHigh },
          { text: `碳水過低 (< ${TARGETS.carbsMin} g)`, color: COLORS.carbsLow },
        ],
        borderRadius: 4,
        order: 5,
      },
      {
        type: 'line',
        label: `碳水上限 ${TARGETS.carbsMax} g`,
        isThreshold: true,
        data: flat(TARGETS.carbsMax),
        yAxisID: 'yG',
        borderColor: 'rgba(234,88,12,0.9)',
        borderDash: [6, 4],
        borderWidth: 1.5,
        pointRadius: 0,
        order: 2,
      },
      {
        type: 'line',
        label: `碳水下限 ${TARGETS.carbsMin} g (防酮酸)`,
        isThreshold: true,
        data: flat(TARGETS.carbsMin),
        yAxisID: 'yG',
        borderColor: 'rgba(161,98,7,0.9)',
        borderDash: [6, 4],
        borderWidth: 1.5,
        pointRadius: 0,
        order: 2,
      },
      {
        type: 'line',
        label: '飽和脂肪 (g)',
        tipName: '飽和脂肪',
        unit: 'g',
        tipStatus: s.map((d) => satStatus(d, TARGETS)),
        data: s.map((d) => (d.meals_analyzed ? d.saturated_fat_g : null)),
        spanGaps: false, // do not draw a line through unlogged days
        yAxisID: 'ySat',
        borderColor: '#7c3aed',
        backgroundColor: '#7c3aed',
        tension: 0.25,
        pointRadius: 4,
        borderWidth: 2.5,
        order: 1,
      },
      {
        type: 'line',
        label: `飽和脂肪上限 ${TARGETS.satFatMax} g`,
        isThreshold: true,
        data: flat(TARGETS.satFatMax),
        yAxisID: 'ySat',
        borderColor: 'rgba(220,38,38,0.9)',
        borderDash: [3, 3],
        borderWidth: 1.5,
        pointRadius: 0,
        order: 1,
      },
      {
        type: 'line',
        label: `飽和脂肪建議 ≤ ${TARGETS.satFatMin} g`,
        isThreshold: true,
        data: flat(TARGETS.satFatMin),
        yAxisID: 'ySat',
        borderColor: 'rgba(124,58,237,0.5)',
        borderDash: [3, 3],
        borderWidth: 1,
        pointRadius: 0,
        order: 1,
      },
    ],
  }
}

// ---------- Chart 2: water area + safe band ----------
function buildWaterData() {
  const TARGETS = live.targets
  const s = series.value
  return {
    labels: labels(),
    datasets: [
      {
        type: 'line',
        label: '飲水 (cc)',
        tipName: '飲水',
        unit: 'cc',
        tipStatus: s.map((d) => waterStatus(d, TARGETS)),
        data: s.map((d) => (d.has_water ? d.hydration_cc : null)),
        spanGaps: false,
        yAxisID: 'yWater',
        borderColor: 'rgba(14,165,233,0.8)',
        backgroundColor: 'rgba(14,165,233,0.15)',
        fill: 'origin',
        tension: 0.3,
        pointRadius: 3,
        pointBackgroundColor: 'rgba(14,165,233,0.9)',
        borderWidth: 2,
        order: 1,
      },
      {
        type: 'line',
        label: `飲水下限 ${TARGETS.hydrationMin} cc`,
        isThreshold: true,
        data: flat(TARGETS.hydrationMin),
        yAxisID: 'yWater',
        borderColor: 'rgba(14,165,233,0.35)',
        borderDash: [2, 4],
        pointRadius: 0,
        borderWidth: 1,
        fill: false,
        order: 2,
      },
      {
        type: 'line',
        label: `飲水上限 ${TARGETS.hydrationMax} cc（淺藍帶＝安全區）`,
        isThreshold: true,
        data: flat(TARGETS.hydrationMax),
        yAxisID: 'yWater',
        borderColor: 'rgba(14,165,233,0.35)',
        backgroundColor: 'rgba(14,165,233,0.08)',
        fill: '-1', // shades the hydrationMin–hydrationMax safe zone
        borderDash: [2, 4],
        pointRadius: 0,
        borderWidth: 1,
        order: 2,
      },
    ],
  }
}

// ---------- Chart 3: exercise minutes + goal line ----------
function buildExerciseData() {
  const TARGETS = live.targets
  const s = series.value
  return {
    labels: labels(),
    datasets: [
      {
        type: 'bar',
        label: '運動 (分)',
        tipName: '運動',
        unit: '分',
        tipStatus: s.map((d) => exStatus(d, TARGETS)),
        data: s.map((d) => (d.has_exercise ? d.exercise_min || 0 : null)),
        yAxisID: 'yEx',
        backgroundColor: s.map((d) => ((d.exercise_min || 0) >= TARGETS.exerciseTarget ? COLORS.exMet : COLORS.exUnmet)),
        legendItems: [
          { text: `運動 (達標 ≥ ${TARGETS.exerciseTarget} 分)`, color: COLORS.exMet },
          { text: `運動 (未達標 < ${TARGETS.exerciseTarget} 分)`, color: COLORS.exUnmet },
        ],
        borderRadius: 4,
        order: 2,
      },
      {
        type: 'line',
        label: `運動目標 ${TARGETS.exerciseTarget} 分`,
        isThreshold: true,
        data: flat(TARGETS.exerciseTarget),
        yAxisID: 'yEx',
        borderColor: 'rgba(15,118,110,0.9)',
        borderDash: [6, 4],
        borderWidth: 1.5,
        pointRadius: 0,
        order: 1,
      },
    ],
  }
}

/** Legend: expand datasets that declare `legendItems` into one entry per conditional color. */
function legendLabels(chart) {
  // Chart.js orders legend entries by draw `order`; list them by dataset instead (main series first, then its limits).
  const base = Chart.defaults.plugins.legend.labels
    .generateLabels(chart)
    .sort((x, y) => x.datasetIndex - y.datasetIndex)
  return base.flatMap((item) => {
    const ds = chart.data.datasets[item.datasetIndex]
    if (!ds || !Array.isArray(ds.legendItems)) return [item]
    return ds.legendItems.map((li) => ({ ...item, text: li.text, fillStyle: li.color, strokeStyle: li.color, lineWidth: 0 }))
  })
}

function baseOptions(extraKind, scales) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        position: 'bottom',
        labels: { boxWidth: 10, padding: 8, font: { size: 11 }, generateLabels: legendLabels },
        // Default onClick toggles legendItem.datasetIndex, so every color entry of a bar dataset toggles that dataset.
      },
      tooltip: {
        // Threshold lines are constant and already named in the legend; keep the tooltip to real values.
        filter: (item) => !item.dataset.isThreshold,
        itemSort: (a, b) => a.datasetIndex - b.datasetIndex, // carbs first, then sat fat
        callbacks: {
          title(items) {
            const d = items && items[0] ? series.value[items[0].dataIndex] : null
            return d ? fullDateLabel(d.date) : ''
          },
          label(ctx) {
            const ds = ctx.dataset
            const status = Array.isArray(ds.tipStatus) ? ds.tipStatus[ctx.dataIndex] : ''
            if (status === '未記錄' || ctx.raw == null) return `${ds.tipName || ds.label}：未記錄`
            return `${ds.tipName || ds.label}：${fmtNum(ctx.raw)} ${ds.unit || ''}${status ? `（${status}）` : ''}`
          },
          afterBody(items) {
            if (!extraKind) return []
            const index = items && items[0] ? items[0].dataIndex : -1
            return tooltipExtras(series.value[index], extraKind)
          },
        },
      },
    },
    scales: { x: { grid: { display: false }, title: { display: true, text: '日期 (月-日)', font: { size: 10 } } }, ...scales },
  }
}

function buildMacroOptions() {
  return baseOptions(null, {
    yG: {
      type: 'linear',
      position: 'left',
      beginAtZero: true,
      suggestedMax: 220,
      title: { display: true, text: '碳水 (g)' },
    },
    ySat: {
      type: 'linear',
      position: 'right',
      beginAtZero: true,
      suggestedMax: 30,
      grid: { drawOnChartArea: false },
      title: { display: true, text: '飽和脂肪 (g)' },
    },
  })
}

function buildWaterOptions() {
  return baseOptions('drinks', {
    yWater: {
      type: 'linear',
      position: 'left',
      beginAtZero: true,
      suggestedMax: 3000,
      title: { display: true, text: '飲水 (cc)' },
    },
  })
}

function buildExerciseOptions() {
  return baseOptions('exercise', {
    yEx: {
      type: 'linear',
      position: 'left',
      beginAtZero: true,
      suggestedMax: 60,
      title: { display: true, text: '運動 (分鐘)' },
    },
  })
}

function destroyCharts() {
  for (const key of Object.keys(charts)) {
    if (charts[key]) charts[key].destroy()
    charts[key] = null
  }
}

function render() {
  destroyCharts()
  if (macroCanvas.value) {
    charts.macro = new Chart(macroCanvas.value, { type: 'bar', data: buildMacroData(), options: buildMacroOptions() })
  }
  if (waterCanvas.value) {
    charts.water = new Chart(waterCanvas.value, { type: 'line', data: buildWaterData(), options: buildWaterOptions() })
  }
  if (exerciseCanvas.value) {
    charts.exercise = new Chart(exerciseCanvas.value, {
      type: 'bar',
      data: buildExerciseData(),
      options: buildExerciseOptions(),
    })
  }
}

// Mobile: Chart.js keeps the tooltip open after a tap; hide it when tapping anywhere outside that chart.
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
// Re-render when data or the user-configured targets change.
watch([series, () => ({ ...live.targets })], render)
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', hideTooltipOnOutsideTap)
  document.removeEventListener('touchstart', hideTooltipOnOutsideTap, { passive: true })
  destroyCharts()
})
</script>

<template>
  <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
    <div class="flex items-center justify-between">
      <h2 class="font-semibold text-slate-800">📈 趨勢總覽</h2>
      <div class="flex gap-1">
        <button
          v-for="r in [7, 14, 30]"
          :key="r"
          class="rounded-md px-3 py-1.5 text-sm"
          :class="range === r ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-600'"
          @click="range = r"
        >
          {{ r }}天
        </button>
      </div>
    </div>
    <div v-if="series.length" class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <article
        v-for="card in scorecards"
        :key="card.id"
        class="cursor-pointer rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200 active:bg-slate-100"
        role="button"
        tabindex="0"
        :aria-label="card.label + ' 圖表'"
        @click="scrollToChart(card.id)"
        @keydown.enter.prevent="scrollToChart(card.id)"
        @keydown.space.prevent="scrollToChart(card.id)"
      >
        <p class="text-xs text-slate-500">{{ card.label }}</p>
        <div class="mt-1 flex items-end justify-between gap-1">
          <p class="text-2xl font-semibold tabular-nums text-slate-800">{{ card.pct == null ? '—' : card.pct + '%' }}</p>
          <span class="rounded-full px-2 py-0.5 text-[11px] font-medium" :class="card.badgeClass" :title="'較前一段 ' + range + ' 天（百分點）'">
            {{ card.badge }}
          </span>
        </div>
        <p class="mt-1 text-[11px] text-slate-400">{{ card.hint }} · {{ card.hit }}/{{ card.total }} 天</p>
      </article>
    </div>
    <p v-if="!series.length" class="mt-6 text-center text-sm text-slate-400">
      尚無資料。請先在「今日記錄」分頁記錄飲食、飲水與運動。
    </p>
    <div :class="{ hidden: !series.length }">
      <div ref="macroSection" class="mt-4 scroll-mt-24 sm:scroll-mt-32" data-chart="macro">
        <h3 class="text-sm font-medium text-slate-700">🍚 碳水與飽和脂肪 <span class="text-xs font-normal text-slate-400">(g/日)</span></h3>
        <p v-if="!hasMacroData" class="mt-1 text-xs text-slate-400">此期間尚無已分析的餐點，碳水與飽和脂肪無資料。</p>
        <div class="mt-2 h-[26rem] sm:h-96"><canvas ref="macroCanvas" role="img" aria-label="碳水與飽和脂肪趨勢圖" /></div>
      </div>
      <div ref="waterSection" class="mt-5 scroll-mt-24 sm:scroll-mt-32" data-chart="water">
        <h3 class="text-sm font-medium text-slate-700">💧 飲水 <span class="text-xs font-normal text-slate-400">(cc/日)</span></h3>
        <p v-if="!hasWaterData" class="mt-1 text-xs text-slate-400">此期間尚無飲水紀錄。</p>
        <div class="mt-2 h-72 sm:h-72"><canvas ref="waterCanvas" role="img" aria-label="飲水趨勢圖" /></div>
      </div>
      <div ref="exerciseSection" class="mt-5 scroll-mt-24 sm:scroll-mt-32" data-chart="exercise">
        <h3 class="text-sm font-medium text-slate-700">🏃 運動 <span class="text-xs font-normal text-slate-400">(分鐘/日)</span></h3>
        <p v-if="!hasExerciseData" class="mt-1 text-xs text-slate-400">此期間尚無運動紀錄。</p>
        <div class="mt-2 h-72 sm:h-72"><canvas ref="exerciseCanvas" role="img" aria-label="運動趨勢圖" /></div>
      </div>
    </div>
    <div v-if="series.length" class="mt-3 space-y-1 text-xs text-slate-500" data-legend-notes>
      <p class="font-medium text-slate-600">圖例說明</p>
      <p>
        🍚 碳水長條：<span class="legend-dot" :style="{ background: COLORS.carbsOk }"></span>橘＝範圍內 {{ live.targets.carbsMin }}–{{ live.targets.carbsMax }} g、
        <span class="legend-dot" :style="{ background: COLORS.carbsHigh }"></span>紅＝超標（&gt; {{ live.targets.carbsMax }} g）、
        <span class="legend-dot" :style="{ background: COLORS.carbsLow }"></span>黃＝過低（&lt; {{ live.targets.carbsMin }} g，[REDACTED] 酮酸風險）；無長條／斷線＝當天未記錄（不算 0，也不計入達成率）。
      </p>
      <p>🟣 飽和脂肪紫線（右軸）：淡紫虛線＝建議 ≤ {{ live.targets.satFatMin }} g、紅虛線＝上限 {{ live.targets.satFatMax }} g。</p>
      <p>💧 飲水：藍色面積＝當日飲水量；淺藍帶＝安全區 {{ live.targets.hydrationMin }}–{{ live.targets.hydrationMax }} cc（依體重 {{ live.targets.userWeight }} kg，下限不低於 2000 cc）。</p>
      <p>
        🏃 運動長條（當日累計分鐘）：<span class="legend-dot" :style="{ background: COLORS.exMet }"></span>深綠＝達標 ≥ {{ live.targets.exerciseTarget }} 分、
        <span class="legend-dot" :style="{ background: COLORS.exUnmet }"></span>淺綠＝未達標。
      </p>
      <p>達成率只計算「有記錄該項目」的天數；徽章 ▲/▼＝與前一段 {{ range }} 天相比的變化（百分點）。點圖例可隱藏/顯示該資料。</p>
    </div>
  </section>
</template>

<style scoped>
.legend-dot {
  display: inline-block;
  width: 0.6rem;
  height: 0.6rem;
  margin: 0 0.2rem 0 0.1rem;
  border-radius: 2px;
  vertical-align: -0.05rem;
}
</style>
