import type { Engine, Pt, WorldObject } from '@kimetron/core'

/**
 * game spike: two units wandering a building.
 * walls = solid rects; rocks = locked solid polygons; the gate is a
 * door zone units may overlap (the only way out); units are solid so
 * they can't share space. Movement goes through engine.tryMove, so
 * the collision policy applies to programmatic motion too.
 */

export interface UnitData {
  name: string
  color: string
}

export const UNIT_IDS = ['uA', 'uB']
export const UNIT_SIZE = 300 // 30 cm
export const UNIT_RANGE = 250 // adjacency reach, world mm

const GROUND_FILL = '#e9efe4'
const WALL_FILL = '#44403a'
const WALL_STROKE = '#2e2a26'
const ROCK_FILL = '#9aa4ad'
const ROCK_STROKE = '#5f6b78'

function wall(id: string, x: number, y: number, w: number, h: number): WorldObject {
  return {
    id, kind: 'wall', x, y, w, h,
    solid: true, layer: 10,
    style: { fill: WALL_FILL, stroke: WALL_STROKE },
  }
}

function unit(id: string, x: number, y: number, name: string, color: string): WorldObject {
  return {
    id, kind: 'unit', x, y, w: UNIT_SIZE, h: UNIT_SIZE,
    solid: true, layer: 5,
    data: { name, color } satisfies UnitData,
  }
}

export function sampleObjects(): WorldObject[] {
  return [
    {
      id: 'site', kind: 'site', x: 0, y: 0, w: 4400, h: 3400,
      layer: -10, style: { fill: GROUND_FILL, stroke: '#c8cfae' },
    },
    // south wall split around an 800 mm opening — the gate zone
    wall('wS1', 200, 200, 1200, 120),
    wall('wS2', 2200, 200, 2000, 120),
    {
      id: 'gate', kind: 'door', x: 1400, y: 200, w: 800, h: 120,
      solid: true, layer: 11,
      style: { fill: '#d8e6c8', stroke: '#8a9a6c' },
    },
    wall('wN', 200, 3080, 4000, 120),
    wall('wW', 200, 320, 120, 2760),
    wall('wE', 4080, 320, 120, 2760),
    wall('wP', 2400, 320, 120, 1500), // partition
    // rocks — locked solid polygons (impassable, indestructible)
    {
      id: 'rock1', kind: 'polygon', x: 2900, y: 1800, w: 800, h: 700,
      solid: true, locked: true, layer: 9,
      shape: {
        points: [
          { fx: 0, fy: 0 }, { fx: 0.6, fy: 0 }, { fx: 0.6, fy: 0.4 },
          { fx: 1, fy: 0.4 }, { fx: 1, fy: 1 }, { fx: 0, fy: 1 },
        ],
      },
      style: { fill: ROCK_FILL, stroke: ROCK_STROKE },
    },
    {
      id: 'rock2', kind: 'polygon', x: 700, y: 1500, w: 600, h: 500,
      solid: true, locked: true, layer: 9,
      shape: {
        points: [
          { fx: 0.5, fy: 0 }, { fx: 1, fy: 0.4 }, { fx: 0.85, fy: 1 },
          { fx: 0.15, fy: 1 }, { fx: 0, fy: 0.4 },
        ],
      },
      style: { fill: ROCK_FILL, stroke: ROCK_STROKE },
    },
    // pond — non-solid area rendered with an SVG pattern (driver-side)
    { id: 'pond', kind: 'pond', x: 2700, y: 900, w: 900, h: 500, layer: -5 },
    unit('uA', 600, 600, 'A', '#3a7bd5'),
    unit('uB', 3300, 2620, 'B', '#d97706'),
  ]
}

/** Units may pass through the door zone; doors may sit on walls. */
export function canOverlap(a: WorldObject, b: WorldObject): boolean {
  const k = [a.kind, b.kind].sort()
  return k[0] === 'door' && (k[1] === 'unit' || k[1] === 'wall')
}

/** Inner envelope of the outer walls (inside faces). */
const INNER = { x: 320, y: 320, w: 3760, h: 2760 }
const GATE_CENTER: Pt = { x: 1800, y: 260 }

/** Random wander target inside the inner envelope. */
export function pickWaypoint(): Pt {
  return {
    x: 420 + Math.random() * 3500,
    y: 420 + Math.random() * 2500,
  }
}

/** A unit outside the building heads for the gate to re-enter;
    every other waypoint is beyond a wall, which is why it otherwise
    presses against the wall forever. */
function targetFor(c: Pt, wp: Pt | undefined): Pt {
  const outside =
    c.x < INNER.x || c.x > INNER.x + INNER.w || c.y < INNER.y || c.y > INNER.y + INNER.h
  if (outside) return GATE_CENTER
  if (!wp || Math.hypot(wp.x - c.x, wp.y - c.y) < ARRIVE) return pickWaypoint()
  return wp
}

const STEP = 60 // mm per tick — thinner than the 120 mm walls, no tunneling
const ARRIVE = 150
const STUCK_TICKS = 12
const MIN_MOVE = 20 // mm per tick — below this the unit counts as stuck

export interface WanderState {
  wp?: Pt
  still: number
}

/** One wander tick: every unit steps toward its waypoint via tryMove,
    sliding along blocked axes. Stuck is judged on ACTUAL displacement —
    a unit creeping at <20mm/tick in a local minimum (e.g. pressed within
    one STEP of a wall face) gets a fresh waypoint after STUCK_TICKS. */
export function stepUnits(engine: Engine, st: Record<string, WanderState>): void {
  for (const id of UNIT_IDS) {
    const o = engine.doc.objects.find((o) => o.id === id)
    if (!o) continue
    const s = (st[id] ??= { still: 0 })
    const c = { x: o.x + o.w / 2, y: o.y + o.h / 2 }
    const wp = (s.wp = targetFor(c, s.wp))
    const dx = wp.x - c.x
    const dy = wp.y - c.y
    const d = Math.hypot(dx, dy) || 1
    const mx = (dx / d) * STEP
    const my = (dy / d) * STEP
    engine.tryMove(id, mx, my) || engine.tryMove(id, mx, 0) || engine.tryMove(id, 0, my)
    const moved = engine.doc.objects.find((o) => o.id === id)
    const dist = moved ? Math.hypot(moved.x - o.x, moved.y - o.y) : 0
    s.still = dist < MIN_MOVE ? s.still + 1 : 0
    if (s.still >= STUCK_TICKS) {
      s.wp = pickWaypoint()
      s.still = 0
    }
  }
}

/** Units adjacent to `o` within UNIT_RANGE of its footprint. */
export function adjacent(engine: Engine, o: WorldObject): WorldObject[] {
  const range = {
    x: o.x - UNIT_RANGE,
    y: o.y - UNIT_RANGE,
    w: o.w + UNIT_RANGE * 2,
    h: o.h + UNIT_RANGE * 2,
  }
  return engine
    .objectsIn(range, new Set([o.id]))
    .filter((t) => UNIT_IDS.includes(t.id))
}

export const GRID_CFG = { size: 10, snap: true, major: 10 }
