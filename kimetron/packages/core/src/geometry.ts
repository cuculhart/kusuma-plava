import type { GridConfig, Origin, Pt, Rect, Unit, Viewport, WorldObject } from './types'
import { unitToPx } from './units'

export function worldToScreen(
  p: Pt,
  ctx: { units: Unit; origin: Origin },
  vp: Viewport,
): Pt {
  const u = unitToPx(ctx.units) * vp.zoom
  return {
    x: p.x * u + vp.x,
    y: ctx.origin === 'top-left' ? p.y * u + vp.y : vp.y - p.y * u,
  }
}

export function screenToWorld(
  p: Pt,
  ctx: { units: Unit; origin: Origin },
  vp: Viewport,
): Pt {
  const u = unitToPx(ctx.units) * vp.zoom
  return {
    x: (p.x - vp.x) / u,
    y: ctx.origin === 'top-left' ? (p.y - vp.y) / u : (vp.y - p.y) / u,
  }
}

export function snap(v: number, grid: GridConfig): number {
  return grid.snap && grid.size > 0 ? Math.round(v / grid.size) * grid.size : v
}

export function rectOf(o: WorldObject): Rect {
  return { x: o.x, y: o.y, w: o.w, h: o.h }
}

export function pointInRect(p: Pt, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** True when `inner` is fully inside `outer` (inclusive edges). */
export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  )
}

/** Overlap area of two rects (0 when disjoint). */
export function rectOverlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

export function rectBetween(a: Pt, b: Pt): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  }
}

// --- rotation (world CCW degrees, pivot = bbox center) ---

/** Rotate `p` around `c` by `deg` (CCW, world space). */
export function rotPt(p: Pt, c: Pt, deg: number): Pt {
  if (!deg) return p
  const a = (deg * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const dx = p.x - c.x
  const dy = p.y - c.y
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
}

/** Inverse-rotate `p` around `c` — maps a world point into the
    object's local (unrotated) frame. */
export function invRotPt(p: Pt, c: Pt, deg: number): Pt {
  return rotPt(p, c, -deg)
}

/** Center of an object's bbox — the rotation pivot. */
export function objCenter(o: { x: number; y: number; w: number; h: number }): Pt {
  return { x: o.x + o.w / 2, y: o.y + o.h / 2 }
}

/** Local-fraction point (0..1 of the bbox) resolved to world coords,
    including rotation. */
export function objPoint(
  o: { x: number; y: number; w: number; h: number; rot?: number },
  fx: number,
  fy: number,
): Pt {
  const p = { x: o.x + fx * o.w, y: o.y + fy * o.h }
  return o.rot ? rotPt(p, objCenter(o), o.rot) : p
}

/** The object's oriented bounding box — 4 world-space corners
    (unrotated objects get their plain rect corners). */
export function obbOf(o: { x: number; y: number; w: number; h: number; rot?: number }): Pt[] {
  const r = o.rot ?? 0
  const pts: Pt[] = [
    { x: o.x, y: o.y },
    { x: o.x + o.w, y: o.y },
    { x: o.x + o.w, y: o.y + o.h },
    { x: o.x, y: o.y + o.h },
  ]
  if (!r) return pts
  const c = objCenter(o)
  return pts.map((p) => rotPt(p, c, r))
}

/** Axis-aligned bounding box of a point set. */
export function aabbOf(pts: Pt[]): Rect {
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const x0 = Math.min(...xs)
  const y0 = Math.min(...ys)
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 }
}

/** Corners of an axis-aligned rect as a polygon (for SAT). */
export function rectPoly(r: Rect): Pt[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ]
}

function orient(a: Pt, b: Pt, c: Pt): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function onSeg(a: Pt, b: Pt, p: Pt, eps: number): boolean {
  return (
    Math.abs(orient(a, b, p)) <= eps &&
    p.x >= Math.min(a.x, b.x) - eps &&
    p.x <= Math.max(a.x, b.x) + eps &&
    p.y >= Math.min(a.y, b.y) - eps &&
    p.y <= Math.max(a.y, b.y) + eps
  )
}

/** Proper segment intersection — the interiors cross. Touching at
    endpoints or collinear overlap does NOT count. */
export function segsProperlyIntersect(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  const d1 = orient(b1, b2, a1)
  const d2 = orient(b1, b2, a2)
  const d3 = orient(a1, a2, b1)
  const d4 = orient(a1, a2, b2)
  return d1 * d2 < 0 && d3 * d4 < 0
}

/** Even-odd point-in-polygon test. `strict` excludes boundary points
    (they count as inside when strict is false). */
export function pointInPoly(p: Pt, poly: Pt[], strict = false): boolean {
  const EPS = 1e-9
  if (strict) {
    for (let i = 0; i < poly.length; i++) {
      if (onSeg(poly[i], poly[(i + 1) % poly.length], p, EPS)) return false
    }
  }
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

/** General polygon intersection (convex OR concave): true when the
    polygons share interior — a proper edge crossing, or a vertex /
    edge-midpoint of one lying strictly inside the other (the midpoint
    check catches a chord that touches the boundary at both ends).
    Edge-only contact does NOT count as an overlap. */
export function polysIntersect(a: Pt[], b: Pt[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i]
    const a2 = a[(i + 1) % a.length]
    for (let j = 0; j < b.length; j++) {
      if (segsProperlyIntersect(a1, a2, b[j], b[(j + 1) % b.length])) return true
    }
  }
  const interior = (outer: Pt[], inner: Pt[]): boolean =>
    inner.some((p, i) => {
      if (pointInPoly(p, outer, true)) return true
      const q = inner[(i + 1) % inner.length]
      return pointInPoly({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, outer, true)
    })
  return interior(a, b) || interior(b, a)
}
