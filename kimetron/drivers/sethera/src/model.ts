import { rectContains, type Edge, type Port, type Rect, type WorldObject } from '@kimetron/core'

/**
 * sethera-piece spike: a tiny estimate board.
 * pieces (text/number) + Σ zone + calc pieces wired by edges.
 */

export interface PieceData {
  label?: string
  value?: number | null
}

export interface ZoneData {
  fn: 'sum' | 'count'
  label?: string
}

export type CalcOp = 'add' | 'sub' | 'mul' | 'div'
export const OP_LABEL: Record<CalcOp, string> = {
  add: '＋', sub: '−', mul: '×', div: '÷',
}

export interface CalcData {
  op: CalcOp
  constA?: number | null
  constB?: number | null
}

export interface Meta {
  /** visual accent for the locked piece */
  locked?: boolean
}

export type AnyData = (PieceData | ZoneData | CalcData) & Meta

const GRID = 5

// ports — direction is a driver-level convention:
// values flow out of 'out'; calc inputs are 'a'/'b'
const OUT: Port[] = [{ id: 'out', fx: 1, fy: 0.5 }]
const CALC_PORTS: Port[] = [
  { id: 'a', fx: 0, fy: 0.3 },
  { id: 'b', fx: 0, fy: 0.7 },
  { id: 'out', fx: 1, fy: 0.5 },
]

const PIECE_FILL = '#fef3c7'
const ZONE_FILL = 'rgba(58, 123, 213, 0.07)'
const ZONE_STROKE = '#3a7bd5'
const CALC_FILL = '#eef2f7'
const LOCK_STROKE = '#d97706'

function piece(
  id: string, x: number, y: number, label: string, value: number | null,
  extra: Partial<WorldObject> & Meta = {},
): WorldObject {
  const { locked, ...fields } = extra
  return {
    id, kind: 'piece', x, y, w: 50, h: 15, ports: OUT.map((p) => ({ ...p })),
    style: {
      fill: PIECE_FILL,
      ...(locked ? { stroke: LOCK_STROKE } : {}),
    },
    ...(locked ? { locked: true } : {}),
    ...fields,
    data: { label, value },
  }
}

function zone(id: string, x: number, y: number, w: number, h: number, fn: ZoneData['fn'], label: string): WorldObject {
  return {
    id, kind: 'zone', x, y, w, h, ports: OUT.map((p) => ({ ...p })),
    style: { fill: ZONE_FILL, stroke: ZONE_STROKE },
    data: { fn, label },
  }
}

function calc(id: string, x: number, y: number, op: CalcOp, constB?: number): WorldObject {
  return {
    id, kind: 'calc', x, y, w: 34, h: 18, ports: CALC_PORTS.map((p) => ({ ...p })),
    style: { fill: CALC_FILL },
    data: { op, constB: constB ?? null } satisfies CalcData,
  }
}

/** A horizontal rule — a real 'line' kind (chord across the bbox). */
function rule(id: string, x: number, y: number, w: number): WorldObject {
  return {
    id, kind: 'line', x, y, w, h: 2,
    shape: { points: [{ fx: 0, fy: 0.5 }, { fx: 1, fy: 0.5 }] },
    style: { stroke: '#333', width: 1.5 },
    data: {},
  }
}

export function sampleDoc(): { objects: WorldObject[]; edges: Edge[]; page: Rect } {
  const page: Rect = { x: 10, y: 10, w: 470, h: 165 }
  const objects: WorldObject[] = [
    zone('z1', 15, 15, 100, 55, 'sum', 'Σ 小計'),
    piece('pA', 25, 25, '品A', 700),
    piece('pB', 25, 45, '品B', 500),
    piece('pShip', 25, 85, '送料', 800),
    calc('cAdd', 165, 45, 'add'),
    calc('cTax', 285, 45, 'mul', 1.1),
    piece('pNote', 25, 125, '備考: 要確認', null, { locked: true }),
    rule('r1', 15, 150, 100),
    // shape gallery — the point of this spike (P24)
    {
      id: 'lArrow', kind: 'line', x: 165, y: 140, w: 60, h: 20,
      shape: { points: [{ fx: 0, fy: 0 }, { fx: 1, fy: 1 }] },
      style: { stroke: '#b45309', width: 2.5, dash: [6, 3], capEnd: 'arrow' },
      data: {},
    },
    {
      id: 'e1', kind: 'ellipse', x: 255, y: 135, w: 40, h: 25,
      style: { stroke: '#3a7bd5', width: 2 },
      data: {},
    },
    {
      id: 'a1', kind: 'arc', x: 320, y: 135, w: 40, h: 40,
      shape: { a0: 0, a1: 270 },
      style: { stroke: '#7c3aed', width: 2.5, fill: 'rgba(124,58,237,0.15)' },
      data: {},
    },
    {
      id: 'c1', kind: 'curve', x: 380, y: 130, w: 80, h: 40,
      shape: { points: [{ fx: 0, fy: 0.8 }, { fx: 0.3, fy: 0 }, { fx: 0.7, fy: 1 }, { fx: 1, fy: 0.2 }] },
      style: { stroke: '#0f766e', width: 2, capStart: 'dot', capEnd: 'dot' },
      data: {},
    },
    // a "custom piece" pair sharing a group — they move as one now
    piece('gHead', 165, 100, '見出し', null, { group: 'g1' }),
    piece('gBody', 165, 118, '説明文', null, { group: 'g1' }),
    // a double-stroke rule (P29 approximation)
    {
      id: 'r2', kind: 'line', x: 15, y: 175, w: 100, h: 2,
      shape: { points: [{ fx: 0, fy: 0.5 }, { fx: 1, fy: 0.5 }] },
      style: { stroke: '#333', width: 4, double: true },
      data: {},
    },
  ]
  const WIRE = { route: 'bezier' as const, style: { color: '#b45309', width: 1.8 }, markerEnd: 'arrow' as const }
  const edges: Edge[] = [
    { id: 'w1', from: { obj: 'z1', port: 'out' }, to: { obj: 'cAdd', port: 'a' }, ...WIRE },
    { id: 'w2', from: { obj: 'pShip', port: 'out' }, to: { obj: 'cAdd', port: 'b' }, ...WIRE },
    { id: 'w3', from: { obj: 'cAdd', port: 'out' }, to: { obj: 'cTax', port: 'a' }, ...WIRE },
  ]
  return { objects, edges, page }
}

/** Resolve an object's numeric value: piece → value, zone → Σ members,
    calc → op(wired inputs or constants). Cycles return null. */
export function objectValue(
  id: string,
  objects: WorldObject[],
  edges: Edge[],
  seen = new Set<string>(),
): number | null {
  if (seen.has(id)) return null
  const o = objects.find((o) => o.id === id)
  if (!o) return null
  seen.add(id)
  const d = o.data as AnyData | undefined
  if (o.kind === 'piece') return (d as PieceData)?.value ?? null
  if (o.kind === 'zone') {
    const members = objects.filter(
      (m) => m.id !== id && m.kind !== 'zone' && rectContains(o, m),
    )
    const fn = (d as ZoneData)?.fn
    if (fn === 'count') return members.length
    const vals = members
      .map((m) => objectValue(m.id, objects, edges, new Set(seen)))
      .filter((v): v is number => v !== null)
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null
  }
  if (o.kind === 'calc') {
    const cd = d as CalcData
    const input = (port: 'a' | 'b', fallback: number | null | undefined) => {
      const e = edges.find((e) => e.to.obj === id && e.to.port === port)
      return e ? objectValue(e.from.obj, objects, edges, new Set(seen)) : (fallback ?? null)
    }
    const a = input('a', cd?.constA)
    const b = input('b', cd?.constB)
    if (a === null || b === null) return null
    switch (cd?.op) {
      case 'add': return a + b
      case 'sub': return a - b
      case 'mul': return a * b
      case 'div': return b === 0 ? null : a / b
    }
  }
  return null
}

/** sethera's wiring rule: values flow out → calc inputs a/b. */
export function canConnect(from: { obj: string; port?: string }, to: { obj: string; port?: string }): boolean {
  if (from.port !== 'out') return false
  return to.port === 'a' || to.port === 'b'
}

/** One wire per calc input: an occupied input replaces its wire. */
export function connectReplace(to: { obj: string; port?: string }, edges: Edge[]): string[] {
  return edges
    .filter((e) => e.to.obj === to.obj && e.to.port === to.port)
    .map((e) => e.id)
}

/** Direction lives in the data, not the gesture — dragging from a calc
    input back to an `out` port still yields the out→in wire. */
export function connectOrient(
  a: { obj: string; port?: string },
  b: { obj: string; port?: string },
): { from: { obj: string; port?: string }; to: { obj: string; port?: string } } | null {
  const isOut = (e: { port?: string }) => e.port === 'out'
  const isIn = (e: { port?: string }) => e.port === 'a' || e.port === 'b'
  return isOut(a) && isIn(b)
    ? { from: a, to: b }
    : isIn(a) && isOut(b)
      ? { from: b, to: a }
      : null
}

/** Grabbing an occupied calc input picks up its wire's free end (rewire). */
export function rewirePickup(
  ep: { obj: string; port?: string },
  edges: Edge[],
): string | null {
  if (ep.port !== 'a' && ep.port !== 'b') return null
  return edges.find((e) => e.to.obj === ep.obj && e.to.port === ep.port)?.id ?? null
}

export const WIRE_DEFAULTS = {
  route: 'bezier' as const,
  style: { color: '#b45309', width: 1.8 },
  markerEnd: 'arrow' as const,
}

export const GRID_CFG = { size: GRID, snap: true }
