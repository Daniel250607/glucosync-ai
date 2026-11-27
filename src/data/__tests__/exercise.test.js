import { afterEach, describe, expect, it } from 'vitest'
import {
  exerciseDay,
  exerciseWeek,
  frequentExerciseTypes,
  isAfterMeal,
  isPostMealLog,
  keysEnding,
  ketoneCaution,
  logCredit,
  longestRestRun,
  shiftDateKey,
} from '../exercise.js'
import { applyCustomConfig, takesSglt2Inhibitor } from '../presets.js'
import { latestLabSnapshot } from '../labContext.js'
import { buildReport, complianceDefs, dayFlags, exerciseReport } from '../report.js'
import { exerciseContextLines, summarizeDay } from '../../services/gemini.js'

afterEach(() => applyCustomConfig({}))

const log = (o) => ({ type: '運動', actual_min: 10, duration_min: 10, ...o })

describe('frequentExerciseTypes', () => {
  const types = ['A', 'B', 'C', 'D']
  const day = (...names) => ({ exercise_logs: names.map((type) => ({ type })) })
  it('sorts by log count in the window, ties keep list order, then fills with unused types', () => {
    const days = { '2026-11-27': day('C', 'C', 'B'), '2026-11-20': day('D', '其他自訂') }
    expect(frequentExerciseTypes(days, '2026-11-27', types, { limit: 3 })).toEqual(['C', 'B', 'D'])
    expect(frequentExerciseTypes(days, '2026-11-27', types)).toEqual(['C', 'B', 'D', 'A'])
  })
  it('ignores logs outside the window and deleted days', () => {
    const days = { '2026-10-01': day('D'), '2026-11-27': { ...day('C'), deleted: true } }
    expect(frequentExerciseTypes(days, '2026-11-27', types, { windowDays: 30 })).toEqual(types)
  })
})

describe('logCredit', () => {
  it('moderate aerobic counts 1:1, vigorous double, light goes to light activity', () => {
    expect(logCredit(log({ category: 'aerobic', intensity: 'moderate', actual_min: 30 })).aerobic).toBe(30)
    expect(logCredit(log({ category: 'aerobic', intensity: 'vigorous' })).aerobic).toBe(20)
    const light = logCredit(log({ category: 'aerobic', intensity: 'light' }))
    expect(light).toMatchObject({ aerobic: 0, light: 10 })
  })
  it('strength and light categories never count as aerobic', () => {
    expect(logCredit(log({ category: 'strength', intensity: 'vigorous' }))).toMatchObject({ aerobic: 0, strength: 10, strengthDone: true })
    expect(logCredit(log({ category: 'light' }))).toMatchObject({ aerobic: 0, light: 10 })
  })
  it('old logs keep their walking-equivalent minutes as unrated aerobic', () => {
    const c = logCredit({ type: '深蹲', duration_min: 15, actual_min: 10, factor: 1.5 })
    expect(c).toMatchObject({ aerobic: 15, unrated: 15, actual: 10 })
  })
  it('aerobic without an intensity (meal tag) counts as moderate, marked unrated', () => {
    const c = logCredit({ type: '餐後踏步', category: 'aerobic', post_meal: true, duration_min: 20, actual_min: 20, source: 'meal_tag' })
    expect(c).toMatchObject({ aerobic: 20, unrated: 20, postMeal: 20 })
  })
  it('post-meal: explicit flag wins over the old meal-tag / name guess', () => {
    expect(isPostMealLog({ type: '餐後踏步' })).toBe(true)
    expect(isPostMealLog({ type: '散步', source: 'meal_tag' })).toBe(true)
    expect(isPostMealLog({ type: '餐後踏步', post_meal: false })).toBe(false)
    expect(isPostMealLog({ type: '騎車', post_meal: true })).toBe(true)
  })
})

describe('exerciseDay', () => {
  it('sums by category', () => {
    const s = exerciseDay({
      exercise_logs: [
        log({ category: 'aerobic', intensity: 'moderate', actual_min: 20, post_meal: true }),
        log({ category: 'aerobic', intensity: 'light', actual_min: 15 }),
        log({ category: 'strength', actual_min: 5 }),
      ],
    })
    expect(s).toMatchObject({ has: true, total: 40, aerobic: 20, light: 15, strength: 5, strengthDone: true, postMeal: 20, unrated: 0 })
  })
  it('old single exercise_min counts as unrated aerobic; deleted days count nothing', () => {
    expect(exerciseDay({ exercise_min: 25 })).toMatchObject({ has: true, aerobic: 25, unrated: 25 })
    expect(exerciseDay({ deleted: true, exercise_min: 25 }).has).toBe(false)
    expect(exerciseDay(null).has).toBe(false)
  })
})

describe('date keys', () => {
  it('shifts across month and year ends', () => {
    expect(shiftDateKey('2030-03-01', -1)).toBe('2030-02-28')
    expect(shiftDateKey('2030-12-31', 1)).toBe('2031-01-01')
    expect(shiftDateKey('bad', 1)).toBe('')
    expect(keysEnding('2030-01-02', 3)).toEqual(['2029-12-31', '2030-01-01', '2030-01-02'])
  })
})

describe('exerciseWeek', () => {
  const aerobic = (min, intensity = 'moderate') => ({ exercise_logs: [log({ category: 'aerobic', intensity, actual_min: min })] })
  const strength = { exercise_logs: [log({ category: 'strength' })] }
  it('rolls 7 days back, counting vigorous double and strength days', () => {
    const days = {
      '2030-01-01': aerobic(100), // outside the window ending 01-08
      '2030-01-02': aerobic(30),
      '2030-01-04': aerobic(20, 'vigorous'),
      '2030-01-05': strength,
      '2030-01-06': aerobic(30, 'light'),
      '2030-01-08': aerobic(30),
    }
    const w = exerciseWeek(days, '2030-01-08')
    expect(w).toMatchObject({ aerobic: 100, aerobicDays: 3, strengthDays: 1, light: 30, restDays: 0 })
  })
  it('restDays counts the days without aerobic activity up to the end date', () => {
    const days = { '2030-01-05': aerobic(30), '2030-01-06': strength }
    expect(exerciseWeek(days, '2030-01-08').restDays).toBe(3)
    expect(exerciseWeek({}, '2030-01-08').restDays).toBe(7)
  })
  it('longestRestRun finds the longest gap', () => {
    const days = { '2030-01-01': aerobic(30), '2030-01-05': aerobic(30) }
    expect(longestRestRun(days, keysEnding('2030-01-06', 6))).toBe(3)
  })
})

describe('isAfterMeal', () => {
  const meals = [{ time: '12:00' }, { time: '先前' }]
  it('true within the window after a meal, false before it or after the window', () => {
    expect(isAfterMeal(meals, '12:30', 120)).toBe(true)
    expect(isAfterMeal(meals, '14:00', 120)).toBe(true)
    expect(isAfterMeal(meals, '14:01', 120)).toBe(false)
    expect(isAfterMeal(meals, '11:59', 120)).toBe(false)
    expect(isAfterMeal([], '12:30', 120)).toBe(false)
  })
})

describe('ketone caution and SGLT-2 urine sugar', () => {
  const baseline = { labBaseline: { date: '2030-01-01', values: { u_ketones: '+++', u_sugar: '++++' } } }
  it('uses the latest urine ketone result', () => {
    applyCustomConfig(baseline)
    expect(ketoneCaution([])).toEqual({ value: '+++', date: '2030-01-01' })
    expect(ketoneCaution([{ date: '2030-02-01', u_ketones: '-' }])).toBeNull()
    expect(ketoneCaution([{ date: '2030-02-01', u_ketones: '±' }])).toEqual({ value: '±', date: '2030-02-01' })
  })
  it('detects SGLT-2 inhibitors by the generic suffix or the class name', () => {
    expect(takesSglt2Inhibitor([{ name: 'Brand (Examplegliflozin)' }])).toBe(true)
    expect(takesSglt2Inhibitor([{ name: 'Drug A', dosage: 'SGLT2 10 mg' }])).toBe(true)
    expect(takesSglt2Inhibitor([{ name: 'Drug B' }])).toBe(false)
  })
  it('U-Sugar is not judged or compared on an SGLT-2 inhibitor; U-Ketones still is', () => {
    applyCustomConfig({ ...baseline, medications: [{ id: 'x', name: 'Brand (Examplegliflozin)', timing: 'morning' }] })
    const rows = latestLabSnapshot([{ date: '2030-02-01', u_sugar: '++++', u_ketones: '+++' }])
    const sugar = rows.find((r) => r.key === 'u_sugar')
    expect(sugar.status).toBe('expected on SGLT-2 inhibitor')
    expect(sugar.trend).toBe('not compared (SGLT-2 inhibitor)')
    expect(rows.find((r) => r.key === 'u_ketones').status).toBe('positive')
    const report = buildReport({ days: {}, labs: [{ date: '2030-02-01', u_sugar: '++++' }], now: new Date(2030, 1, 10) })
    const reportSugar = report.labRows.find((r) => r.key === 'u_sugar')
    expect(reportSugar.target).toBe('預期陽性（SGLT-2 抑制劑作用）')
    expect(reportSugar.status).toBe('不判斷（藥物作用）')
  })
  it('without an SGLT-2 inhibitor U-Sugar is judged against negative', () => {
    applyCustomConfig(baseline)
    const sugar = latestLabSnapshot([{ date: '2030-02-01', u_sugar: '+' }]).find((r) => r.key === 'u_sugar')
    expect(sugar).toMatchObject({ status: 'positive', trend: 'improved' })
  })
})

describe('report and prompts', () => {
  const day = (logs) => ({ exercise_logs: logs, meals: [] })
  it('the daily compliance row checks post-meal minutes', () => {
    const def = complianceDefs({ exerciseTarget: 15 }).find((d) => d.id === 'ex')
    const yes = dayFlags(day([log({ category: 'aerobic', intensity: 'light', actual_min: 15, post_meal: true })]))
    const no = dayFlags(day([log({ category: 'aerobic', intensity: 'vigorous', actual_min: 40, post_meal: false })]))
    expect(def.test(yes)).toBe(true)
    expect(def.test(no)).toBe(false)
  })
  it('exerciseReport splits the window into 7-day blocks and skips empty ones', () => {
    const map = {}
    for (const k of keysEnding('2030-01-14', 7)) map[k] = day([log({ category: 'aerobic', intensity: 'moderate', actual_min: 25 })])
    map['2030-01-10'] = day([log({ category: 'strength' })])
    const keys = keysEnding('2030-01-14', 21)
    const r = exerciseReport(map, keys, { aerobicWeekTarget: 150 })
    expect(r.weeks).toHaveLength(1) // the two older blocks have no records
    expect(r.weeks[0]).toMatchObject({ start: '2030-01-08', end: '2030-01-14', aerobic: 150, strengthDays: 1, met: true })
    expect(r.weeksMet).toBe(1)
    expect(r.longestRest).toBe(1) // 01-10 had only strength
  })
  it('the prompt lines carry the weekly totals and the ketone caution', () => {
    const ctx = {
      ...summarizeDay({ date: '2030-01-08', exercise_logs: [log({ category: 'aerobic', intensity: 'moderate', actual_min: 10, post_meal: true })] }),
      exercise_week: { aerobic: 90, aerobicDays: 3, strengthDays: 1, restDays: 0 },
      ketone_caution: { value: '++', date: '2030-01-01' },
    }
    expect(ctx.exercise_breakdown).toMatchObject({ aerobic_min: 10, post_meal_min: 10 })
    const text = exerciseContextLines(ctx).join('\n')
    expect(text).toContain('aerobic 90/150')
    expect(text).toContain('urine ketone result is positive (++)')
    expect(text).toContain('10 min short')
  })
})
