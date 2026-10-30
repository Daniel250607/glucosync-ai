import { describe, expect, it } from 'vitest'
import { isTombstone, mergeSynced, ts } from '../syncMerge.js'

const D = '2026-09-05'

describe('ts / isTombstone', () => {
  it('normalises timestamps', () => {
    expect(ts(5)).toBe(5)
    expect(ts('7')).toBe(7)
    expect(ts(-1)).toBe(0)
    expect(ts('x')).toBe(0)
    expect(ts(undefined)).toBe(0)
  })
  it('detects tombstones', () => {
    expect(isTombstone({ deleted: true })).toBe(true)
    expect(isTombstone({ deleted: false })).toBe(false)
    expect(isTombstone(null)).toBe(false)
  })
})

describe('mergeSynced', () => {
  it('newest live copy wins', () => {
    const r = mergeSynced({ local: { [D]: { updatedAt: 2 } }, remote: { [D]: { updatedAt: 1 } } })
    expect(r.merged[D].updatedAt).toBe(2)
    expect(r.uploads).toEqual([[D, { updatedAt: 2 }]])
  })

  it('tie goes to remote and is not re-uploaded', () => {
    const remote = { updatedAt: 5, tag: 'r' }
    const r = mergeSynced({ local: { [D]: { updatedAt: 5, tag: 'l' } }, remote: { [D]: remote } })
    expect(r.merged[D].tag).toBe('r')
    expect(r.uploads).toHaveLength(0)
  })

  it('remote tombstone hides older local copy and removes it', () => {
    const r = mergeSynced({
      local: { [D]: { updatedAt: 10 } },
      remote: { [D]: { deleted: true, deletedAt: 20 } },
    })
    expect(r.merged[D]).toBeUndefined()
    expect(r.removed).toEqual([D])
    expect(r.tombstones[D]).toBe(20)
    expect(r.pushTombstones).toHaveLength(0)
  })

  it('local tombstone is pushed to a cloud that lacks it', () => {
    const r = mergeSynced({
      local: { [D]: { updatedAt: 10 } },
      remote: { [D]: { updatedAt: 10 } },
      localTombstones: { [D]: 30 },
    })
    expect(r.merged[D]).toBeUndefined()
    expect(r.pushTombstones).toEqual([[D, 30]])
  })

  it('edit after deletion revives the record and drops the tombstone', () => {
    const r = mergeSynced({
      local: { [D]: { updatedAt: 50 } },
      remote: { [D]: { deleted: true, deletedAt: 20 } },
    })
    expect(r.merged[D].updatedAt).toBe(50)
    expect(r.tombstones[D]).toBeUndefined()
    expect(r.uploads).toHaveLength(1)
  })

  it('legacy copy without updatedAt is always hidden by a tombstone', () => {
    const r = mergeSynced({ local: { [D]: {} }, remote: { [D]: { deleted: true, deletedAt: 1 } } })
    expect(r.merged[D]).toBeUndefined()
  })

  it('local-only legacy copy is uploaded only when uploadLegacyLocal', () => {
    expect(mergeSynced({ local: { [D]: {} } }).uploads).toHaveLength(0)
    expect(mergeSynced({ local: { [D]: {} }, uploadLegacyLocal: true }).uploads).toHaveLength(1)
  })

  it('local-only copy with updatedAt (offline-created) is kept and uploaded', () => {
    const r = mergeSynced({ local: { [D]: { updatedAt: 3 } } })
    expect(r.merged[D]).toBeDefined()
    expect(r.uploads).toHaveLength(1)
  })

  it('non-date keys stay local and are never uploaded', () => {
    const r = mergeSynced({ local: { foo: { a: 1 } }, remote: { foo: { a: 2 } } })
    expect(r.merged.foo).toEqual({ a: 1 })
    expect(r.uploads).toHaveLength(0)
  })

  it('remote-only record is adopted', () => {
    const r = mergeSynced({ remote: { [D]: { updatedAt: 4 } } })
    expect(r.merged[D].updatedAt).toBe(4)
    expect(r.uploads).toHaveLength(0)
  })
})
