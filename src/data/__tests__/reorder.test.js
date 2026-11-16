import { describe, expect, it } from 'vitest'
import { moveItem, sameOrder } from '../reorder.js'

describe('moveItem', () => {
  const list = ['踏步', '散步', '深蹲', '抬腿']
  it('moves an item down and up without changing the input', () => {
    expect(moveItem(list, 0, 2)).toEqual(['散步', '深蹲', '踏步', '抬腿'])
    expect(moveItem(list, 3, 1)).toEqual(['踏步', '抬腿', '散步', '深蹲'])
    expect(list).toEqual(['踏步', '散步', '深蹲', '抬腿'])
  })
  it('ignores out-of-range indexes', () => {
    expect(moveItem(list, -1, 2)).toEqual(list)
    expect(moveItem(list, 1, 9)).toEqual(list)
  })
  it('sameOrder', () => {
    expect(sameOrder(list, [...list])).toBe(true)
    expect(sameOrder(list, moveItem(list, 0, 1))).toBe(false)
  })
})
