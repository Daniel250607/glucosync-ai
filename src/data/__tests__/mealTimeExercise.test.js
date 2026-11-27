import { afterEach, describe, expect, it } from 'vitest'
import { eatenBefore, isClockTime, sortMealsByTime } from '../mealTime.js'
import { applyCustomConfig, estimateMet, exerciseKcal, exerciseProfile, guessExerciseCategory, guessExerciseMode, live, repsToMinutes } from '../presets.js'
import { normalizeExerciseProfile, summarizeDay } from '../../services/gemini.js'

afterEach(() => applyCustomConfig({}))

const meal = (id, time, carbs) => ({ id, time, analysis: { estimated_calories_kcal: 100, macronutrients: { carbs_g: carbs } } })

describe('meal time helpers', () => {
  it('validates HH:MM', () => {
    expect(isClockTime('07:30')).toBe(true)
    expect(isClockTime('24:00')).toBe(false)
    expect(isClockTime('7:30')).toBe(false)
    expect(isClockTime('')).toBe(false)
  })
  it('sorts by eaten time, stable for equal times', () => {
    const out = sortMealsByTime([meal('d', '19:00'), meal('l', '12:30'), meal('l2', '12:30'), meal('b', '07:00')])
    expect(out.map((m) => m.id)).toEqual(['b', 'l', 'l2', 'd'])
  })
  it('keeps meals with no valid time in place', () => {
    const out = sortMealsByTime([meal('d', '19:00'), { id: 'x', time: '先前' }, meal('l', '12:00')])
    expect(out.map((m) => m.id)).toEqual(['l', 'x', 'd'])
  })
  it('eatenBefore counts equal and earlier, and everything when time is unknown', () => {
    expect(eatenBefore({ time: '12:00' }, '12:00')).toBe(true)
    expect(eatenBefore({ time: '19:00' }, '12:00')).toBe(false)
    expect(eatenBefore({ time: '19:00' }, '')).toBe(true)
    expect(eatenBefore({ time: '先前' }, '12:00')).toBe(true)
  })
})

describe('summarizeDay with beforeTime', () => {
  const day = { date: '2030-01-01', meals: [meal('d', '19:00', 80), meal('l', '12:00', 50), meal('b', '07:00', 30)] }
  it('counts every meal by default', () => {
    expect(summarizeDay(day).carbs_g).toBe(160)
  })
  it('a lunch logged after dinner is judged only against meals eaten earlier', () => {
    const s = summarizeDay(day, { beforeTime: '12:00' })
    expect(s.carbs_g).toBe(80) // breakfast + lunch row itself is included (<=); dinner excluded
    expect(s.meals_analyzed).toBe(2)
  })
})

describe('exercise categories', () => {
  it('guesses strength moves, light chores and aerobic for the rest', () => {
    expect(guessExerciseCategory('深蹲')).toBe('strength')
    expect(guessExerciseCategory('抬腳跟')).toBe('strength')
    expect(guessExerciseCategory('重訓/肌力')).toBe('strength')
    expect(guessExerciseCategory('伸展')).toBe('light')
    expect(guessExerciseCategory('買東西走路')).toBe('light')
    expect(guessExerciseCategory('戶外散步')).toBe('aerobic') // intensity decides at logging time
    expect(guessExerciseCategory('開合跳')).toBe('aerobic')
    expect(guessExerciseCategory('餐後踏步')).toBe('aerobic')
  })
  it('saved category overrides the guess; invalid ones are dropped', () => {
    applyCustomConfig({ exerciseProfiles: { 開合跳: { category: 'strength' }, 散步: { category: 'bogus' } } })
    expect(exerciseProfile('開合跳').category).toBe('strength')
    expect(exerciseProfile('散步').category).toBe('aerobic')
  })
  it('old walking-equivalent factors are still accepted from storage but not used', () => {
    applyCustomConfig({ exerciseFactors: { 深蹲: 2, 騎車: 99 } })
    expect(live.exerciseFactors).toEqual({ 深蹲: 2 })
    expect(exerciseProfile('深蹲')).not.toHaveProperty('factor')
  })
  it('estimates MET from category and intensity', () => {
    expect(estimateMet('aerobic', 'light')).toBe(2.5)
    expect(estimateMet('aerobic', 'moderate')).toBe(4)
    expect(estimateMet('aerobic', 'vigorous')).toBe(7)
    expect(estimateMet('aerobic', undefined)).toBe(3.5)
    expect(estimateMet('strength', 'vigorous')).toBe(5)
    expect(estimateMet('light')).toBe(2.5)
  })
})

describe('exercise profiles', () => {
  it('guesses reps for counted moves and duration for timed ones', () => {
    expect(guessExerciseMode('站立著抬後腳跟')).toBe('reps')
    expect(guessExerciseMode('坐著，抬腿')).toBe('reps')
    expect(guessExerciseMode('深蹲')).toBe('reps')
    expect(guessExerciseMode('站立著，原地踏步')).toBe('duration')
    expect(guessExerciseMode('抬腿走路')).toBe('duration')
    expect(guessExerciseMode('騎車')).toBe('duration')
  })
  it('fills fallbacks: pace 20, no explicit MET', () => {
    const p = exerciseProfile('坐著，抬腿')
    expect(p).toMatchObject({ mode: 'reps', repsPerMin: 20, met: null, metEstimated: true })
  })
  it('saved profile overrides guess and is sanitized', () => {
    applyCustomConfig({ exerciseProfiles: { 原地踏步: { mode: 'reps', repsPerMin: 999, met: 4 }, x: { mode: 'bad' } } })
    const p = exerciseProfile('原地踏步')
    expect(p.mode).toBe('reps')
    expect(p.repsPerMin).toBe(20) // 999 rejected -> default
    expect(p).toMatchObject({ met: 4, metEstimated: false })
    expect(live.exerciseProfiles.x).toBeUndefined()
  })
  it('reps x sets become minutes at the pace', () => {
    expect(repsToMinutes(50, 2, 20)).toBe(5)
    expect(repsToMinutes(50, 1, 30)).toBe(1.7)
    expect(repsToMinutes(0, 1, 20)).toBe(0.1)
  })
  it('kcal = MET x kg x hours', () => {
    expect(exerciseKcal(3.5, 70, 60)).toBe(245)
    expect(exerciseKcal(5, 60, 6)).toBe(30)
  })
})

describe('normalizeExerciseProfile', () => {
  it('clamps AI values and rejects a missing category / met', () => {
    expect(normalizeExerciseProfile({ mode: 'reps', category: 'strength', reps_per_min: 500, met: 0.2, reason: 'r' }))
      .toEqual({ mode: 'reps', category: 'strength', repsPerMin: 200, met: 1, reason: 'r' })
    const ok = { category: 'aerobic', met: 3.5 }
    expect(normalizeExerciseProfile({ ...ok, mode: 'x', reps_per_min: 0 }).mode).toBe('duration')
    // 0 (duration activity) or junk -> default pace, never 1 rep/min (which would inflate reps-mode minutes)
    expect(normalizeExerciseProfile({ ...ok, mode: 'duration', reps_per_min: 0 }).repsPerMin).toBe(20)
    expect(normalizeExerciseProfile({ ...ok, mode: 'reps', reps_per_min: 'x' }).repsPerMin).toBe(20)
    expect(normalizeExerciseProfile({ ...ok, mode: 'reps', reps_per_min: 0.4 }).repsPerMin).toBe(20)
    expect(() => normalizeExerciseProfile({ category: 'aerobic', met: 'x' })).toThrow()
    expect(() => normalizeExerciseProfile({ category: 'cardio', met: 3 })).toThrow()
  })
})
