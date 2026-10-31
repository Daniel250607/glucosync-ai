import { afterEach, describe, expect, it } from 'vitest'
import { eatenBefore, isClockTime, sortMealsByTime } from '../mealTime.js'
import { applyCustomConfig, equivalentMinutes, exerciseFactor, live } from '../presets.js'
import { clampExerciseFactor, summarizeDay } from '../../services/gemini.js'

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

describe('exercise equivalence factors', () => {
  it('defaults: unknown types are 1, squats above 1', () => {
    expect(exerciseFactor('戶外散步')).toBe(1)
    expect(exerciseFactor('深蹲')).toBeGreaterThan(1)
    expect(exerciseFactor('抬腳跟')).toBeLessThan(1)
  })
  it('user factors override defaults and are sanitized', () => {
    applyCustomConfig({ exerciseFactors: { 深蹲: 2, 騎車: 99, 游泳: 'x', __proto__: 3 } })
    expect(exerciseFactor('深蹲')).toBe(2)
    expect(exerciseFactor('騎車')).toBe(1) // out of range, dropped
    expect(exerciseFactor('游泳')).toBe(1)
    expect(live.exerciseFactors['抬腳跟']).toBeDefined() // defaults remain
  })
  it('equivalentMinutes rounds and never drops below 1', () => {
    expect(equivalentMinutes(10, 1.5)).toBe(15)
    expect(equivalentMinutes(1, 0.7)).toBe(1)
    expect(equivalentMinutes(0, 2)).toBe(1)
  })
})

describe('clampExerciseFactor', () => {
  it('clamps into 0.1-5, rounds to 2 decimals and rejects junk', () => {
    expect(clampExerciseFactor(1.234)).toBe(1.23)
    expect(clampExerciseFactor(99)).toBe(5)
    expect(clampExerciseFactor(-3)).toBe(0.1)
    expect(clampExerciseFactor('x')).toBeNull()
    expect(clampExerciseFactor(undefined)).toBeNull()
  })
})
