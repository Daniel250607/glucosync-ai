// Weekly backup reminder (device-local; no backend and no silent downloads).
// Mobile browsers block or ignore downloads that are not started by a user gesture, so instead of an
// automatic download the app shows a reminder banner with a one-tap export when the last export on
// THIS device is older than 7 days. State lives in localStorage under `glucosync.backupMeta`.

export const BACKUP_META_KEY = 'glucosync.backupMeta'
export const BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
export const SNOOZE_MS = 24 * 60 * 60 * 1000

function validTime(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function loadBackupMeta() {
  let raw = null
  try {
    raw = JSON.parse(localStorage.getItem(BACKUP_META_KEY) || 'null')
  } catch {
    raw = null
  }
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    remind: o.remind !== false, // default ON
    lastBackupAt: validTime(o.lastBackupAt),
    snoozeUntil: validTime(o.snoozeUntil),
  }
}

export function saveBackupMeta(patch) {
  const next = { ...loadBackupMeta(), ...patch }
  try {
    localStorage.setItem(BACKUP_META_KEY, JSON.stringify(next))
  } catch {
    // Storage full / disabled: the reminder simply shows again next time.
  }
  return next
}

/** Days since the last export (floor), or null when never exported on this device. */
export function daysSinceBackup(meta, now = Date.now()) {
  if (!meta.lastBackupAt) return null
  return Math.max(0, Math.floor((now - meta.lastBackupAt) / (24 * 60 * 60 * 1000)))
}

/** Should the reminder banner be shown? Only when enabled, there is data, and the backup is stale. */
export function isBackupDue(meta, { hasData, now = Date.now() } = {}) {
  if (!meta || !meta.remind || !hasData) return false
  if (meta.snoozeUntil && now < meta.snoozeUntil) return false
  if (!meta.lastBackupAt) return true
  // A clock moved backwards (lastBackupAt in the future) counts as "recently backed up".
  return now - meta.lastBackupAt > BACKUP_INTERVAL_MS
}
