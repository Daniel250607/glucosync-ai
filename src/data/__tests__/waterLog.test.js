import { describe, expect, it } from 'vitest'
import {
  changeWater,
  lastWaterTime,
  minutesBetween,
  removeWaterLog,
  undoWaterChange,
  untimedWaterCc,
  waterLogs,
} from '../waterLog.js'
import { mealsForSummary, summarizeDay } from '../../services/gemini.js'

const day = (extra = {}) => ({ date: '2030-01-01', hydration_cc: 0, drinks: [], meals: [], ...extra })

describe('changeWater', () => {
  it('adding logs the time and raises the total', () => {
    const d = day()
    const r = changeWater(d, 300, '09:15')
    expect(r.applied).toBe(300)
    expect(d.hydration_cc).toBe(300)
    expect(waterLogs(d)).toEqual([{ id: r.added.id, time: '09:15', cc: 300 }])
  })

  it('removing takes from the latest log first and never goes below 0', () => {
    const d = day()
    changeWater(d, 300, '09:00')
    changeWater(d, 100, '11:00')
    const r = changeWater(d, -200, '12:00')
    expect(r.applied).toBe(-200)
    expect(d.hydration_cc).toBe(200)
    expect(waterLogs(d).map((w) => [w.time, w.cc])).toEqual([['09:00', 200]])
    expect(changeWater(d, -500, '12:00').applied).toBe(-200)
    expect(d.hydration_cc).toBe(0)
    expect(waterLogs(d)).toEqual([])
  })

  it('undo reverses both an add and a removal', () => {
    const d = day()
    const add = changeWater(d, 300, '09:00')
    changeWater(d, 100, '10:00')
    const sub = changeWater(d, -200, '11:00')
    undoWaterChange(d, sub)
    expect(d.hydration_cc).toBe(400)
    expect(waterLogs(d).map((w) => w.cc)).toEqual([300, 100])
    undoWaterChange(d, add)
    expect(d.hydration_cc).toBe(100)
    expect(waterLogs(d).map((w) => w.time)).toEqual(['10:00'])
  })
})

describe('legacy and drinks', () => {
  it('pure water without logs shows as untimed; drinks counted as water are excluded', () => {
    const d = day({ hydration_cc: 900, drinks: [{ time: '08:00', name: '茶', volume_cc: 400, counts_as_water: true }] })
    expect(untimedWaterCc(d)).toBe(500)
    changeWater(d, 200, '10:00')
    expect(untimedWaterCc(d)).toBe(500)
  })

  it('removeWaterLog subtracts the entry', () => {
    const d = day()
    const r = changeWater(d, 250, '13:00')
    removeWaterLog(d, r.added.id)
    expect(d.hydration_cc).toBe(0)
    expect(waterLogs(d)).toEqual([])
  })

  it('lastWaterTime includes drinks that count as water only', () => {
    const d = day({
      drinks: [
        { time: '15:00', name: '咖啡', volume_cc: 200, counts_as_water: false },
        { time: '12:30', name: '茶', volume_cc: 300, counts_as_water: true },
      ],
    })
    expect(lastWaterTime(d)).toBe('12:30')
    changeWater(d, 100, '14:00')
    expect(lastWaterTime(d)).toBe('14:00')
    expect(lastWaterTime(day())).toBe('')
  })

  it('minutesBetween', () => {
    expect(minutesBetween('09:15', '11:30')).toBe(135)
    expect(minutesBetween('11:30', '09:15')).toBeNull()
    expect(minutesBetween('', '09:15')).toBeNull()
  })

  it('summarizeDay passes water times and drink times to the AI', () => {
    const d = day({ drinks: [{ time: '08:00', name: '茶', volume_cc: 300, counts_as_water: true }], hydration_cc: 300 })
    changeWater(d, 200, '10:00')
    const s = summarizeDay(d)
    expect(s.water_logs).toEqual([{ time: '10:00', cc: 200 }])
    expect(s.drinks[0].time).toBe('08:00')
  })
})

describe('mealsForSummary', () => {
  it('keeps the user description, items and eating order', () => {
    const out = mealsForSummary([
      {
        time: '12:00',
        text: '先吃青菜再吃雞腿，飯吃一半',
        tags: [],
        analysis: {
          meal_name: '雞腿便當',
          items: [{ name: '青菜', portion: '1 份' }, { name: '雞腿', portion: '1 隻' }, { name: '白飯', portion: '半碗' }],
          eating_order_feedback: '順序正確',
          macronutrients: { carbs_g: 40, saturated_fat_g: 5, sodium_mg: 900 },
        },
      },
      { time: '18:00', text: '水餃 10 顆', tags: [], analysis: null },
    ])
    expect(out[0]).toMatchObject({ name: '雞腿便當', description: '先吃青菜再吃雞腿，飯吃一半', eating_order: '順序正確', carbs_g: 40 })
    expect(out[0].items).toHaveLength(3)
    expect(out[1]).toMatchObject({ name: '水餃 10 顆', analyzed: false })
    expect(out[1].items).toBeUndefined()
  })
})
