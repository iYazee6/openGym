import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #200: the Android app keeping Health Connect in step with the log. The native plugin
// (HealthConnectPlugin.java) and the app's data directory are played in memory.
const h = vi.hoisted(() => {
  vi.stubEnv('VITE_MOBILE', '1')
  return { files: new Map(), calls: [], status: { status: 'available', granted: false }, grant: true, fail: null, records: [], readFail: null }
})

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    readFile: async ({ path }) => {
      if (!h.files.has(path)) throw new Error('File does not exist')
      return { data: h.files.get(path) }
    },
    writeFile: async ({ path, data }) => { h.files.set(path, data) },
  },
}))
vi.mock('@capacitor/app', () => ({ App: { addListener: () => ({ remove() {} }) } }))
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'android' },
  registerPlugin: () => ({
    status: async () => ({ ...h.status }),
    requestPermissions: async arg => {
      if (arg?.read) { h.calls.push(['request', arg]); h.status.readGranted = h.grant; return { granted: h.grant } }
      h.calls.push(['request']); h.status.granted = h.grant; return { granted: h.grant }
    },
    readWeights: async arg => {
      h.calls.push(['read', arg])
      if (h.readFail) throw Object.assign(new Error('refused'), { code: h.readFail })
      return { records: h.records, own: 'ch.duartesantos.opengym' }
    },
    write: async arg => {
      h.calls.push(['write', arg])
      if (h.fail) throw Object.assign(new Error('refused'), { code: h.fail })
    },
    remove: async arg => { h.calls.push(['remove', arg]) },
    openSettings: async () => {},
  }),
}))

const at = (d, hh) => new Date(2026, 8, d, hh).getTime()
const workout = (id, d) => ({ id, d: `2026-09-${d}`, start: at(d, 18), end: at(d, 19), name: 'Push',
  entries: [{ id: '0025', target: { mode: 'reps' }, sets: [{ w: 60, r: 8, done: true }] }] })
const state = (workouts, bodyweight = []) => ({ unit: 'kg', workouts, bodyweight })
const writes = () => h.calls.filter(c => c[0] === 'write').map(c => c[1])
const removes = () => h.calls.filter(c => c[0] === 'remove').map(c => c[1])
const file = () => JSON.parse(h.files.get('opengym-health.json') || 'null')

let hs
beforeEach(async () => {
  vi.resetModules()
  h.files.clear(); h.calls = []; h.status = { status: 'available', granted: false }; h.grant = true; h.fail = null
  h.records = []; h.readFail = null
  hs = await import('./health-sync.js')
})

describe('off (the default)', () => {
  it('writes nothing and asks for nothing, even after the file is read', async () => {
    await hs.loadHealth()
    await hs.syncHealth(state([workout('w1', 17)]))
    expect(h.calls).toEqual([])
    expect(h.files.has('opengym-health.json')).toBe(false)
  })
})

describe('turning it on', () => {
  it('asks for the permissions, then writes the whole log once', async () => {
    const r = await hs.enableHealth(state([workout('w1', 17)], [{ d: '2026-09-17', w: 80, t: at(17, 7) }]))
    expect(r.ok).toBe(true)
    expect(h.calls[0]).toEqual(['request'])
    expect(writes()).toHaveLength(1)
    expect(writes()[0].sessions.map(s => s.id)).toEqual(['opengym-w-w1'])
    expect(writes()[0].weights.map(s => s.id)).toEqual(['opengym-bw-2026-09-17'])
    expect(file().on).toBe(true)
    expect(Object.keys(file().written)).toEqual(['opengym-w-w1', 'opengym-bw-2026-09-17'])
  })
  it('stays off when the permissions are not granted', async () => {
    h.grant = false
    const r = await hs.enableHealth(state([workout('w1', 17)]))
    expect(r).toEqual({ ok: false, reason: 'denied' })
    expect(writes()).toEqual([])
    expect(file()).toBeNull()
  })
  it('does not ask again when they were granted before', async () => {
    h.status.granted = true
    await hs.enableHealth(state([]))
    expect(h.calls.find(c => c[0] === 'request')).toBeUndefined()
  })
  it('says so when Health Connect is not there', async () => {
    h.status = { status: 'missing', granted: false }
    expect(await hs.enableHealth(state([]))).toEqual({ ok: false, reason: 'missing' })
  })
})

describe('keeping in step', () => {
  it('writes only what is new, and removes what was deleted', async () => {
    await hs.enableHealth(state([workout('w1', 17)]))
    h.calls = []
    await hs.syncHealth(state([workout('w1', 17)]))
    expect(h.calls).toEqual([])

    await hs.syncHealth(state([workout('w1', 17), workout('w2', 18)]))
    expect(writes().map(w => w.sessions.map(s => s.id))).toEqual([['opengym-w-w2']])

    h.calls = []
    await hs.syncHealth(state([workout('w2', 18)]))
    expect(writes()).toEqual([])
    expect(removes()).toEqual([{ sessions: ['opengym-w-w1'], weights: [] }])
    expect(Object.keys(file().written)).toEqual(['opengym-w-w2'])
  })
  it('remembers a refused permission, keeps what it has, and clears it once allowed again', async () => {
    await hs.enableHealth(state([workout('w1', 17)]))
    h.fail = 'permission'
    await hs.syncHealth(state([workout('w1', 17), workout('w2', 18)]))
    expect(file().error).toBe('permission')
    expect(Object.keys(file().written)).toEqual(['opengym-w-w1'])

    h.fail = null
    await hs.syncHealth(state([workout('w1', 17), workout('w2', 18)]))
    expect(file().error).toBeNull()
    expect(Object.keys(file().written)).toEqual(['opengym-w-w1', 'opengym-w-w2'])
  })
  it('runs one sync at a time and follows it with the newest state', async () => {
    await hs.enableHealth(state([]))
    h.calls = []
    const a = hs.syncHealth(state([workout('w1', 17)]))
    const b = hs.syncHealth(state([workout('w1', 17), workout('w2', 18)]))
    const c = hs.syncHealth(state([workout('w1', 17), workout('w2', 18), workout('w3', 19)]))
    await Promise.all([a, b, c])
    // The second call is overtaken by the third before it runs: two writes, not three.
    expect(writes().map(w => w.sessions.map(s => s.id))).toEqual([['opengym-w-w1'], ['opengym-w-w2', 'opengym-w-w3']])
  })
})

describe('turning it off', () => {
  it('can leave what it wrote in Health Connect', async () => {
    await hs.enableHealth(state([workout('w1', 17)]))
    h.calls = []
    await hs.disableHealth({ removeWritten: false })
    expect(removes()).toEqual([])
    expect(file().on).toBe(false)
    await hs.syncHealth(state([workout('w1', 17), workout('w2', 18)]))
    expect(writes()).toEqual([])
  })
  it('or remove exactly what it wrote', async () => {
    await hs.enableHealth(state([workout('w1', 17)], [{ d: '2026-09-17', w: 80, t: at(17, 7) }]))
    await hs.disableHealth({ removeWritten: true })
    expect(removes()).toEqual([{ sessions: ['opengym-w-w1'], weights: ['opengym-bw-2026-09-17'] }])
    expect(file()).toMatchObject({ on: false, written: {} })
  })
})

// #544: the read side. A store played in memory: its state, and an update that changes a copy.
describe('reading weigh-ins', () => {
  let S
  const reads = () => h.calls.filter(c => c[0] === 'read').map(c => c[1])
  const startStore = initial => {
    S = initial
    hs.initHealthSync(() => S, mut => { const next = structuredClone(S); mut(next); S = next })
  }
  const rec = (d, hh, kg, extra = {}) => ({ id: `r${d}${hh}`, time: at(d, hh), kg, origin: 'com.sec.android.app.shealth', ...extra })
  // The clock stands on the 20th, so the weigh-ins of the days before are inside every window.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] }); vi.setSystemTime(at(20, 9)) })
  afterEach(() => { vi.useRealTimers() })

  it('is off by default: nothing is read and nothing is asked', async () => {
    startStore(state([]))
    expect(await hs.importHealth()).toMatchObject({ added: 0 })
    expect(h.calls).toEqual([])
  })

  it('turning it on asks for the read permission alone, then reads the last year into the log', async () => {
    startStore(state([], [{ d: '2026-09-18', w: 82, t: at(18, 21) }]))
    h.records = [rec(17, 19, 81.2), rec(17, 7, 80.4), rec(18, 7, 80.1)]
    const before = Date.now()
    const r = await hs.enableHealthRead()
    expect(r).toMatchObject({ ok: true, added: 1 })
    expect(h.calls[0]).toEqual(['request', { read: true }])
    const since = reads()[0].since
    expect(since).toBeLessThanOrEqual(before - 365 * 86400000 + 1000)
    expect(since).toBeGreaterThan(before - 366 * 86400000)
    // The earliest reading of the 17th; the 18th was typed in openGym and stays as it is.
    expect(S.bodyweight).toEqual([
      { d: '2026-09-17', w: 80.4, t: at(17, 7), src: 'hc' },
      { d: '2026-09-18', w: 82, t: at(18, 21) },
    ])
    expect(file()).toMatchObject({ readOn: true, readError: null, on: false })
    expect(file().readAt).toBeGreaterThanOrEqual(before)
  })

  it('stays off when the read permission is not granted', async () => {
    startStore(state([]))
    h.grant = false
    expect(await hs.enableHealthRead()).toEqual({ ok: false, reason: 'denied' })
    expect(reads()).toEqual([])
    expect(file()).toBeNull()
  })

  it('reads again from a little before the last read, and adds only what is new', async () => {
    startStore(state([]))
    h.records = [rec(17, 7, 80.4)]
    await hs.enableHealthRead()
    const readAt = file().readAt
    h.records = [rec(17, 7, 80.4), rec(18, 7, 80.1)]
    const r = await hs.importHealth()
    expect(r).toMatchObject({ added: 1, updated: 0 })
    expect(reads()[1].since).toBe(readAt - 7 * 86400000)
    expect(S.bodyweight.map(b => b.d)).toEqual(['2026-09-17', '2026-09-18'])
  })

  it('never takes in what openGym wrote, and the write side does not write imports back', async () => {
    startStore(state([], [{ d: '2026-09-16', w: 81, t: at(16, 7) }]))
    await hs.enableHealth(S)
    h.records = [
      rec(16, 7, 81, { origin: 'ch.duartesantos.opengym', clientRecordId: 'opengym-bw-2026-09-16' }),
      rec(17, 7, 80.4),
    ]
    await hs.enableHealthRead()
    expect(S.bodyweight.map(b => b.d)).toEqual(['2026-09-16', '2026-09-17'])
    h.calls = []
    await hs.syncHealth(S)
    expect(writes()).toEqual([])
    expect(Object.keys(file().written)).toEqual(['opengym-bw-2026-09-16'])
    expect(file()).toMatchObject({ on: true, readOn: true })
  })

  it('remembers a refused permission and keeps the last read time', async () => {
    startStore(state([]))
    await hs.enableHealthRead()
    const readAt = file().readAt
    h.readFail = 'permission'
    await hs.importHealth()
    expect(file()).toMatchObject({ readOn: true, readError: 'permission', readAt })
  })

  it('turning it off keeps what was imported and reads nothing more', async () => {
    startStore(state([]))
    h.records = [rec(17, 7, 80.4)]
    await hs.enableHealthRead()
    await hs.disableHealthRead()
    expect(file()).toMatchObject({ readOn: false, readAt: 0 })
    h.calls = []
    h.records = [rec(18, 7, 80.1)]
    await hs.importHealth()
    expect(reads()).toEqual([])
    expect(S.bodyweight.map(b => b.d)).toEqual(['2026-09-17'])
  })

  it('a write sync running alongside does not undo the read side’s state', async () => {
    startStore(state([workout('w1', 17)]))
    await hs.enableHealth(S)
    h.records = [rec(18, 7, 80.1)]
    await Promise.all([hs.syncHealth(state([workout('w1', 17), workout('w2', 18)])), hs.enableHealthRead()])
    expect(file()).toMatchObject({ on: true, readOn: true })
    expect(file().readAt).toBeGreaterThan(0)
  })
})
