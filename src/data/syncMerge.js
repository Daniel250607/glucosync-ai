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

// ---------- Custom config (config/custom): per-section merge ----------
// The config payload holds override sections (presets, targets, medications, ...) plus
// `section_updated_at` ({ section: ms }) and `updated_at`. Each section is merged on its own
// (newest stamp wins, tie -> remote), so edits to different sections on two devices both survive.
// A removed section (reset to defaults) keeps its stamp, so the reset also wins over older copies.
// Legacy payloads without `section_updated_at` stamp every present section with `updated_at`.

const CONFIG_META = ['updated_at', 'section_updated_at']

function configSections(cfg) {
  if (!cfg || typeof cfg !== 'object') return []
  return Object.keys(cfg).filter((k) => !CONFIG_META.includes(k) && k !== '__proto__')
}

/** { section: ms } for a config payload (see above for legacy payloads). */
export function sectionStamps(cfg) {
  const out = {}
  if (!cfg || typeof cfg !== 'object') return out
  const own = cfg.section_updated_at && typeof cfg.section_updated_at === 'object' ? cfg.section_updated_at : {}
  for (const k of Object.keys(own)) {
    if (k !== '__proto__' && ts(own[k])) out[k] = ts(own[k])
  }
  const fallback = ts(cfg.updated_at)
  for (const k of configSections(cfg)) {
    if (!out[k] && fallback) out[k] = fallback
  }
  return out
}

/**
 * Payload to store after an edit. `changed` = sections the user just edited or reset (stamped `now`);
 * when omitted (e.g. a backup import) every section whose value differs from `prev` is stamped.
 */
export function stampConfig(prev, next, now, changed = null) {
  const prevStamps = sectionStamps(prev)
  const stamps = {}
  const keys = new Set([...configSections(prev), ...configSections(next), ...Object.keys(prevStamps)])
  for (const k of keys) {
    const touched = changed ? changed.includes(k) : JSON.stringify(prev?.[k]) !== JSON.stringify(next?.[k])
    const t = touched ? now : prevStamps[k] || 0
    if (t) stamps[k] = t
  }
  const out = {}
  for (const k of configSections(next)) out[k] = next[k]
  out.section_updated_at = stamps
  out.updated_at = Math.max(0, ...Object.values(stamps))
  return out
}

/** Merge local and remote config payloads section by section. */
export function mergeConfig(local = {}, remote = {}) {
  const lS = sectionStamps(local)
  const rS = sectionStamps(remote)
  const keys = new Set([...configSections(local), ...configSections(remote), ...Object.keys(lS), ...Object.keys(rS)])
  const out = {}
  const stamps = {}
  for (const k of keys) {
    const l = lS[k] || 0
    const r = rS[k] || 0
    const src = l > r ? local : remote
    if (src && src[k] !== undefined) out[k] = src[k]
    if (Math.max(l, r)) stamps[k] = Math.max(l, r)
  }
  out.section_updated_at = stamps
  out.updated_at = Math.max(0, ...Object.values(stamps))
  return out
}

/** True when `merged` has a section newer than the remote copy (i.e. the cloud must be updated). */
export function configNeedsUpload(merged, remote) {
  const rS = sectionStamps(remote)
  return Object.entries(sectionStamps(merged)).some(([k, t]) => t > (rS[k] || 0))
}
