import type { Edge, EdgeMarker, EdgeRoute, Engine, Origin, Port, Pt, ResizeDir, WorldObject } from '@kimetron/core'
import { arcAngles, arcPoint, edgeAxis, edgeEndpoints, edgeGeom, edgeOutwardDirs, formatLength, objCenter, objPoint, rotPt, shapeAnchors, unitToPx, type RouteAxis } from '@kimetron/core'

export interface Frame {
  left: number
  top: number
  width: number
  height: number
  /** CSS `rotate()` degrees to append after translate (screen space —
      already origin-adjusted). 0 or undefined = no rotation. */
  rot?: number
}

/** Convert a world-space rotation to CSS screen degrees.
    Under a bottom-left origin the y-flip reverses the sense. */
export function screenRotDeg(engine: Engine, deg: number): number {
  return engine.doc.origin === 'top-left' ? deg : -deg
}

const GRID_LINE = 'var(--ki-grid, rgba(40, 60, 80, 0.10))'
const GRID_MAJOR_LINE = 'var(--ki-grid-major, rgba(40, 60, 80, 0.28))'

const GRID_LINE_LITERAL = 'rgba(40, 60, 80, 0.10)'
const GRID_MAJOR_LITERAL = 'rgba(40, 60, 80, 0.28)'

/** Data-URI SVG tile — for patterns a plain CSS gradient can't draw
    (dashed, cross). Needs a literal color, not a var. */
function svgTile(inner: string, sizePx: number): string {
	const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${sizePx}' height='${sizePx}'>${inner}</svg>`
	return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

export function gridBackground(engine: Engine): {
  backgroundImage: string
  backgroundSize: string
  backgroundPosition: string
} {
  const { doc, viewport: vp } = engine
  const s = doc.grid.size * unitToPx(doc.units) * vp.zoom
  const m = doc.grid.major
  const pat = doc.grid.pattern ?? 'lines'
  const pos = `${vp.x}px ${vp.y}px`
  const lineCol = doc.grid.color ?? GRID_LINE
  const majCol = doc.grid.color ?? GRID_MAJOR_LINE
  // P47: dots — one radial-gradient dot per cell corner
  if (pat === 'dots') {
    if (m && m > 1) {
      const ms = s * m
      return {
        backgroundImage:
          `radial-gradient(${majCol} 1.5px, transparent 1.5px),` +
          `radial-gradient(${lineCol} 1px, transparent 1px)`,
        backgroundSize: `${ms}px ${ms}px, ${s}px ${s}px`,
        backgroundPosition: pos,
      }
    }
    return {
      backgroundImage: `radial-gradient(${lineCol} 1px, transparent 1px)`,
      backgroundSize: `${s}px ${s}px`,
      backgroundPosition: pos,
    }
  }
  // P47: dashed / cross — SVG data-URI tiles (needs a literal color)
  if (pat === 'dashed' || pat === 'cross') {
    const sPx = Math.max(1, Math.round(s))
    // pass colors raw — svgTile URI-encodes the whole SVG once
    const col = doc.grid.color ?? GRID_LINE_LITERAL
    const majColLit = doc.grid.color ?? GRID_MAJOR_LITERAL
    // a corner cross spans tile boundaries — each tile draws the four
    // quarter-pluses on ITS corners so neighbors complete the +
    const cross = (w: number, arm: number) =>
      `M0 0.5 H${arm} M${w - arm} 0.5 H${w} M0 ${w - 0.5} H${arm} M${w - arm} ${w - 0.5} H${w} ` +
      `M0.5 0 V${arm} M0.5 ${w - arm} V${w} M${w - 0.5} 0 V${arm} M${w - 0.5} ${w - arm} V${w}`
    const cell = (w: number, stroke: string, dash: boolean) =>
      dash
        ? `<path d='M0 0.5 H${w} M0.5 0 V${w}' stroke='${stroke}' stroke-width='1' stroke-dasharray='4 3'/>`
        : `<path d='${cross(w, 4)}' stroke='${stroke}' stroke-width='0.5'/>`
    const cellM = (w: number, stroke: string, dash: boolean) =>
      dash
        ? `<path d='M0 0.5 H${w} M0.5 0 V${w}' stroke='${stroke}' stroke-width='1.5' stroke-dasharray='4 3'/>`
        : `<path d='${cross(w, 5)}' stroke='${stroke}' stroke-width='1'/>`
    if (m && m > 1) {
      const ms = sPx * m
      return {
        backgroundImage:
          svgTile(cellM(ms, majColLit, pat === 'dashed'), ms) +
          ',' +
          svgTile(cell(sPx, col, pat === 'dashed'), sPx),
        backgroundSize: `${ms}px ${ms}px, ${sPx}px ${sPx}px`,
        backgroundPosition: pos,
      }
    }
    return {
      backgroundImage: svgTile(cell(sPx, col, pat === 'dashed'), sPx),
      backgroundSize: `${sPx}px ${sPx}px`,
      backgroundPosition: pos,
    }
  }
  const minor =
    `linear-gradient(to right, ${lineCol} 1px, transparent 1px),` +
    `linear-gradient(to bottom, ${lineCol} 1px, transparent 1px)`
  if (m && m > 1) {
    const ms = s * m
    return {
      backgroundImage:
        `linear-gradient(to right, ${majCol} 1px, transparent 1px),` +
        `linear-gradient(to bottom, ${majCol} 1px, transparent 1px),` +
        minor,
      backgroundSize: `${ms}px ${ms}px, ${ms}px ${ms}px, ${s}px ${s}px, ${s}px ${s}px`,
      backgroundPosition: pos,
    }
  }
  return {
    backgroundImage: minor,
    backgroundSize: `${s}px ${s}px`,
    backgroundPosition: pos,
  }
}

export function objectFrame(engine: Engine, o: { x: number; y: number; w: number; h: number; id: string; rot?: number }): Frame {
  const { doc, viewport: vp } = engine
  const rr = engine.resize && engine.resize.id === o.id ? { ...o, ...engine.resize.rect } : o
  const d = engine.dragDelta && engine.selectedIds.has(o.id) ? engine.dragDelta : { x: 0, y: 0 }
  const deg =
    engine.rotate && engine.rotate.id === o.id ? engine.rotate.deg : (o.rot ?? 0)
  const u = unitToPx(doc.units) * vp.zoom
  const corner = {
    x: rr.x + d.x,
    y: doc.origin === 'top-left' ? rr.y + d.y : rr.y + d.y + rr.h,
  }
  const s = engine.worldToScreen(corner)
  return {
    left: s.x,
    top: s.y,
    width: rr.w * u,
    height: rr.h * u,
    rot: deg ? screenRotDeg(engine, deg) : 0,
  }
}

/** Screen-space frame of the document page rect, or null when unset. */
export function pageFrame(engine: Engine): Frame | null {
  const p = engine.doc.page
  if (!p) return null
  const { doc, viewport: vp } = engine
  const u = unitToPx(doc.units) * vp.zoom
  const corner = { x: p.x, y: doc.origin === 'top-left' ? p.y : p.y + p.h }
  const s = engine.worldToScreen(corner)
  return { left: s.x, top: s.y, width: p.w * u, height: p.h * u }
}

export function marqueeFrame(engine: Engine): Frame | null {
  const r = engine.marquee
  if (!r) return null
  const { doc, viewport: vp } = engine
  const u = unitToPx(doc.units) * vp.zoom
  const corner = { x: r.x, y: doc.origin === 'top-left' ? r.y : r.y + r.h }
  const s = engine.worldToScreen(corner)
  return { left: s.x, top: s.y, width: r.w * u, height: r.h * u }
}

// --- resize handles ---

export type HandleDir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export interface HandlePoint {
  dir: HandleDir
  x: number
  y: number
  cursor: string
}

const HANDLE_CURSORS: Record<HandleDir, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
}

/** Screen-space anchor points of the 8 resize handles on a frame (px). */
export function handlePoints(f: Frame): HandlePoint[] {
  const cx = f.left + f.width / 2
  const cy = f.top + f.height / 2
  const r = f.left + f.width
  const b = f.top + f.height
  const dirs: [HandleDir, number, number][] = [
    ['nw', f.left, f.top],
    ['n', cx, f.top],
    ['ne', r, f.top],
    ['e', r, cy],
    ['se', r, b],
    ['s', cx, b],
    ['sw', f.left, b],
    ['w', f.left, cy],
  ]
  return dirs.map(([dir, x, y]) => ({ dir, x, y, cursor: HANDLE_CURSORS[dir] }))
}

/** The 8 resize cursors indexed clockwise from screen-east (0°). */
const CURSOR_BY_ANGLE = [
  'ew-resize',
  'nwse-resize',
  'ns-resize',
  'nesw-resize',
  'ew-resize',
  'nwse-resize',
  'ns-resize',
  'nesw-resize',
] as const

function cursorForAngle(dx: number, dy: number): string {
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI
  const i = ((Math.round(deg / 45) % 8) + 8) % 8
  return CURSOR_BY_ANGLE[i]
}

/** Rotate a screen point around `c` by CSS degrees (clockwise, y down). */
function rotScreen(p: Pt, c: Pt, cssDeg: number): Pt {
  if (!cssDeg) return p
  const a = (cssDeg * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const dx = p.x - c.x
  const dy = p.y - c.y
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
}

/** Handle anchors for `o`, riding the object's rotation. Dirs still
    name the object's local edges — `screenDirToWorld` applies as-is. */
export function handlePointsFor(engine: Engine, o: WorldObject): HandlePoint[] {
  const f = objectFrame(engine, o)
  const c = { x: f.left + f.width / 2, y: f.top + f.height / 2 }
  return handlePoints(f).map((h) => {
    const p = rotScreen({ x: h.x, y: h.y }, c, f.rot ?? 0)
    return { dir: h.dir, x: p.x, y: p.y, cursor: cursorForAngle(p.x - c.x, p.y - c.y) }
  })
}

/** Screen-space vertex handles for a shape object — one grip per
    shape anchor (line/curve/polygon). Rotation-aware. Empty for
    kinds without anchors (ellipse/arc) and for locked objects. */
export function vertexHandlePoints(
  engine: Engine,
  o: WorldObject,
): { index: number; x: number; y: number }[] {
  if (o.locked) return []
  const anchors = shapeAnchors(o)
  if (anchors.length === 0) return []
  const c = objCenter(o)
  return anchors.map((p, i) => {
    const w0 = objPoint(o, p.fx, p.fy)
    const w = o.rot ? rotPt(w0, c, o.rot) : w0
    const s = engine.worldToScreen(w)
    return { index: i, x: s.x, y: s.y }
  })
}

/** Screen-space anchor for the rotate handle — the top edge midpoint
    pushed outward along the object's normal. */
export function rotateHandlePoint(engine: Engine, o: WorldObject, gapPx = 20): Pt | null {
  if (o.locked) return null
  const f = objectFrame(engine, o)
  const c = { x: f.left + f.width / 2, y: f.top + f.height / 2 }
  const top = { x: c.x, y: f.top }
  const p = rotScreen(top, c, f.rot ?? 0)
  const dx = p.x - c.x
  const dy = p.y - c.y
  const len = Math.hypot(dx, dy) || 1
  return { x: p.x + (dx / len) * gapPx, y: p.y + (dy / len) * gapPx }
}

/**
 * Map a screen-space handle direction to the world-space edges it moves.
 * X is origin-independent; Y flips because 'n' (top of screen) is the
 * max-y edge under bottom-left origin but the min-y edge under top-left.
 */
export function screenDirToWorld(dir: string, origin: Origin): ResizeDir {
  const x = (dir.includes('e') ? 1 : dir.includes('w') ? -1 : 0) as -1 | 0 | 1
  const ys = dir.includes('n') ? 1 : dir.includes('s') ? -1 : 0
  const y = (origin === 'bottom-left' ? ys : -ys) as -1 | 0 | 1
  return { x, y }
}

// --- ports & edges ---

/** Screen-space positions of an object's ports (rotated when the object is). */
export function portPoints(
  engine: Engine,
  o: { id: string; x: number; y: number; w: number; h: number; rot?: number; ports?: Port[] },
): { port: Port; x: number; y: number }[] {
  return (o.ports ?? []).map((p) => {
    const s = engine.worldToScreen(objPoint(o, p.fx, p.fy))
    return { port: p, x: s.x, y: s.y }
  })
}

const SMOOTH_RADIUS_PX = 8
export const EDGE_LINE = 'var(--ki-edge-line, #7d8fa3)'
const SEL_COLOR = 'var(--ki-sel, #3a7bd5)'

/** Polyline path with quadratic-rounded corners (screen px). */
function roundedPathD(pts: Pt[], r: number): string {
  if (pts.length < 3) {
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
  }
  let d = `M ${pts[0].x} ${pts[0].y}`
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const c = pts[i + 1]
    const l1 = Math.hypot(b.x - a.x, b.y - a.y)
    const l2 = Math.hypot(c.x - b.x, c.y - b.y)
    if (l1 === 0 || l2 === 0) {
      d += ` L ${b.x} ${b.y}`
      continue
    }
    const rr = Math.min(r, l1 / 2, l2 / 2)
    const p1 = { x: b.x + ((a.x - b.x) / l1) * rr, y: b.y + ((a.y - b.y) / l1) * rr }
    const p2 = { x: b.x + ((c.x - b.x) / l2) * rr, y: b.y + ((c.y - b.y) / l2) * rr }
    d += ` L ${p1.x} ${p1.y} Q ${b.x} ${b.y} ${p2.x} ${p2.y}`
  }
  return d + ` L ${pts[pts.length - 1].x} ${pts[pts.length - 1].y}`
}

/** SVG path `d` for a resolved world-space route. */
export function routePathD(
  engine: Engine,
  from: Pt,
  to: Pt,
  route: EdgeRoute = 'straight',
  bend = 0.5,
  axis?: RouteAxis,
  outward?: { from: Pt; to: Pt },
): string {
  const g = edgeGeom(from, to, route, bend, axis, outward)
  if (g.kind === 'bezier') {
    const [p0, c1, c2, p3] = g.pts.map((p) => engine.worldToScreen(p))
    return `M ${p0.x} ${p0.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p3.x} ${p3.y}`
  }
  const pts = g.pts.map((p) => engine.worldToScreen(p))
  if (route === 'smoothstep') return roundedPathD(pts, SMOOTH_RADIUS_PX)
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
}

/** SVG path `d` for a document edge, or null if an endpoint is dangling. */
export function edgePathD(engine: Engine, e: Edge): string | null {
  const ends = edgeEndpoints(engine.doc, e)
  if (!ends) return null
  return routePathD(
    engine,
    ends.from,
    ends.to,
    e.route,
    engine.edgeBendT(e),
    edgeAxis(engine.doc, e),
    edgeOutwardDirs(engine.doc, e) ?? undefined,
  )
}

/** Marker element id for an edge endpoint. */
export function markerId(e: Edge, end: 'start' | 'end'): string {
  return `ki-m-${e.id}-${end}`
}

/** Presentation attributes for rendering an edge path (`<path>` attrs). */
export interface EdgeAttrs {
  d: string
  stroke?: string
  strokeWidth?: number
  strokeDasharray?: string
  markerStart?: string
  markerEnd?: string
  double?: boolean
}

export function edgeAttrs(engine: Engine, e: Edge): EdgeAttrs | null {
  const d = edgePathD(engine, e)
  if (!d) return null
  return {
    d,
    stroke: e.style?.color,
    strokeWidth: e.style?.width,
    strokeDasharray: e.style?.dash?.join(' '),
    markerStart: e.markerStart ? `url(#${markerId(e, 'start')})` : undefined,
    markerEnd: e.markerEnd ? `url(#${markerId(e, 'end')})` : undefined,
    double: e.style?.double,
  }
}

/** Screen-px position of the bend handle on the selected edge — the
    midpoint of its trunk segment, shown when exactly one
    'orthogonal'/'smoothstep' edge is selected. `cursor` follows the
    dominant axis. */
export function bendHandlePoint(
  engine: Engine,
): { id: string; x: number; y: number; cursor: string } | null {
  if (engine.selectedIds.size !== 1) return null
  const id = [...engine.selectedIds][0]
  const e = engine.doc.edges.find((e) => e.id === id)
  if (!e || (e.route !== 'orthogonal' && e.route !== 'smoothstep')) return null
  const ends = edgeEndpoints(engine.doc, e)
  if (!ends) return null
  const hDom = edgeAxis(engine.doc, e) === 'h'
  const bend = engine.edgeBendT(e)
  const w = hDom
    ? {
        x: ends.from.x + (ends.to.x - ends.from.x) * bend,
        y: (ends.from.y + ends.to.y) / 2,
      }
    : {
        x: (ends.from.x + ends.to.x) / 2,
        y: ends.from.y + (ends.to.y - ends.from.y) * bend,
      }
  const s = engine.worldToScreen(w)
  return { id, x: s.x, y: s.y, cursor: hDom ? 'ew-resize' : 'ns-resize' }
}

/** Inner stroke color of double lines (the paper color). */
export const DOUBLE_INNER = 'var(--ki-bg, #fff)'

/** Double-stroke widths: outer rail = color, inner channel = bg. */
export function doubleWidths(width?: number): { outer: number; inner: number } {
  const outer = width ?? 4
  return { outer, inner: Math.max(0.8, outer - 2.2) }
}

// --- shape kinds (line / curve / ellipse / arc) ---

const SHAPE_LINE = 'var(--ki-edge, #7d8fa3)'

/** Marker element id for a shape cap. */
export function shapeCapMarkerId(o: WorldObject, end: 's' | 'e'): string {
  return `ki-mo-${o.id}-${end}`
}

/** SVG path `d` (frame-local px) for a shape object, or null. */
export function shapePathD(engine: Engine, o: WorldObject): string | null {
  const f = objectFrame(engine, o)
  const rr =
    engine.resize && engine.resize.id === o.id
      ? { ...o, ...engine.resize.rect }
      : o
  const d0 =
    engine.dragDelta && engine.selectedIds.has(o.id)
      ? engine.dragDelta
      : { x: 0, y: 0 }
  const eff = { x: rr.x + d0.x, y: rr.y + d0.y, w: rr.w, h: rr.h }
  const toLocal = (w: Pt): Pt => {
    const s = engine.worldToScreen(w)
    return { x: s.x - f.left, y: s.y - f.top }
  }
  const fmt = (p: Pt) => `${p.x} ${p.y}`

  if (o.kind === 'line' || o.kind === 'curve' || o.kind === 'polygon') {
    const pts = shapeAnchors(o).map((a) =>
      toLocal({ x: eff.x + a.fx * eff.w, y: eff.y + a.fy * eff.h }),
    )
    if (pts.length < 2) return null
    if (o.kind === 'polygon') {
      if (pts.length < 3) return null
      return `M ${fmt(pts[0])} ${pts.slice(1).map((p) => `L ${fmt(p)}`).join(' ')} Z`
    }
    if (o.kind === 'curve' && pts.length > 2) {
      let d = `M ${fmt(pts[0])}`
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)]
        const p1 = pts[i]
        const p2 = pts[i + 1]
        const p3 = pts[Math.min(pts.length - 1, i + 2)]
        const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 }
        const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }
        d += ` C ${fmt(c1)} ${fmt(c2)} ${fmt(p2)}`
      }
      return d
    }
    return `M ${fmt(pts[0])} ${pts.slice(1).map((p) => `L ${fmt(p)}`).join(' ')}`
  }

  const rx = f.width / 2
  const ry = f.height / 2
  const cx = f.width / 2
  const cy = f.height / 2
  if (o.kind === 'ellipse') {
    return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx - rx} ${cy} Z`
  }
  if (o.kind === 'arc') {
    const { a0, delta } = arcAngles(o)
    const p0 = toLocal(arcPoint(eff, a0))
    const p1 = toLocal(arcPoint(eff, a0 + delta))
    // world CCW sweeps clockwise on screen under top-left origin
    const sweep = engine.doc.origin === 'top-left' ? 1 : 0
    const pie = !!o.style?.fill
    const head = pie ? `M ${cx} ${cy} L ${fmt(p0)}` : `M ${fmt(p0)}`
    if (delta === 360) {
      const pm = toLocal(arcPoint(eff, a0 + 180))
      const arcs = `A ${rx} ${ry} 0 1 ${sweep} ${fmt(pm)} A ${rx} ${ry} 0 1 ${sweep} ${fmt(p0)}`
      return pie ? `${head} ${arcs} Z` : `${head} ${arcs}`
    }
    const seg = `A ${rx} ${ry} 0 ${delta > 180 ? 1 : 0} ${sweep} ${fmt(p1)}`
    return pie ? `${head} ${seg} Z` : `${head} ${seg}`
  }
  return null
}

/** Presentation attributes for a shape object's inner `<path>`. */
export interface ShapeAttrs {
  d: string
  fill?: string
  stroke?: string
  strokeWidth?: number
  strokeDasharray?: string
  markerStart?: string
  markerEnd?: string
  double?: boolean
}

export function shapeAttrs(engine: Engine, o: WorldObject): ShapeAttrs | null {
  const d = shapePathD(engine, o)
  if (!d) return null
  const sel = engine.selectedIds.has(o.id)
  return {
    d,
    fill:
      o.kind === 'ellipse' || o.kind === 'arc' || o.kind === 'polygon'
        ? (o.style?.fill ?? 'none')
        : 'none',
    stroke: sel ? SEL_COLOR : (o.style?.stroke ?? SHAPE_LINE),
    strokeWidth: o.style?.width,
    strokeDasharray: o.style?.dash?.join(' '),
    markerStart: o.style?.capStart ? `url(#${shapeCapMarkerId(o, 's')})` : undefined,
    markerEnd: o.style?.capEnd ? `url(#${shapeCapMarkerId(o, 'e')})` : undefined,
    double: o.style?.double,
  }
}

/** A screen-axis ruler tick: position in canvas px, label (major only). */
export interface RulerTick {
  px: number
  label: string
  major: boolean
}

const RULER_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]
const RULER_MIN_STEP_PX = 45

/** World-unit tick marks for a screen-axis ruler (major = every 10th step). */
export function rulerTicks(engine: Engine, axis: 'x' | 'y', spanPx: number): RulerTick[] {
  const u = unitToPx(engine.doc.units) * engine.viewport.zoom
  const w0 = engine.screenToWorld({ x: 0, y: 0 })
  const w1 = axis === 'x'
    ? engine.screenToWorld({ x: spanPx, y: 0 })
    : engine.screenToWorld({ x: 0, y: spanPx })
  const lo = Math.min(axis === 'x' ? w0.x : w0.y, axis === 'x' ? w1.x : w1.y)
  const hi = Math.max(axis === 'x' ? w0.x : w0.y, axis === 'x' ? w1.x : w1.y)
  let step = RULER_STEPS[RULER_STEPS.length - 1]
  for (const s of RULER_STEPS) {
    if (s * u >= RULER_MIN_STEP_PX) {
      step = s
      break
    }
  }
  const ticks: RulerTick[] = []
  const i0 = Math.ceil(lo / step)
  const i1 = Math.floor(hi / step)
  for (let i = i0; i <= i1; i++) {
    const v = i * step
    const major = i % 10 === 0
    const p = engine.worldToScreen(axis === 'x' ? { x: v, y: 0 } : { x: 0, y: v })
    ticks.push({
      px: axis === 'x' ? p.x : p.y,
      label: major ? formatLength(v, engine.doc.units) : '',
      major,
    })
  }
  return ticks
}

/** Drag/resize/rotate HUD readout (world units), or null when idle. */
export function hudText(engine: Engine): string | null {
  const u = engine.doc.units
  if (engine.rotate) {
    return `${engine.rotate.deg.toFixed(1)}°`
  }
  if (engine.resize) {
    const r = engine.resize.rect
    return `${formatLength(r.w, u)} × ${formatLength(r.h, u)} @ ${formatLength(r.x, u)}, ${formatLength(r.y, u)}`
  }
  if (engine.dragDelta) {
    const b = engine.selectionBounds()
    if (!b) return null
    const d = engine.dragDelta
    return `${formatLength(b.x + d.x, u)}, ${formatLength(b.y + d.y, u)} (${formatLength(b.w, u)} × ${formatLength(b.h, u)})`
  }
  return null
}

/** A `<marker>` def needed by an edge or a shape cap: id, glyph kind, resolved color. */
export interface EdgeMarkerDef {
  id: string
  kind: EdgeMarker
  color: string
  /** Stroke width (screen px) of the carrier path — caps scale up
      with it so thick strokes don't swallow the marker. */
  strokeW?: number
}

export function edgeMarkerDefs(engine: Engine, e: Edge): EdgeMarkerDef[] {
  const color = engine.selectedIds.has(e.id) ? SEL_COLOR : (e.style?.color ?? EDGE_LINE)
  const defs: EdgeMarkerDef[] = []
  if (e.markerStart)
    defs.push({ id: markerId(e, 'start'), kind: e.markerStart, color, strokeW: e.style?.width })
  if (e.markerEnd)
    defs.push({ id: markerId(e, 'end'), kind: e.markerEnd, color, strokeW: e.style?.width })
  return defs
}

/** `<marker>` defs needed by a shape object's caps. */
export function shapeCapMarkerDefs(engine: Engine, o: WorldObject): EdgeMarkerDef[] {
  const color = engine.selectedIds.has(o.id)
    ? SEL_COLOR
    : (o.style?.stroke ?? SHAPE_LINE)
  const defs: EdgeMarkerDef[] = []
  if (o.style?.capStart)
    defs.push({ id: shapeCapMarkerId(o, 's'), kind: o.style.capStart, color, strokeW: o.style?.width })
  if (o.style?.capEnd)
    defs.push({ id: shapeCapMarkerId(o, 'e'), kind: o.style.capEnd, color, strokeW: o.style?.width })
  return defs
}

let injected = false

export function injectStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const el = document.createElement('style')
  el.dataset.kimetron = ''
  el.textContent = `
.ki-canvas { position: relative; overflow: hidden; touch-action: none; user-select: none; cursor: default; }
.ki-obj { position: absolute; left: 0; top: 0; box-sizing: border-box; border: 1px solid var(--ki-edge, #7d8fa3); background: var(--ki-fill, rgba(125, 143, 163, 0.18)); overflow: hidden; }
.ki-obj.ki-sel { border-color: var(--ki-sel, #3a7bd5); box-shadow: 0 0 0 1px var(--ki-sel, #3a7bd5); }
.ki-obj.ki-invalid { border-color: var(--ki-danger, #d33); box-shadow: 0 0 0 2px var(--ki-danger, #d33); }
.ki-obj.ki-shape.ki-invalid { border: 1px dashed var(--ki-danger, #d33); box-shadow: none; }
.ki-marquee { position: absolute; left: 0; top: 0; border: 1px dashed var(--ki-sel, #3a7bd5); background: rgba(58, 123, 213, 0.08); pointer-events: none; }
.ki-handle { position: absolute; width: 8px; height: 8px; margin: -4px 0 0 -4px; background: #fff; border: 1px solid var(--ki-sel, #3a7bd5); box-sizing: border-box; z-index: 10; }
.ki-handle[hidden] { display: none; }
.ki-rot { position: absolute; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%; background: #fff; border: 1.5px solid var(--ki-sel, #3a7bd5); box-sizing: border-box; z-index: 10; cursor: grab; }
.ki-rot[hidden] { display: none; }
.ki-bend { position: absolute; width: 9px; height: 9px; margin: -4.5px 0 0 -4.5px; background: #fff; border: 1.5px solid var(--ki-sel, #3a7bd5); border-radius: 2px; box-sizing: border-box; z-index: 10; }
.ki-bend[hidden] { display: none; }
.ki-vtxs { position: absolute; inset: 0; pointer-events: none; z-index: 11; }
.ki-vtx { position: absolute; width: 8px; height: 8px; margin: -4px 0 0 -4px; background: #fff; border: 1.5px solid var(--ki-sel, #3a7bd5); border-radius: 2px; box-sizing: border-box; cursor: move; pointer-events: auto; }
.ki-vtx:hover { background: var(--ki-sel, #3a7bd5); }
.ki-guides { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.ki-guide { position: absolute; background: var(--ki-guide, #e0393e); }
.ki-guide-v { top: 0; bottom: 0; width: 1px; }
.ki-guide-h { left: 0; right: 0; height: 1px; }
.ki-edges { position: absolute; inset: 0; overflow: visible; pointer-events: none; z-index: 0; }
.ki-edge { fill: none; }
.ki-edge.ki-sel { stroke: var(--ki-sel, #3a7bd5); stroke-width: 2.5; }
.ki-edge-preview { fill: none; stroke: var(--ki-sel, #3a7bd5); stroke-width: 1.5; stroke-dasharray: 4 3; }
.ki-edge-preview.ki-invalid { stroke: var(--ki-danger, #d33); }
.ki-obj { z-index: 1; }
.ki-ports { position: absolute; inset: 0; pointer-events: none; z-index: 5; }
.ki-port { position: absolute; width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 50%; background: #fff; border: 1.5px solid var(--ki-edge-line, #7d8fa3); box-sizing: border-box; cursor: crosshair; pointer-events: auto; }
.ki-port:hover { border-color: var(--ki-sel, #3a7bd5); background: var(--ki-sel, #3a7bd5); }
.ki-obj.ki-shape { border: none; background: transparent; overflow: visible; pointer-events: none; }
.ki-obj.ki-shape.ki-sel { border: 1px dashed var(--ki-sel, #3a7bd5); box-shadow: none; }
.ki-shape-svg { position: absolute; left: 0; top: 0; overflow: visible; }
.ki-shape { fill: none; }
.ki-page { position: absolute; left: 0; top: 0; background: var(--ki-page, #fff); border: 1px solid var(--ki-page-border, #b8c4d0); box-shadow: 0 1px 4px rgba(0,0,0,0.08); z-index: 0; pointer-events: none; }
.ki-hud { position: absolute; top: 8px; right: 8px; padding: 2px 8px; font: 11px/1.4 ui-monospace, monospace; background: rgba(28,39,51,0.85); color: #fff; border-radius: 4px; pointer-events: none; z-index: 20; }
`
  document.head.appendChild(el)
}
