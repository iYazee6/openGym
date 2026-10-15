// Weigh-ins other apps saved to Health Connect (a smart scale, Samsung Health, Google Fit…), taken
// into the body weight log (#544). The Android app reads them (lib/health-sync.js and
// HealthConnectPlugin.readWeights); this file decides, from the records alone, what changes in
// S.bodyweight. Nothing here talks to Health Connect.
//
// The log keeps one weigh-in per day ({ d, w, t }, `w` in the profile's unit). A day with several
// readings takes the earliest: the morning weigh-in before breakfast is the one worth following.
// A weigh-in typed in openGym always wins: an import never replaces it. An imported one carries
// `src: 'hc'`, so a later import may move it to an earlier reading of the same day, and the write
// side (lib/health-connect.js) does not write it back to Health Connect where it came from.
import { isoOf } from './format.js'

export const HC_SRC = 'hc'
// What openGym writes carries a client record id of its own (lib/health-connect.js weightRecord).
export const OWN_ID_PREFIX = 'opengym-'
// The first read reaches back a year. Health Connect itself may give less: without the history
// permission it answers only for the 30 days before the read permission was first granted.
export const FIRST_READ_DAYS = 365
// Each later read starts this far before the last one: a scale or a watch often syncs its
// reading into Health Connect hours after it was taken, with the time it was taken.
export const OVERLAP_DAYS = 7
const DAY_MS = 86400000
const LB_PER_KG = 2.2046226218

/** From when a read asks Health Connect for weigh-ins, in ms; `readAt` 0 is the first read. */
export function readSince(readAt, now = Date.now()) {
  const last = Number(readAt)
  return last > 0 ? Math.max(0, last - OVERLAP_DAYS * DAY_MS) : now - FIRST_READ_DAYS * DAY_MS
}

/** A record openGym wrote itself: by its client record id, or by the app it came from. */
export function isOwnRecord(rec, ownPackage = null) {
  if (String(rec?.clientRecordId || '').startsWith(OWN_ID_PREFIX)) return true
  return !!ownPackage && rec?.origin === ownPackage
}

/** Whether a weigh-in in the log came from Health Connect, rather than being typed in openGym. */
export const isImported = b => b?.src === HC_SRC

// The earliest reading of each day, as a log entry in the profile's unit. Records without a
// usable time or weight, openGym's own, and those before `since` are left out.
function earliestByDay(records, { unit, ownPackage, since }) {
  const byDay = new Map()
  for (const rec of Array.isArray(records) ? records : []) {
    const time = Number(rec?.time), kg = Number(rec?.kg)
    if (!(time > 0) || !(kg > 0) || isOwnRecord(rec, ownPackage)) continue
    if (since > 0 && time < since) continue
    const d = isoOf(new Date(time))
    const cur = byDay.get(d)
    if (cur && cur.t <= time) continue
    const w = Math.round((unit === 'lb' ? kg * LB_PER_KG : kg) * 10) / 10
    byDay.set(d, { d, w, t: time, src: HC_SRC })
  }
  return byDay
}

/**
 * The body weight log with the records read from Health Connect taken in. Pure: `bodyweight` is
 * not changed. `records` are the plugin's [{ id, time, kg, origin, clientRecordId }].
 * Options: `unit` ('kg' | 'lb', the profile's), `deleted` (S.deleted.bodyweight: a day the user
 * removed is not brought back by an import), `ownPackage` (openGym's own package name), `since`
 * (records before it are ignored).
 * Returns { bodyweight, added, updated } — `bodyweight` the same array when nothing changed.
 */
export function mergeImportedWeights(bodyweight, records, { unit = 'kg', deleted = null, ownPackage = null, since = 0 } = {}) {
  const list = Array.isArray(bodyweight) ? bodyweight : []
  const incoming = earliestByDay(records, { unit: unit === 'lb' ? 'lb' : 'kg', ownPackage, since })
  if (!incoming.size) return { bodyweight: list, added: 0, updated: 0 }
  const byDay = new Map(list.filter(b => b?.d).map(b => [b.d, b]))
  let added = 0, updated = 0
  const out = list.slice()
  for (const [d, entry] of incoming) {
    const cur = byDay.get(d)
    if (!cur) {
      if (Number(deleted?.[d]) > 0) continue   // removed in openGym: it stays removed
      out.push(entry)
      added++
      continue
    }
    if (!isImported(cur)) continue              // typed in openGym: it wins
    const curT = Number(cur.t) || 0
    const earlier = entry.t < curT
    const corrected = entry.t === curT && entry.w !== cur.w
    if (!earlier && !corrected) continue
    out[out.indexOf(cur)] = { ...cur, ...entry }
    updated++
  }
  if (!added && !updated) return { bodyweight: list, added: 0, updated: 0 }
  out.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
  return { bodyweight: out, added, updated }
}
