<script setup>
// 檢驗趨勢圖: one small line chart per key lab (baseline + every follow-up value) with its target line.
// Values go through sanitizeLabNumber (same plausibility limits as the AI prompts), so typos or
// imported junk never reach a chart. Charts are destroyed before every re-render and on unmount.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Chart, LineController, LineElement, PointElement, CategoryScale, LinearScale, Legend, Tooltip, Filler } from 'chart.js'
import { getBaselineDate, LAB_FIELDS } from '../data/presets.js'
import { sanitizeLabDate, sanitizeLabNumber } from '../data/labContext.js'

Chart.register(LineController, LineElement, PointElement, CategoryScale, LinearScale, Legend, Tooltip, Filler)

const props = defineProps({
  labs: { type: Array, default: () => [] },
})

const CHART_KEYS = ['hba1c', 'ldl', 'tg', 'uacr', 'ac_sugar', 'egfr']
/** Reference lines for fields without a numeric target in LAB_FIELDS (shown as "參考", not a goal). */
const REFERENCE = { egfr: { value: 90, label: '參考 ≥ 90（正常腎功能）', higherIsBetter: true } }
const COLORS = { line: '#0f766e', met: '#059669', unmet: '#e11d48', neutral: '#0f766e', target: 'rgba(5,150,105,0.9)', band: 'rgba(16,185,129,0.10)' }

const fields = CHART_KEYS.map((k) => LAB_FIELDS.find((f) => f.key === k)).filter(Boolean)

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

function pointColor(f, v) {
  if (f.dir === 'lt' && f.target != null) return v < f.target ? COLORS.met : COLORS.unmet
  const ref = REFERENCE[f.key]
  if (ref) return v >= ref.value ? COLORS.met : COLORS.unmet
  return COLORS.neutral
}

function buildConfig(f) {
  const pts = seriesByField.value[f.key] || []
  const labels = pts.map((p) => p.date)
  const values = pts.map((p) => p.value)
  const unit = f.unit || ''
  const datasets = [
    {
      label: `${f.label}${unit ? ` (${unit})` : ''}`,
      data: values,
      borderColor: COLORS.line,
      backgroundColor: COLORS.line,
      pointBackgroundColor: values.map((v) => pointColor(f, v)),
      pointBorderColor: values.map((v) => pointColor(f, v)),
      pointRadius: 5,
      pointHoverRadius: 7,
      borderWidth: 2.5,
      tension: 0.2,
      order: 1,
    },
  ]
  const line = f.dir === 'lt' && f.target != null ? { value: f.target, label: `目標 ${f.targetLabel}${unit ? ` ${unit}` : ''}`, band: true } : REFERENCE[f.key] ? { value: REFERENCE[f.key].value, label: REFERENCE[f.key].label, band: false } : null
  if (line) {
    datasets.push({
      label: line.label,
      isThreshold: true,
      data: labels.map(() => line.value),
      borderColor: COLORS.target,
      backgroundColor: COLORS.band,
      borderDash: [6, 4],
      borderWidth: 1.5,
      pointRadius: 0,
      pointHoverRadius: 0,
      fill: line.band ? 'origin' : false, // shaded band = target zone (below target)
      order: 2,
    })
  }
  const all = [...values, ...(line ? [line.value] : [])]
  const min = Math.min(...all)
  const max = Math.max(...all)
  const pad = (max - min || Math.abs(max) || 1) * 0.15
  return {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, padding: 8, font: { size: 11 } } },
        tooltip: {
          filter: (item) => !item.dataset.isThreshold,
          callbacks: {
            title: (items) => {
              const p = items && items[0] ? pts[items[0].dataIndex] : null
              return p ? `${p.date}${p.baseline ? '（基準）' : ''}` : ''
            },
            label: (ctx) => {
              const v = ctx.raw
              let status = ''
              if (f.dir === 'lt' && f.target != null) status = v < f.target ? '已達標' : '未達標'
              else if (REFERENCE[f.key]) status = v >= REFERENCE[f.key].value ? '參考範圍內' : '低於參考'
              return `${f.label}：${v}${unit ? ` ${unit}` : ''}${status ? `（${status}）` : ''}`
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: { suggestedMin: Math.max(0, min - pad), suggestedMax: max + pad, title: { display: Boolean(unit), text: unit } },
      },
    },
  }
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
    if (el) charts[f.key] = new Chart(el, buildConfig(f))
  }
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
watch(seriesByField, render)
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', hideTooltipOnOutsideTap)
  document.removeEventListener('touchstart', hideTooltipOnOutsideTap, { passive: true })
  destroyCharts()
})
</script>

<template>
  <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200" data-testid="lab-trends">
    <h2 class="font-semibold text-slate-800">📉 檢驗趨勢圖</h2>
    <p class="mt-1 text-xs text-slate-500">基準值（{{ getBaselineDate() || '未設定' }}）＋每次追蹤結果；虛線＝目標值，淺綠帶＝目標範圍。綠點＝已達標、紅點＝未達標。</p>
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
  </section>
</template>
