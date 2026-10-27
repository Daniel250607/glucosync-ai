<script setup>
// 回診報告: print-friendly report over the last 14/30/90 days.
// - Rendered with Vue text interpolation only (no v-html), so every user-entered string is escaped.
// - "列印 / 存成 PDF" uses window.print(); print CSS (style.css) hides the app and prints only this view.
// - "下載 PNG" draws the same report model onto a <canvas> with fillText (no external services / libraries).
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { BASELINE_DATE } from '../data/presets.js'
import { REPORT_RANGES, buildReport } from '../data/report.js'

const props = defineProps({
  days: { type: Object, required: true },
  labs: { type: Array, default: () => [] },
  patientName: { type: String, default: '' },
})
const emit = defineEmits(['close'])

const range = ref(30)
const report = computed(() => buildReport({ days: props.days, labs: props.labs, rangeDays: range.value }))
const pngError = ref('')
const safeName = computed(() => String(props.patientName || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60))

function fmt(v, unit = '') {
  if (v == null || v === '' || !Number.isFinite(Number(v))) return '—'
  return `${Number(v).toLocaleString('zh-TW', { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ''}`
}
function pctText(c) {
  return c.pct == null ? '—（無紀錄）' : `${c.pct}%（${c.hit}/${c.total} 天）`
}
function deltaText(d) {
  if (d == null) return ''
  return `${d > 0 ? '+' : ''}${Number(d).toLocaleString('zh-TW', { maximumFractionDigits: 2 })}`
}
const generatedText = computed(() => {
  const d = report.value.generatedAt
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
})

function printReport() {
  window.print()
}

function onKey(e) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => {
  document.body.classList.add('gs-report-open')
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.body.classList.remove('gs-report-open')
  document.removeEventListener('keydown', onKey)
})

// ---------- PNG export (canvas, text only) ----------
/** Flatten the report into simple drawing rows (shared layout for measuring and painting). */
function pngRows(r) {
  const rows = []
  rows.push({ kind: 'title', text: 'GlucoSync 回診報告' })
  rows.push({ kind: 'sub', text: `${safeName.value ? `${safeName.value} · ` : ''}期間 ${r.start} ～ ${r.end}（${r.rangeDays} 天，有紀錄 ${r.recordDays} 天）· 產生 ${generatedText.value}` })
  rows.push({ kind: 'h', text: '目標達成率（只計有紀錄的天數）' })
  for (const c of r.compliance) rows.push({ kind: 'cols', cells: [c.label, c.hint, pctText(c)] })
  rows.push({ kind: 'h', text: '每日平均（只計有紀錄的天數）' })
  for (const a of r.averages) rows.push({ kind: 'cols', cells: [a.label, a.value == null ? '—' : fmt(a.value, a.unit), `${a.days} 天`] })
  rows.push({ kind: 'h', text: `檢驗：基準（${BASELINE_DATE}）vs 最新` })
  rows.push({ kind: 'cols', head: true, cells: ['項目', '基準', '最新（日期）', '目標 / 狀態'] })
  for (const l of r.labRows) {
    rows.push({
      kind: 'cols',
      cells: [l.label + (l.unit ? ` (${l.unit})` : ''), String(l.baseline), l.latest == null ? '尚無追蹤' : `${l.latest}（${l.latestDate}）${l.delta != null ? ` ${deltaText(l.delta)}` : ''}`, l.target === '—' && l.status === '—' ? '—' : `${l.target} · ${l.status}`],
    })
  }
  rows.push({ kind: 'h', text: '身體不適紀錄' })
  if (!r.sickEntries.length) rows.push({ kind: 'text', text: '此期間無身體不適紀錄。' })
  for (const s of r.sickEntries) rows.push({ kind: 'text', text: `${s.date}${s.time ? ` ${s.time}` : ''}：${s.symptoms}${s.note ? `（${s.note}）` : ''}` })
  rows.push({ kind: 'h', text: '用藥紀錄（有勾選用藥的天數）' })
  if (!r.meds.trackedDays) rows.push({ kind: 'text', text: '此期間沒有用藥勾選紀錄。' })
  else {
    rows.push({ kind: 'text', text: `整體 ${r.meds.pct}%（${r.meds.taken}/${r.meds.expected} 劑次，${r.meds.trackedDays} 天）` })
    for (const m of r.meds.rows) rows.push({ kind: 'cols', cells: [m.label, m.slots, m.pct == null ? '—' : `${m.pct}%（${m.taken}/${m.expected}）`] })
  }
  rows.push({ kind: 'note', text: '本報告由使用者自行記錄資料彙整，營養數值為 AI 估算，僅供回診討論參考，不能取代醫師診斷。' })
  return rows
}

const PNG = { width: 1080, pad: 48, font: '"Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif' }
const ROW_H = { title: 64, sub: 40, h: 58, cols: 38, text: 38, note: 56 }

function clip(ctx, text, maxW) {
  let t = String(text)
  if (ctx.measureText(t).width <= maxW) return t
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1)
  return `${t}…`
}

function drawPng() {
  const rows = pngRows(report.value)
  const height = PNG.pad * 2 + rows.reduce((h, r) => h + ROW_H[r.kind], 0)
  const scale = 1
  const canvas = document.createElement('canvas')
  canvas.width = PNG.width * scale
  canvas.height = height * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('此瀏覽器不支援 canvas。')
  ctx.scale(scale, scale)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, PNG.width, height)
  ctx.textBaseline = 'middle'
  const inner = PNG.width - PNG.pad * 2
  let y = PNG.pad
  for (const r of rows) {
    const h = ROW_H[r.kind]
    const mid = y + h / 2
    if (r.kind === 'title') {
      ctx.fillStyle = '#0f766e'
      ctx.font = `700 40px ${PNG.font}`
      ctx.fillText(clip(ctx, r.text, inner), PNG.pad, mid)
    } else if (r.kind === 'sub') {
      ctx.fillStyle = '#475569'
      ctx.font = `400 22px ${PNG.font}`
      ctx.fillText(clip(ctx, r.text, inner), PNG.pad, mid)
    } else if (r.kind === 'h') {
      ctx.fillStyle = '#0f172a'
      ctx.font = `700 28px ${PNG.font}`
      ctx.fillText(clip(ctx, r.text, inner), PNG.pad, mid + 6)
      ctx.fillStyle = '#cbd5e1'
      ctx.fillRect(PNG.pad, y + h - 4, inner, 2)
    } else if (r.kind === 'cols') {
      const n = r.cells.length
      const widths = n === 4 ? [0.27, 0.16, 0.32, 0.25] : [0.34, 0.26, 0.4]
      let x = PNG.pad
      ctx.fillStyle = r.head ? '#64748b' : '#1e293b'
      ctx.font = `${r.head ? 600 : 400} 22px ${PNG.font}`
      r.cells.forEach((c, i) => {
        const w = inner * widths[i]
        ctx.fillText(clip(ctx, c, w - 12), x, mid)
        x += w
      })
    } else if (r.kind === 'text') {
      ctx.fillStyle = '#1e293b'
      ctx.font = `400 22px ${PNG.font}`
      ctx.fillText(clip(ctx, r.text, inner), PNG.pad, mid)
    } else if (r.kind === 'note') {
      ctx.fillStyle = '#64748b'
      ctx.font = `400 18px ${PNG.font}`
      ctx.fillText(clip(ctx, r.text, inner), PNG.pad, mid)
    }
    y += h
  }
  return canvas
}

function downloadPng() {
  pngError.value = ''
  try {
    const canvas = drawPng()
    canvas.toBlob((blob) => {
      if (!blob) {
        pngError.value = '無法產生 PNG，請改用「列印 / 存成 PDF」。'
        return
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `glucosync-report-${report.value.end}-${report.value.rangeDays}d.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }, 'image/png')
  } catch (err) {
    pngError.value = err.message || String(err)
  }
}

defineExpose({ pngRows: () => pngRows(report.value) })
</script>

<template>
  <Teleport to="body">
    <div class="gs-report-print fixed inset-0 z-[60] overflow-y-auto bg-slate-100" role="dialog" aria-modal="true" aria-label="回診報告" data-testid="clinic-report">
      <div class="no-print sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white/95 px-3 py-2 backdrop-blur">
        <div class="flex gap-1" role="group" aria-label="報告期間">
          <button
            v-for="r in REPORT_RANGES"
            :key="r"
            type="button"
            class="min-h-10 rounded-md px-3 text-sm"
            :class="range === r ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-600'"
            :aria-pressed="range === r"
            @click="range = r"
          >
            {{ r }}天
          </button>
        </div>
        <div class="ml-auto flex flex-wrap gap-2">
          <button type="button" class="min-h-10 rounded-lg bg-teal-600 px-3 text-sm font-semibold text-white active:bg-teal-700" data-testid="report-print" @click="printReport">🖨️ 列印 / 存成 PDF</button>
          <button type="button" class="min-h-10 rounded-lg bg-white px-3 text-sm text-teal-800 ring-1 ring-teal-200" data-testid="report-png" @click="downloadPng">🖼️ 下載 PNG</button>
          <button type="button" class="min-h-10 rounded-lg bg-slate-100 px-3 text-sm text-slate-700" data-testid="report-close" @click="emit('close')">✕ 關閉</button>
        </div>
        <p v-if="pngError" class="w-full text-xs text-rose-600" role="alert">{{ pngError }}</p>
      </div>

      <article class="report-sheet mx-auto my-4 max-w-3xl bg-white p-5 text-slate-800 shadow-sm sm:p-8" data-testid="report-sheet">
        <header class="border-b border-slate-300 pb-3">
          <h1 class="text-xl font-bold text-teal-800">GlucoSync 回診報告</h1>
          <p class="mt-1 text-sm text-slate-600">
            <span v-if="safeName">{{ safeName }} · </span>期間 <b data-testid="report-period">{{ report.start }} ～ {{ report.end }}</b>（{{ report.rangeDays }} 天，有紀錄
            <b data-testid="report-record-days">{{ report.recordDays }}</b> 天）
          </p>
          <p class="text-xs text-slate-400">產生時間 {{ generatedText }}（裝置時區）</p>
        </header>

        <section class="report-block mt-4">
          <h2 class="report-h">🎯 目標達成率 <span class="text-xs font-normal text-slate-500">（只計有記錄該項目的天數）</span></h2>
          <table class="report-table" data-testid="report-compliance">
            <thead><tr><th>項目</th><th>目標</th><th>達成率</th></tr></thead>
            <tbody>
              <tr v-for="c in report.compliance" :key="c.id" :data-id="c.id">
                <td>{{ c.label }}</td>
                <td>{{ c.hint }}</td>
                <td class="tabular-nums">{{ pctText(c) }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="report-block mt-4">
          <h2 class="report-h">📊 每日平均 <span class="text-xs font-normal text-slate-500">（未記錄的天數不算 0）</span></h2>
          <table class="report-table" data-testid="report-averages">
            <thead><tr><th>項目</th><th>平均</th><th>計算天數</th></tr></thead>
            <tbody>
              <tr v-for="a in report.averages" :key="a.id" :data-id="a.id">
                <td>{{ a.label }}</td>
                <td class="tabular-nums">{{ a.value == null ? '—' : fmt(a.value, a.unit) }}</td>
                <td class="tabular-nums">{{ a.days }} 天 <span class="text-xs text-slate-400">（{{ a.basis }}）</span></td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="report-block mt-4">
          <h2 class="report-h">🧪 檢驗：基準 vs 最新</h2>
          <table class="report-table" data-testid="report-labs">
            <thead><tr><th>項目</th><th>基準（{{ BASELINE_DATE }}）</th><th>最新（日期）</th><th>變化</th><th>目標</th><th>狀態</th></tr></thead>
            <tbody>
              <tr v-for="l in report.labRows" :key="l.key" :data-key="l.key">
                <td>{{ l.label }}<span v-if="l.unit" class="text-xs text-slate-400">{{ ' ' + l.unit }}</span></td>
                <td class="tabular-nums">{{ l.baseline }}</td>
                <td class="tabular-nums">
                  <template v-if="l.latest != null">{{ l.latest }} <span class="text-xs text-slate-500">（{{ l.latestDate }}）</span></template>
                  <span v-else class="text-slate-400">尚無追蹤</span>
                </td>
                <td class="tabular-nums">{{ deltaText(l.delta) || '—' }}<span v-if="l.latest != null" class="text-xs text-slate-500">{{ ' ' + l.trend }}</span></td>
                <td>{{ l.target }}</td>
                <td>{{ l.status }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="report-block mt-4" data-testid="report-sick">
          <h2 class="report-h">🤒 身體不適紀錄</h2>
          <p v-if="!report.sickEntries.length" class="text-sm text-slate-500">此期間無身體不適紀錄。</p>
          <ul v-else class="ml-5 list-disc text-sm">
            <li v-for="s in report.sickEntries" :key="s.date" class="break-words">
              <b>{{ s.date }}</b><span v-if="s.time">{{ ' ' + s.time }}</span>：{{ s.symptoms }}<span v-if="s.note">（{{ s.note }}）</span>
            </li>
          </ul>
        </section>

        <section class="report-block mt-4" data-testid="report-meds">
          <h2 class="report-h">💊 用藥紀錄</h2>
          <p v-if="!report.meds.trackedDays" class="text-sm text-slate-500">此期間沒有用藥勾選紀錄。</p>
          <template v-else>
            <p class="text-sm">
              整體服藥勾選率 <b>{{ report.meds.pct }}%</b>（{{ report.meds.taken }}/{{ report.meds.expected }} 劑次，共 {{ report.meds.trackedDays }} 天有勾選）
            </p>
            <table class="report-table mt-1">
              <thead><tr><th>藥物</th><th>時段</th><th>勾選率</th></tr></thead>
              <tbody>
                <tr v-for="m in report.meds.rows" :key="m.id">
                  <td>{{ m.label }}</td>
                  <td>{{ m.slots }}</td>
                  <td class="tabular-nums">{{ m.pct == null ? '—' : `${m.pct}%（${m.taken}/${m.expected}）` }}</td>
                </tr>
              </tbody>
            </table>
            <p class="mt-1 text-xs text-slate-400">沒有任何用藥勾選的天數視為「未記錄」，不計入。</p>
          </template>
        </section>

        <footer class="mt-6 border-t border-slate-200 pt-2 text-xs text-slate-500">
          本報告由使用者自行記錄的資料彙整；營養數值為 AI 估算，僅供回診討論參考，不能取代醫師診斷。目標值為 App 目前設定：碳水 {{ report.targets.carbsMin }}–{{ report.targets.carbsMax }} g、飽和脂肪 ≤ {{ report.targets.satFatMax }} g、飲水 ≥ {{ report.targets.hydrationMin }} cc、運動 ≥ {{ report.targets.exerciseTarget }} 分。
        </footer>
      </article>
    </div>
  </Teleport>
</template>

<style scoped>
.report-h {
  margin-bottom: 0.35rem;
  font-size: 1rem;
  font-weight: 600;
  color: #0f172a;
}
.report-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
}
.report-table th,
.report-table td {
  border: 1px solid #e2e8f0;
  padding: 0.3rem 0.45rem;
  text-align: left;
  vertical-align: top;
}
.report-table th {
  background: #f1f5f9;
  font-weight: 600;
  color: #334155;
}
.report-block {
  break-inside: avoid;
}
@media (max-width: 480px) {
  .report-table {
    font-size: 0.72rem;
  }
  .report-table th,
  .report-table td {
    padding: 0.25rem 0.3rem;
  }
}
</style>
