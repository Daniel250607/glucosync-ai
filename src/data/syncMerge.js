// Pure merge logic for localStorage <-> Firestore sync (no imports; unit-testable).
//
// Every saved record carries `updatedAt` (ms). Deleting a day leaves a TOMBSTONE instead of
// removing the cloud document: Firestore `days/{date}` = { date, deleted: true, deletedAt } and a
// local entry in `glucosync.dayTombstones` ({ [date]: deletedAt }). Rules per id:
// - The newest live copy wins (local vs remote by updatedAt; tie -> remote, the old behaviour).
// - A tombstone hides every copy with updatedAt <= deletedAt (legacy copies without updatedAt
//   count as 0, so they are always hidden by a tombstone) and is never re-uploaded as a day.
// - A genuine edit made after the deletion (updatedAt > deletedAt) revives the record.
// - A local-only copy without tombstone (e.g. created offline) is kept and uploaded. Legacy
//   local-only copies (no updatedAt) are uploaded only when `uploadLegacyLocal` is true: for days
//   they may be remnants of a deletion made by an older app version, so they stay local only.

export const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

/** Positive finite millisecond timestamp, else 0. */
export function ts(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function isTombstone(rec) {
  return !!(rec && typeof rec === 'object' && rec.deleted === true)
}

const isLive = (rec) => !!(rec && typeof rec === 'object' && !Array.isArray(rec) && !isTombstone(rec))

/**
 * @param {object} p
 * @param {Record<string, object>} p.local   local records by id
 * @param {Record<string, object>} p.remote  remote docs by id (live records or tombstones)
 * @param {Record<string, number>} [p.localTombstones]  { id: deletedAt }
 * @param {boolean} [p.uploadLegacyLocal]
 * @returns {{ merged: object, tombstones: object, uploads: Array<[string, object]>,
 *             pushTombstones: Array<[string, number]>, removed: string[] }}
 */
export function mergeSynced({ local = {}, remote = {}, localTombstones = {}, uploadLegacyLocal = false } = {}) {
  const merged = {}
  const tombstones = {}
  const uploads = []
  const pushTombstones = []
  const removed = []
  const ids = new Set([...Object.keys(local || {}), ...Object.keys(remote || {}), ...Object.keys(localTombstones || {})])
  for (const id of ids) {
    const L = isLive(local[id]) ? local[id] : null
    if (!DATE_KEY_RE.test(id)) {
      // Unknown key shape: leave local data untouched, never sync it.
      if (L && id !== '__proto__') merged[id] = L
      continue
    }
    const rawR = remote[id]
    const R = isLive(rawR) ? rawR : null
    const rT = isTombstone(rawR) ? ts(rawR.deletedAt) || 1 : 0
    const lT = ts(localTombstones[id])
    const T = Math.max(rT, lT)
    const lU = L ? ts(L.updatedAt) : -1
    const rU = R ? ts(R.updatedAt) : -1

    let win = null
    let side = null
    if (R && (!L || rU >= lU)) {
      win = R
      side = 'remote'
    } else if (L) {
      win = L
      side = 'local'
    }
    if (win && T > 0 && ts(win.updatedAt) <= T) win = null // deleted later than the newest edit

    if (!win) {
      if (T > 0) {
        tombstones[id] = T
        if (rT < T) pushTombstones.push([id, T]) // cloud still lacks (or has an older) tombstone
      }
      if (L) removed.push(id)
      continue
    }
    merged[id] = win // newer than any tombstone -> revived; tombstone dropped
    // Local copy won (cloud missing, older, or only a tombstone older than this edit): upload it.
    if (side === 'local' && (lU > 0 || uploadLegacyLocal)) uploads.push([id, L])
  }
  return { merged, tombstones, uploads, pushTombstones, removed }
}
