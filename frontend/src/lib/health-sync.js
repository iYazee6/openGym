// Health Connect on the Android app (#200): turning it on, and keeping it in step with the log.
// What gets written is worked out in lib/health-connect.js; this file owns the native plugin
// (HealthConnectPlugin.java) and the phone's own record of what it wrote.
//
// It is a fact about this phone, not about the training log: kept in its own file in the app's
// data directory, never in S, so it does not sync to a server, ride in a backup, or switch on a
// second phone. Off until the user turns it on; nothing is asked of Health Connect before that.
//
// The read side (#544) is its own switch: weigh-ins other apps saved to Health Connect are taken
// into the body weight log (lib/health-import.js decides how). Off until the user turns it on, with
// its own permission, asked only then.
//
// The web build never gets here (MOBILE is a build-time flag), and iOS answers 'unsupported'.
import { MOBILE, isAndroid, readJsonFile, writeJsonFile } from './mobile.js'
import { healthRecords, planSync, writtenIds } from './health-connect.js'
import { mergeImportedWeights, readSince } from './health-import.js'
import { exerciseNameFor } from './i18n-core.js'
import { EXIDX } from './exercises.js'
import { speedUnitOf } from './speed.js'

export const HEALTH_FILE = 'opengym-health.json'
// on/written/at/error: the write side. readOn/readAt/readError: the read side, readAt being when
// the last read went through.
const OFF = { on: false, written: {}, at: 0, error: null, readOn: false, readAt: 0, readError: null }

// Wrapped in an object, as in rest-alert.js: a Capacitor plugin proxy answers `then`, so a
// promise resolved with the bare proxy never settles.
let pluginP = null
const plugin = () => pluginP || (pluginP = (async () => {
  if (!(await isAndroid())) return null
  const { registerPlugin } = await import('@capacitor/core')
  return { HC: registerPlugin('HealthConnect') }
})().catch(() => null))

// The file's content, read once and then kept here: a save while it is off (the usual case) must
// not cost a file read, and every change to it goes through saveHealth anyway.
let cached = null
export async function loadHealth() {
  if (cached) return cached
  const f = await readJsonFile(HEALTH_FILE)
  cached = f && typeof f === 'object' ? { ...OFF, ...f, written: f.written && typeof f.written === 'object' ? f.written : {} } : { ...OFF }
  return cached
}
const saveHealth = h => { cached = h; return writeJsonFile(HEALTH_FILE, h) }

/** { status: 'available' | 'update' | 'missing' | 'unsupported', granted, readGranted } */
export async function healthStatus() {
  if (!MOBILE) return { status: 'unsupported', granted: false }
  try {
    const p = await plugin()
    if (!p) return { status: 'unsupported', granted: false }
    return await p.HC.status()
  } catch { return { status: 'unsupported', granted: false } }
}

/** Health Connect's own screen for what apps wrote, or its store page where it is missing. */
export async function openHealthConnect() {
  const p = await plugin()
  if (p) await p.HC.openSettings()
}

const nameOf = e => (EXIDX[e.id] ? exerciseNameFor(EXIDX[e.id]) : (e.n || e.id))

// One sync at a time. A change that comes in while one runs is not lost: the running one is
// followed by a single further pass with the newest state.
let running = null
let again = null
const listeners = new Set()
/** Called with the file's new content after every sync, for the Settings row. */
export function onHealthChange(cb) { listeners.add(cb); return () => listeners.delete(cb) }
const told = h => { listeners.forEach(cb => { try { cb(h) } catch { /* a closed screen */ } }) }

/**
 * Writes what changed since the last sync and removes what was deleted from openGym. A no-op
 * while it is off. Resolves with the file's content afterwards; `error` is 'permission' when
 * Health Connect refused (the user took the permission back), 'unavailable' when it is gone.
 */
export function syncHealth(S) {
  if (!MOBILE) return Promise.resolve(null)
  // Not read yet: initHealthSync reads it at launch and syncs then, which covers a save made
  // before that; the save path itself never waits on the file.
  if (!cached || !cached.on) return Promise.resolve(cached)
  if (running) { again = S; return running }
  again = null
  running = (async () => {
    let h = await loadHealth()
    let next = S
    while (next) {
      if (h.on) h = await syncOnce(next, h)
      // A state that came in meanwhile, taken only now: cleared before a pass, it would lose a
      // change made while the pass was starting.
      next = again
      again = null
    }
    return h
  })().finally(() => { running = null })
  return running
}

async function syncOnce(S, h) {
  const p = await plugin()
  if (!p) return h
  const plan = planSync(healthRecords(S, { nameOf, speedUnit: speedUnitOf(S) }), h.written)
  const nothing = !plan.sessions.length && !plan.weights.length && !plan.remove.sessions.length && !plan.remove.weights.length
  if (nothing) {
    if (!h.error) return h
    // Nothing to write, but the last attempt failed: clear it once Health Connect says yes again.
    const st = await p.HC.status().catch(() => null)
    if (!(st?.status === 'available' && st.granted)) return h
    const out = { ...(await loadHealth()), error: null }
    await saveHealth(out)
    told(out)
    return out
  }
  let out = { ...h }
  try {
    if (plan.sessions.length || plan.weights.length) {
      await p.HC.write({ sessions: plan.sessions, weights: plan.weights })
      // Written but not yet removed: kept as written, so a failed remove is tried again.
      const kept = Object.fromEntries(Object.entries(h.written).filter(([id]) => !plan.written[id]))
      out.written = { ...kept, ...plan.written }
    }
    if (plan.remove.sessions.length || plan.remove.weights.length) await p.HC.remove(plan.remove)
    out = { ...out, written: plan.written, at: Date.now(), error: null }
  } catch (e) {
    out.error = e?.code === 'permission' ? 'permission' : e?.code === 'unavailable' ? 'unavailable' : 'failed'
  }
  // Only the write side's own fields: a read that went through meanwhile keeps what it saved.
  out = { ...(await loadHealth()), written: out.written, at: out.at, error: out.error }
  await saveHealth(out)
  told(out)
  return out
}

/**
 * Turning it on: asks for the two write permissions, then writes the whole log once. Resolves
 * with { ok, reason } — reason 'denied' when the user did not grant both, or the status when
 * Health Connect is not there to ask.
 */
export async function enableHealth(S) {
  const p = await plugin()
  if (!p) return { ok: false, reason: 'unsupported' }
  const st = await p.HC.status().catch(() => ({ status: 'unsupported' }))
  if (st.status !== 'available') return { ok: false, reason: st.status }
  const granted = st.granted || (await p.HC.requestPermissions().catch(() => ({ granted: false }))).granted
  if (!granted) return { ok: false, reason: 'denied' }
  const h = await loadHealth()
  await saveHealth({ ...h, on: true, error: null })
  const after = await syncHealth(S)
  return { ok: !after?.error, reason: after?.error || null, health: after }
}

/**
 * Turning it off stops the writing. With `removeWritten`, what openGym wrote is taken out of
 * Health Connect too; without it, it stays there as the user's own data. Rejects when the
 * removal fails, and then stays on, so nothing is left behind that the phone forgot it wrote.
 */
export async function disableHealth({ removeWritten = false } = {}) {
  if (running) await running.catch(() => {})
  const h = await loadHealth()
  if (removeWritten) {
    const ids = writtenIds(h.written)
    if (ids.sessions.length || ids.weights.length) {
      const p = await plugin()
      if (!p) throw new Error('unavailable')
      await p.HC.remove(ids)
    }
  }
  // Read again after the remove: a read that went through meanwhile keeps what it saved.
  const out = { ...(await loadHealth()), on: false, error: null, written: removeWritten ? {} : h.written }
  await saveHealth(out)
  told(out)
  return out
}

// ---- Reading weigh-ins (#544) ----------------------------------------------------------------

// How the read side reaches the store: its state, and its own update path (useStore update), so an
// imported weigh-in is stamped, saved, synced and merged like one typed in. Set by initHealthSync.
let store = null

let reading = null
/**
 * Reads the weigh-ins saved to Health Connect since the last read (the first time: the last
 * year) and takes them into the log. A no-op while the read side is off. Resolves with
 * { health, added, updated }: the file's content afterwards (`readError` says why a read
 * failed: 'permission', 'unavailable' or 'failed'), and how many weigh-ins the log gained or had
 * moved to an earlier reading of their day.
 */
export function importHealth() {
  if (!MOBILE || !store) return Promise.resolve(null)
  if (reading) return reading
  reading = (async () => {
    const h = await loadHealth()
    if (!h.readOn) return { health: h, added: 0, updated: 0 }
    const p = await plugin()
    if (!p) return { health: h, added: 0, updated: 0 }
    const now = Date.now()
    const since = readSince(h.readAt, now)
    let out, added = 0, updated = 0
    try {
      const res = await p.HC.readWeights({ since })
      const records = Array.isArray(res?.records) ? res.records : []
      const opts = S => ({ unit: S?.unit, deleted: S?.deleted?.bodyweight, ownPackage: res?.own || null, since })
      const S = store.get()
      const first = mergeImportedWeights(S?.bodyweight, records, opts(S))
      if (first.added || first.updated) {
        // Merged again inside the update, on the copy the store holds then: a weigh-in typed
        // while Health Connect was answering is not overwritten by a merge made before it.
        store.apply(draft => {
          const r = mergeImportedWeights(draft.bodyweight, records, opts(draft))
          draft.bodyweight = r.bodyweight
          added = r.added
          updated = r.updated
        })
      }
      // A read cut short (more pages than the plugin goes through at once) keeps its last
      // read time, so the next read starts where this one did and nothing is skipped for good.
      out = { ...(await loadHealth()), readAt: res?.truncated ? h.readAt : now, readError: null }
    } catch (e) {
      out = { ...(await loadHealth()), readError: e?.code === 'permission' ? 'permission' : e?.code === 'unavailable' ? 'unavailable' : 'failed' }
    }
    await saveHealth(out)
    told(out)
    return { health: out, added, updated }
  })().finally(() => { reading = null })
  return reading
}

/**
 * Turning the read side on: asks for the read permission (on its own, apart from the write
 * ones), then reads once. Resolves with { ok, reason, health, added, updated } — reason
 * 'denied' when it was not granted, or the status when Health Connect is not there to ask.
 */
export async function enableHealthRead() {
  const p = await plugin()
  if (!p) return { ok: false, reason: 'unsupported' }
  const st = await p.HC.status().catch(() => ({ status: 'unsupported' }))
  if (st.status !== 'available') return { ok: false, reason: st.status }
  const granted = st.readGranted || (await p.HC.requestPermissions({ read: true }).catch(() => ({ granted: false }))).granted
  if (!granted) return { ok: false, reason: 'denied' }
  if (reading) await reading.catch(() => {})
  const on = { ...(await loadHealth()), readOn: true, readError: null }
  await saveHealth(on)
  told(on)
  const r = await importHealth()
  const health = r?.health || on
  return { ok: !health.readError, reason: health.readError || null, health, added: r?.added || 0, updated: r?.updated || 0 }
}

/**
 * Turning the read side off. What was imported stays in the log: those are the user's weigh-ins
 * now. Turned on again, it reads the last year once more; a day the user removed meanwhile
 * stays removed (lib/health-import.js).
 */
export async function disableHealthRead() {
  if (reading) await reading.catch(() => {})
  const out = { ...(await loadHealth()), readOn: false, readAt: 0, readError: null }
  await saveHealth(out)
  told(out)
  return out
}

// Back in the foreground: a change synced from another device while the phone was away, or a
// permission the user granted again in Health Connect's own settings, is picked up then; so are
// the weigh-ins other apps saved meanwhile.
let started = false
/**
 * `getState` returns the store's S; `apply` is the store's update (it takes a function that
 * changes a copy of S), the path the read side takes weigh-ins in through.
 */
export function initHealthSync(getState, apply) {
  if (!MOBILE || started) return
  started = true
  store = typeof apply === 'function' ? { get: getState, apply } : null
  const both = () => { syncHealth(getState()).catch(() => {}); importHealth().catch(() => {}) }
  import('@capacitor/app').then(({ App }) => {
    App.addListener('appStateChange', ({ isActive }) => { if (isActive) both() })
  }).catch(() => {})
  // Once at launch, for a workout finished or a weigh-in saved just before the app was closed.
  // Reading the file here also settles whether it is on, which the saves wait for (syncHealth).
  setTimeout(() => loadHealth().then(both).catch(() => {}), 3000)
}
