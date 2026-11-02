import { describe, expect, it } from 'vitest'
import { configNeedsUpload, isTombstone, mergeConfig, mergeSynced, sectionStamps, stampConfig, ts } from '../syncMerge.js'

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

describe('config per-section merge', () => {
  it('keeps edits to different sections from two devices', () => {
    const base = stampConfig({}, { tags: ['a'], targets: { carbsMin: 120 } }, 100)
    const phone = stampConfig(base, { ...base, tags: ['a', 'b'] }, 200, ['tags'])
    const pc = stampConfig(base, { ...base, targets: { carbsMin: 130 } }, 300, ['targets'])
    const merged = mergeConfig(pc, phone)
    expect(merged.tags).toEqual(['a', 'b'])
    expect(merged.targets).toEqual({ carbsMin: 130 })
    expect(merged.section_updated_at).toEqual({ tags: 200, targets: 300 })
    expect(merged.updated_at).toBe(300)
    expect(configNeedsUpload(merged, phone)).toBe(true)
    expect(configNeedsUpload(merged, merged)).toBe(false)
  })
  it('a newer reset (section removed) wins over an older copy', () => {
    const remote = stampConfig({}, { presets: [{ label: 'x' }] }, 100)
    const local = stampConfig(remote, {}, 200, ['presets'])
    expect(local.section_updated_at.presets).toBe(200)
    expect(mergeConfig(local, remote)).not.toHaveProperty('presets')
  })
  it('stamps only sections whose value changed when `changed` is omitted', () => {
    const prev = stampConfig({}, { tags: ['a'], targets: { carbsMin: 120 } }, 100)
    const next = stampConfig(prev, { tags: ['a'], targets: { carbsMin: 140 } }, 500)
    expect(next.section_updated_at).toEqual({ tags: 100, targets: 500 })
  })
  it('treats legacy payloads (no section stamps) as stamped with updated_at; tie -> remote', () => {
    const legacy = { tags: ['old'], updated_at: 100 }
    expect(sectionStamps(legacy)).toEqual({ tags: 100 })
    expect(mergeConfig({ tags: ['local'], updated_at: 100 }, legacy).tags).toEqual(['old'])
    expect(mergeConfig({ tags: ['local'], updated_at: 150 }, legacy).tags).toEqual(['local'])
  })
  it('ignores __proto__ keys', () => {
    const evil = JSON.parse('{"__proto__": {"x": 1}, "section_updated_at": {"__proto__": 9}, "updated_at": 5}')
    const merged = mergeConfig(evil, {})
    expect(Object.keys(merged.section_updated_at)).toEqual([])
    expect({}.x).toBeUndefined()
  })
})
