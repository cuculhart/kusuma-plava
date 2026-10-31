import { describe, expect, it } from 'vitest'
import { Engine } from '@kimetron/core'
import { GRID_CFG, canOverlap, sampleObjects, stepUnits } from './model'
import type { WanderState } from './model'

function makeEngine() {
  const e = new Engine(
    { units: 'mm', origin: 'top-left', grid: GRID_CFG },
    sampleObjects(),
  )
  e.collisionMode = 'reject'
  e.canOverlap = canOverlap
  return e
}

describe('wander simulation', () => {
  it('spawns are legal — no unit starts inside a solid', () => {
    const e = makeEngine()
    for (const o of e.doc.objects.filter((o) => o.kind === 'unit')) {
      expect(e.canPlace(o)).toBe(true)
    }
  })

  it('both units keep moving over 400 ticks', () => {
    const e = makeEngine()
    const st: Record<string, WanderState> = {}
    const start: Record<string, { x: number; y: number }> = {}
    let maxStill = 0
    let still = 0
    const seen: Record<string, number> = {}
    for (let i = 0; i < 400; i++) {
      const before = new Map(
        e.doc.objects.filter((o) => o.kind === 'unit').map((o) => [o.id, { x: o.x, y: o.y }]),
      )
      for (const [id, p] of before) start[id] ??= p
      stepUnits(e, st)
      let tickMoved = false
      for (const o of e.doc.objects.filter((o) => o.kind === 'unit')) {
        const d = Math.hypot(o.x - before.get(o.id)!.x, o.y - before.get(o.id)!.y)
        seen[o.id] = (seen[o.id] ?? 0) + d
        if (d >= 20) tickMoved = true
      }
      if (tickMoved) still = 0
      else {
        still++
        maxStill = Math.max(maxStill, still)
      }
    }
    // every unit covers real ground — nobody is glued at spawn
    for (const id of Object.keys(start)) {
      expect(seen[id]).toBeGreaterThan(1000)
    }
    // no dead run of 40 ticks (a stuck unit repicks within 12)
    expect(maxStill).toBeLessThan(40)
  })
})
