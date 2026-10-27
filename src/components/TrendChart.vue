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
import { summarizeDay } from '../services/gemini.js'

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
const canvas = ref(null)
let chart = null

const series = computed(() => {
  const keys = Object.keys(props.days).sort().slice(-range.value)
  return keys.map((k) => summarizeDay(props.days[k]))
})

function compliance(rows, test) {
  const total = rows.length
  if (!total) return { pct: null, hit: 0, total: 0 }
  const hit = rows.filter(test).length
  return { pct: Math.round((hit / total) * 100), hit, total }
}

const scorecards = computed(() => {
  const keys = Object.keys(props.days).sort()
  const curr = series.value
  const prev = keys
    .slice(Math.max(0, keys.length - range.value * 2), Math.max(0, keys.length - range.value))
    .map((k) => summarizeDay(props.days[k]))
  const t = live.targets
  const defs = [
    {
      id: 'carbs',
      label: '碳水安全',
      hint: `${t.carbsMin}–${t.carbsMax} g`,
      test: (d) => d.carbs_g >= t.carbsMin && d.carbs_g <= t.carbsMax,
    },
    {
      id: 'sat',
      label: '飽和脂肪',
      hint: `≤ ${t.satFatMax} g`,
      test: (d) => d.saturated_fat_g <= t.satFatMax,
    },
    {
      id: 'water',
      label: '飲水',
      hint: `≥ ${t.hydrationMin} cc`,
      test: (d) => d.hydration_cc >= t.hydrationMin,
    },
    {
      id: 'ex',
      label: '運動',
      hint: `≥ ${t.exerciseTarget} 分`,
      test: (d) => d.exercise_min >= t.exerciseTarget,
    },
  ]
  return defs.map((def) => {
    const now = compliance(curr, def.test)
    const before = compliance(prev, def.test)
    const delta = before.total === now.total && now.pct != null && before.pct != null ? now.pct - before.pct : null
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

function tooltipExtras(day) {
  if (!day) return []
  const lines = []
  const logs = (day.exercise_logs || []).filter((e) => e && (e.type || Number(e.duration_min) || Number(e.reps)))
  if (logs.length) {
    lines.push(
      `🏃 ${logs.map((e) => {
        const reps = Number(e.reps) || 0
        if (e.mode === 'reps' || reps > 0) {
          const sets = Number(e.sets) || 1
          return `${e.type || '運動'} ${reps}下(${sets}組) ${Number(e.duration_min) || 0}m`
        }
        return `${e.type || '運動'} ${Number(e.duration_min) || 0}m`
      }).join(', ')}`,
    )
  } else if (day.exercise_min > 0) {
    lines.push(`🏃 運動 ${day.exercise_min}m`)
  }
  const drinks = (day.drinks || []).filter((d) => d && d.name)
  if (drinks.length) {
    lines.push(`🍵 ${drinks.map((d) => `${d.name} ${Number(d.volume_cc) || 0}cc`).join(', ')}`)
  }
  return lines
}

function buildData() {
  const TARGETS = live.targets // user-configurable (Settings), read fresh on every render
  const s = series.value
  const labels = s.map((d) => d.date.slice(5))
  const flat = (v) => s.map(() => v)
  return {
    labels,
    datasets: [
      // Hydration: background area (2000-2500cc safe zone shown as band)
      {
        type: 'line',
        label: '飲水 (cc)',
        data: s.map((d) => d.hydration_cc),
        yAxisID: 'yWater',
        borderColor: 'rgba(14,165,233,0.5)',
        backgroundColor: 'rgba(14,165,233,0.15)',
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        order: 10,
      },
      {
        type: 'line',
        label: `飲水下限 ${TARGETS.hydrationMin}`,
        data: flat(TARGETS.hydrationMin),
        yAxisID: 'yWater',
        borderColor: 'rgba(14,165,233,0.35)',
        borderDash: [2, 4],
        pointRadius: 0,
        borderWidth: 1,
        order: 10,
      },
      {
        type: 'line',
        label: `飲水上限 ${TARGETS.hydrationMax}`,
        data: flat(TARGETS.hydrationMax),
        yAxisID: 'yWater',
        borderColor: 'rgba(14,165,233,0.35)',
        backgroundColor: 'rgba(14,165,233,0.08)',
        fill: '-1', // shades the 2000-2500 safe zone
        borderDash: [2, 4],
        pointRadius: 0,
        borderWidth: 1,
        order: 10,
      },
      // Carbs bars
      {
        type: 'bar',
        label: '碳水 (g)',
        data: s.map((d) => d.carbs_g),
        yAxisID: 'yG',
        backgroundColor: s.map((d) =>
          d.carbs_g && (d.carbs_g < TARGETS.carbsMin || d.carbs_g > TARGETS.carbsMax)
            ? 'rgba(244,63,94,0.75)'
            : 'rgba(251,146,60,0.8)',
        ),
        borderRadius: 4,
        order: 5,
      },
      {
        type: 'line',
        label: `碳水上限 ${TARGETS.carbsMax}g`,
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
        label: `碳水下限 ${TARGETS.carbsMin}g (防酮酸)`,
        data: flat(TARGETS.carbsMin),
        yAxisID: 'yG',
        borderColor: 'rgba(161,98,7,0.9)',
        borderDash: [6, 4],
        borderWidth: 1.5,
        pointRadius: 0,
        order: 2,
      },
      // Saturated fat line + strict threshold
      {
        type: 'line',
        label: '飽和脂肪 (g)',
        data: s.map((d) => d.saturated_fat_g),
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
        label: `飽和脂肪上限 ${TARGETS.satFatMax}g`,
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
        label: `飽和脂肪建議 ${TARGETS.satFatMin}g`,
        data: flat(TARGETS.satFatMin),
        yAxisID: 'ySat',
        borderColor: 'rgba(124,58,237,0.5)',
        borderDash: [3, 3],
        borderWidth: 1,
        pointRadius: 0,
        order: 1,
      },
      // Exercise markers
      {
        type: 'line',
        label: '運動 (分)',
        data: s.map((d) => (d.exercise_min > 0 ? d.exercise_min : null)),
        yAxisID: 'yEx',
        showLine: false,
        pointStyle: 'triangle',
        pointRadius: 8,
        pointBackgroundColor: '#0d9488',
        pointBorderColor: '#fff',
        order: 0,
      },
    ],
  }
}

function buildOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        position: 'bottom',
        labels: { boxWidth: 12, font: { size: 11 } },
      },
      tooltip: {
        callbacks: {
          afterBody(items) {
            const index = items && items[0] ? items[0].dataIndex : -1
            return tooltipExtras(series.value[index])
          },
        },
      },
    },
    scales: {
      x: { grid: { display: false } },
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
      yWater: {
        type: 'linear',
        display: false,
        beginAtZero: true,
        suggestedMax: 3000,
      },
      yEx: {
        type: 'linear',
        display: false,
        beginAtZero: true,
        suggestedMax: 60,
      },
    },
  }
}

function render() {
  if (!canvas.value) return
  if (chart) chart.destroy()
  chart = new Chart(canvas.value, {
    type: 'bar',
    data: buildData(),
    options: buildOptions(),
  })
}

function hideTooltipOnOutsideTap(e) {
  if (!chart || !canvas.value || canvas.value.contains(e.target)) return
  chart.setActiveElements([])
  chart.tooltip.setActiveElements([], { x: 0, y: 0 })
  chart.update('none')
}

onMounted(() => {
  render()
  document.addEventListener('pointerdown', hideTooltipOnOutsideTap)
})
// Re-render when data or the user-configured targets change.
watch([series, () => ({ ...live.targets })], render)
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', hideTooltipOnOutsideTap)
  chart?.destroy()
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
      <article v-for="card in scorecards" :key="card.id" class="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
        <p class="text-xs text-slate-500">{{ card.label }}</p>
        <div class="mt-1 flex items-end justify-between gap-1">
          <p class="text-2xl font-semibold tabular-nums text-slate-800">{{ card.pct == null ? '—' : card.pct + '%' }}</p>
          <span class="rounded-full px-2 py-0.5 text-[11px] font-medium" :class="card.badgeClass" :title="'較前一段 ' + range + ' 天'">
            {{ card.badge }}
          </span>
        </div>
        <p class="mt-1 text-[11px] text-slate-400">{{ card.hint }} · {{ card.hit }}/{{ card.total }} 天</p>
      </article>
    </div>
    <p v-if="!series.length" class="mt-6 text-center text-sm text-slate-400">
      尚無資料。請先在「今日記錄」分頁記錄飲食、飲水與運動。
    </p>
    <div class="mt-3 h-80 sm:h-96" :class="{ hidden: !series.length }">
      <canvas ref="canvas" />
    </div>
    <p class="mt-2 text-xs text-slate-400">
      碳水下限用於避免過低碳水 ([REDACTED] + 酮體風險)；飽和脂肪嚴格上限 {{ live.targets.satFatMin }}-{{ live.targets.satFatMax }}g；飲水安全區
      {{ live.targets.hydrationMin }}-{{ live.targets.hydrationMax }}cc；▲ 為餐後踏步分鐘數。
    </p>
  </section>
</template>
