import { describe, expect, it } from 'vitest'
import { FIRST_READ_DAYS, OVERLAP_DAYS, isImported, isOwnRecord, mergeImportedWeights, readSince } from './health-import.js'
import { healthRecords } from './health-connect.js'

// #544: weigh-ins other apps saved to Health Connect, taken into the body weight log.
const DAY = 86400000
const at = (d, hh, mm = 0) => new Date(2026, 8, d, hh, mm).getTime()
const rec = (d, hh, kg, extra = {}) => ({ id: `r-${d}-${hh}`, time: at(d, hh), kg, origin: 'com.sec.android.app.shealth', ...extra })

describe('readSince', () => {
  it('reaches back a year on the first read', () => {
    const now = at(20, 9)
    expect(readSince(0, now)).toBe(now - FIRST_READ_DAYS * DAY)
    expect(readSince(undefined, now)).toBe(now - FIRST_READ_DAYS * DAY)
  })
  it('starts a little before the last read after that, for readings synced in late', () => {
    expect(readSince(at(20, 9), at(21, 9))).toBe(at(20, 9) - OVERLAP_DAYS * DAY)
  })
})

describe('isOwnRecord', () => {
  it('knows openGym’s records by their client record id or by the app they came from', () => {
    expect(isOwnRecord({ clientRecordId: 'opengym-bw-2026-09-17' })).toBe(true)
    expect(isOwnRecord({ origin: 'ch.duartesantos.opengym' }, 'ch.duartesantos.opengym')).toBe(true)
    expect(isOwnRecord({ origin: 'com.sec.android.app.shealth', clientRecordId: 'abc' }, 'ch.duartesantos.opengym')).toBe(false)
    expect(isOwnRecord({ origin: 'com.sec.android.app.shealth' })).toBe(false)
  })
})

describe('mergeImportedWeights', () => {
  it('adds one weigh-in per day, the earliest reading, marked as imported', () => {
    const r = mergeImportedWeights([], [rec(17, 19, 81.2), rec(17, 7, 80.4), rec(18, 7, 80.1)])
    expect(r.added).toBe(2)
    expect(r.bodyweight).toEqual([
      { d: '2026-09-17', w: 80.4, t: at(17, 7), src: 'hc' },
      { d: '2026-09-18', w: 80.1, t: at(18, 7), src: 'hc' },
    ])
    expect(r.bodyweight.every(isImported)).toBe(true)
  })

  it('never replaces a weigh-in typed in openGym', () => {
    const typed = [{ d: '2026-09-17', w: 82, t: at(17, 21) }]
    const r = mergeImportedWeights(typed, [rec(17, 7, 80.4)])
    expect(r).toEqual({ bodyweight: typed, added: 0, updated: 0 })
  })

  it('moves an imported day to an earlier reading, or to a corrected one at the same time', () => {
    const had = [{ d: '2026-09-17', w: 81.2, t: at(17, 19), src: 'hc' }]
    const earlier = mergeImportedWeights(had, [rec(17, 7, 80.4)])
    expect(earlier.updated).toBe(1)
    expect(earlier.bodyweight).toEqual([{ d: '2026-09-17', w: 80.4, t: at(17, 7), src: 'hc' }])
    expect(had[0].w).toBe(81.2)   // pure: the input is not changed

    const later = mergeImportedWeights(earlier.bodyweight, [rec(17, 19, 81.2)])
    expect(later.updated).toBe(0)
    expect(later.bodyweight).toBe(earlier.bodyweight)

    const corrected = mergeImportedWeights(earlier.bodyweight, [rec(17, 7, 80.6)])
    expect(corrected.bodyweight[0].w).toBe(80.6)
  })

  it('does not bring back a day the user removed in openGym', () => {
    const r = mergeImportedWeights([], [rec(17, 7, 80.4), rec(18, 7, 80.1)], { deleted: { '2026-09-17': at(19, 10) } })
    expect(r.bodyweight.map(b => b.d)).toEqual(['2026-09-18'])
  })

  it('never imports a record openGym wrote itself (no loop through the write side)', () => {
    const r = mergeImportedWeights([], [
      rec(17, 8, 80, { clientRecordId: 'opengym-bw-2026-09-17' }),
      rec(18, 8, 80, { origin: 'ch.duartesantos.opengym' }),
      rec(19, 8, 79.8),
    ], { ownPackage: 'ch.duartesantos.opengym' })
    expect(r.bodyweight.map(b => b.d)).toEqual(['2026-09-19'])
  })

  it('and the write side does not write an imported weigh-in back', () => {
    const S = { unit: 'kg', workouts: [], bodyweight: [
      { d: '2026-09-17', w: 80.4, t: at(17, 7), src: 'hc' },
      { d: '2026-09-18', w: 80.1, t: at(18, 7) },
    ] }
    expect(healthRecords(S, { nameOf: e => e.id }).weights.map(w => w.id)).toEqual(['opengym-bw-2026-09-18'])
  })

  it('keeps to the window it was asked for', () => {
    const r = mergeImportedWeights([], [rec(10, 7, 81), rec(17, 7, 80.4)], { since: at(15, 0) })
    expect(r.bodyweight.map(b => b.d)).toEqual(['2026-09-17'])
  })

  it('writes the weight in the profile’s unit', () => {
    const r = mergeImportedWeights([], [rec(17, 7, 80)], { unit: 'lb' })
    expect(r.bodyweight[0].w).toBe(176.4)
  })

  it('keeps the log in day order among weigh-ins already there', () => {
    const had = [{ d: '2026-09-16', w: 81, t: at(16, 7) }, { d: '2026-09-19', w: 80, t: at(19, 7) }]
    const r = mergeImportedWeights(had, [rec(17, 7, 80.4)])
    expect(r.bodyweight.map(b => b.d)).toEqual(['2026-09-16', '2026-09-17', '2026-09-19'])
  })

  it('changes nothing for empty, missing or unusable input', () => {
    const had = [{ d: '2026-09-16', w: 81, t: at(16, 7) }]
    expect(mergeImportedWeights(had, [])).toEqual({ bodyweight: had, added: 0, updated: 0 })
    expect(mergeImportedWeights(had, null).bodyweight).toBe(had)
    expect(mergeImportedWeights(undefined, undefined)).toEqual({ bodyweight: [], added: 0, updated: 0 })
    expect(mergeImportedWeights(had, [{ time: 0, kg: 80 }, { time: at(17, 7), kg: 0 }, { time: at(17, 7) }]).bodyweight).toBe(had)
  })
})
