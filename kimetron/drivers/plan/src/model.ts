import { aabbOf, obbOf, rectOverlapArea, type WorldObject } from '@kimetron/core'

/**
 * plan spike: a 10 mm-grid floor plan.
 * floor < furniture < walls via `layer`; occupancy via `solid`.
 * Walls are "thickness × length" rects — abutting edges is legal,
 * overlapping is not (collisionMode = 'reject').
 */

export interface ItemData {
  label?: string
}

const FLOOR_FILL = '#f7f3ea'
const WALL_FILL = '#44403a'
const WALL_STROKE = '#2e2a26'
const FURN_FILL = '#dccfb4'
const FURN_STROKE = '#8a7a5c'

export interface WallData {
  /** Perimeter wall — part of the building envelope (drives area calcs). */
  perimeter?: boolean
}

function wall(
  id: string, x: number, y: number, w: number, h: number,
  perimeter = false,
  rot?: number,
): WorldObject {
  return {
    id, kind: 'wall', x, y, w, h,
    ...(rot ? { rot } : {}),
    solid: true, layer: 10,
    style: { fill: WALL_FILL, stroke: WALL_STROKE },
    data: { perimeter } satisfies WallData,
  }
}

function furniture(id: string, x: number, y: number, w: number, h: number, label: string, rot?: number): WorldObject {
  return {
    id, kind: 'furniture', x, y, w, h,
    ...(rot ? { rot } : {}),
    solid: true, layer: 0,
    style: { fill: FURN_FILL, stroke: FURN_STROKE },
    data: { label } satisfies ItemData,
  }
}

export function sampleDoc(): { objects: WorldObject[] } {
  return {
    objects: [
      // site boundary — non-solid, everything may sit on it
      {
        id: 'site', kind: 'site', x: 0, y: 0, w: 4400, h: 3400,
        layer: -10,
        style: { fill: FLOOR_FILL, stroke: '#c8bfae' },
        data: { label: '敷地' } satisfies ItemData,
      },
      // outer walls (120 mm thick) — corner cells belong to the horizontal walls
      wall('wS', 200, 200, 4000, 120, true),
      wall('wN', 200, 3080, 4000, 120, true),
      wall('wW', 200, 320, 120, 2760, true),
      wall('wE', 4080, 320, 120, 2760, true),
      // "|-" T junctions: end edges abut face edges
      wall('wP1', 2400, 320, 120, 1500), // rises from wS's top face
      wall('wP2', 2520, 1500, 800, 120), // leaves wP1's right face
      // 45° diagonal partition (non-perimeter): OBB collision applies
      wall('wD', 3100, 2100, 120, 900, false, 45),
      // door: solid (a doorway is occupied space) but may overlap walls
      {
        id: 'door1', kind: 'door', x: 800, y: 200, w: 800, h: 120,
        solid: true, layer: 11,
        style: { fill: '#fff', stroke: '#b0a48c' },
        data: { label: '開口' } satisfies ItemData,
      },
      // door swing — a quarter arc, radius = leaf length
      {
        id: 'swing1', kind: 'arc', x: 800, y: -480, w: 1600, h: 1600,
        shape: { a0: 90, a1: 180 },
        style: { stroke: '#8a7a5c', width: 1.5, dash: [4, 3] },
        data: {},
      },
      furniture('fDesk', 500, 500, 900, 500, '机'),
      furniture('fChair', 1500, 550, 450, 450, '椅子', -25), // rotated placement
      furniture('fShelf', 2700, 400, 1400, 350, '棚'),
      furniture('fSofa', 600, 2200, 1800, 850, 'ソファ'),
      // compass — a real rotated object (grab its rotate handle to spin)
      {
        id: 'north', kind: 'compass', x: 3950, y: 300, w: 300, h: 300,
        rot: -20, layer: 12,
        style: { stroke: '#4a5568' },
        data: { label: 'N' } satisfies ItemData,
      },
      // room-width dimension resting on the outer wall faces
      {
        id: 'dimRoom', kind: 'dim', x: 200, y: 60, w: 4000, h: 140,
        layer: 12, data: { axis: 'x' } satisfies DimData,
      },
    ],
  }
}

/** The overlap matrix: doors may sit on walls (and walls on doors —
    dragging the wall must not be blocked by its door). */
export function canOverlap(a: WorldObject, b: WorldObject): boolean {
  const kinds = [a.kind, b.kind].sort()
  return kinds[0] === 'door' && kinds[1] === 'wall'
}

/** Architectural areas (mm²) derived from the wall layout.
    Perimeter walls form the building envelope; interior partitions
    subtract from the floor areas. Conventions:
    - site     = the 'site' object bbox (敷地面積)
    - building = envelope of perimeter walls' outer faces (建築面積)
    - core     = area bounded by perimeter wall core lines (床面積・壁芯)
    - inner    = area bounded by perimeter walls' inner faces (床面積・内法)
    - wallNet  = Σ wall footprints − door openings (壁面積・開口部除去) */
export function areas(objects: WorldObject[]): {
  site: number
  building: number
  core: number
  inner: number
  wallGross: number
  openings: number
} {
  const siteObj = objects.find((o) => o.kind === 'site')
  const site = siteObj ? siteObj.w * siteObj.h : 0
  const walls = objects.filter((o) => o.kind === 'wall')
  const doors = objects.filter((o) => o.kind === 'door')
  const wallGross = walls.reduce((s, w) => s + w.w * w.h, 0)
  const openings = doors.reduce(
    (s, d) => s + walls.reduce((t, w) => t + rectOverlapArea(w, d), 0),
    0,
  )
  const ext = walls.filter((w) => (w.data as WallData | undefined)?.perimeter)
  if (ext.length === 0) return { site, building: 0, core: 0, inner: 0, wallGross, openings }

  const bx0 = Math.min(...ext.map((w) => w.x))
  const bx1 = Math.max(...ext.map((w) => w.x + w.w))
  const by0 = Math.min(...ext.map((w) => w.y))
  const by1 = Math.max(...ext.map((w) => w.y + w.h))
  const cx = (bx0 + bx1) / 2
  const cy = (by0 + by1) / 2

  // classify perimeter walls by side; vertical walls bound left/right
  const vert = ext.filter((w) => w.h >= w.w)
  const horz = ext.filter((w) => w.h < w.w)
  const leftW = vert.filter((w) => w.x + w.w / 2 < cx)
  const rightW = vert.filter((w) => w.x + w.w / 2 > cx)
  const topW = horz.filter((w) => w.y + w.h / 2 < cy)
  const botW = horz.filter((w) => w.y + w.h / 2 > cy)
  const innermost = (ws: WorldObject[], edge: (w: WorldObject) => number, pick: (...v: number[]) => number) =>
    ws.length ? pick(...ws.map(edge)) : NaN

  const coreX0 = innermost(leftW, (w) => w.x + w.w / 2, Math.max)
  const coreX1 = innermost(rightW, (w) => w.x + w.w / 2, Math.min)
  const coreY0 = innermost(topW, (w) => w.y + w.h / 2, Math.max)
  const coreY1 = innermost(botW, (w) => w.y + w.h / 2, Math.min)
  const inX0 = innermost(leftW, (w) => w.x + w.w, Math.max)
  const inX1 = innermost(rightW, (w) => w.x, Math.min)
  const inY0 = innermost(topW, (w) => w.y + w.h, Math.max)
  const inY1 = innermost(botW, (w) => w.y, Math.min)

  const coreRect = { x: coreX0, y: coreY0, w: coreX1 - coreX0, h: coreY1 - coreY0 }
  const innerRect = { x: inX0, y: inY0, w: inX1 - inX0, h: inY1 - inY0 }
  // interior partitions eat floor area
  const part = walls.filter((w) => !(w.data as WallData | undefined)?.perimeter)
  // rotated partitions contribute their OBB's axis-aligned bounds
  const partCore = part.reduce((s, w) => s + rectOverlapArea(coreRect, aabbOf(obbOf(w))), 0)
  const partInner = part.reduce((s, w) => s + rectOverlapArea(innerRect, aabbOf(obbOf(w))), 0)

  return {
    site,
    building: (bx1 - bx0) * (by1 - by0),
    core: Math.max(0, coreRect.w * coreRect.h - partCore),
    inner: Math.max(0, innerRect.w * innerRect.h - partInner),
    wallGross,
    openings,
  }
}

export interface DimData {
  /** 'x' = the bbox `w` is the measured span; 'y' = `h`. */
  axis?: 'x' | 'y'
}

let dn = 0

/** A dimension object spanning `b` (or a default 1000 mm span). */
export function spawnDim(
  axis: 'x' | 'y',
  b: { x: number; y: number; w: number; h: number } | null,
): WorldObject {
  dn += 1
  const GAP = 350
  if (axis === 'x') {
    return {
      id: `dim${dn}`, kind: 'dim',
      x: b ? b.x : 600, y: (b ? b.y : 600) - GAP,
      w: b ? b.w : 1000, h: 300,
      layer: 12, data: { axis: 'x' } satisfies DimData,
    }
  }
  return {
    id: `dim${dn}`, kind: 'dim',
    x: (b ? b.x + b.w : 1600) + GAP, y: b ? b.y : 600,
    w: 300, h: b ? b.h : 1000,
    layer: 12, data: { axis: 'y' } satisfies DimData,
  }
}

export const FURNITURE: Record<string, { w: number; h: number; label: string }> = {
  desk: { w: 900, h: 500, label: '机' },
  chair: { w: 450, h: 450, label: '椅子' },
  shelf: { w: 1400, h: 350, label: '棚' },
  table: { w: 1000, h: 1000, label: 'テーブル' },
}

let n = 0
let wn = 0

export function spawn(kind: string): WorldObject {
  const t = FURNITURE[kind] ?? { w: 500, h: 500, label: kind }
  n += 1
  return furniture(
    `f${kind}-${n}`,
    500 + (n % 5) * 150,
    500 + (n % 3) * 150,
    t.w,
    t.h,
    t.label,
  )
}

/** A diagonal partition wall for trying rotated placement. */
export function spawnWall(): WorldObject {
  wn += 1
  return wall(`wD-${wn}`, 3000 + wn * 60, 2100, 120, 900, false, 45)
}

export const GRID_CFG = { size: 10, snap: true, major: 10 }
