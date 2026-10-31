import { distToSegment } from './edge'
import { invRotPt, objCenter, objPoint, obbOf, pointInPoly, pointInRect, rectOf, rotPt } from './geometry'
import type { Pt, WorldObject } from './types'

/** Kinds the engine interprets as non-rectangular outlines. */
export function isShapeKind(kind: string): boolean {
  return (
    kind === 'line' ||
    kind === 'curve' ||
    kind === 'ellipse' ||
    kind === 'arc' ||
    kind === 'polygon'
  )
}

const DEFAULT_CHORD = [
  { fx: 0, fy: 0 },
  { fx: 1, fy: 1 },
]

/** Normalized stroke anchors of a 'line'/'curve'/'polygon' object
    (bbox fractions). 'polygon' anchors describe a CLOSED outline. */
export function shapeAnchors(o: WorldObject): { fx: number; fy: number }[] {
  if (o.kind === 'line') {
    return o.shape?.points && o.shape.points.length === 2
      ? o.shape.points
      : DEFAULT_CHORD
  }
  if (o.kind === 'curve' || o.kind === 'polygon') return o.shape?.points ?? []
  return []
}

const fxToWorld = (o: { x: number; y: number; w: number; h: number }, fx: number, fy: number): Pt => ({
  x: o.x + fx * o.w,
  y: o.y + fy * o.h,
})

/** Resolved arc angles: a0, a1 (degrees) and the sweep delta (0 < delta <= 360). */
export function arcAngles(o: WorldObject): { a0: number; a1: number; delta: number } {
  const a0 = o.shape?.a0 ?? 0
  const a1 = o.shape?.a1 ?? 270
  let delta = (((a1 - a0) % 360) + 360) % 360
  if (delta === 0) delta = 360
  return { a0, a1, delta }
}

/** World point on the bbox-inscribed ellipse at `deg` (world CCW, +x = 0°). */
export function arcPoint(o: { x: number; y: number; w: number; h: number }, deg: number): Pt {
  const a = (deg * Math.PI) / 180
  return {
    x: o.x + o.w / 2 + (o.w / 2) * Math.cos(a),
    y: o.y + o.h / 2 + (o.h / 2) * Math.sin(a),
  }
}

/** Sample an open Catmull-Rom curve through `pts` as a polyline. */
export function catmullRomPolyline(pts: Pt[], samplesPerSpan = 16): Pt[] {
  if (pts.length < 3) return [...pts]
  const out: Pt[] = [pts[0]]
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    for (let j = 1; j <= samplesPerSpan; j++) {
      const t = j / samplesPerSpan
      const t2 = t * t
      const t3 = t2 * t
      out.push({
        x: 0.5 * (2 * p1.x + (p2.x - p0.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (3 * p1.x - p0.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (p2.y - p0.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (3 * p1.y - p0.y - 3 * p2.y + p3.y) * t3),
      })
    }
  }
  return out
}

/** World-space sampled outline of a shape kind — for hit tests.
    Rotation is applied to the resolved points. */
export function shapePolyline(o: WorldObject): Pt[] {
  let pts: Pt[]
  if (o.kind === 'arc') {
    const { a0, delta } = arcAngles(o)
    const n = Math.max(16, Math.round(delta / 8))
    pts = []
    for (let i = 0; i <= n; i++) pts.push(arcPoint(o, a0 + (delta * i) / n))
  } else {
    const anchors = shapeAnchors(o).map((p) => fxToWorld(o, p.fx, p.fy))
    pts = o.kind === 'curve' ? catmullRomPolyline(anchors) : anchors
    if (o.kind === 'polygon' && pts.length > 0) pts = [...pts, pts[0]] // closed loop
  }
  if (o.rot) {
    const c = objCenter(o)
    return pts.map((p) => rotPt(p, c, o.rot as number))
  }
  return pts
}

/** World points that participate in object snapping (in addition to bbox edges). */
export function shapeSnapPoints(o: WorldObject): Pt[] {
  let pts: Pt[]
  if (o.kind === 'arc') {
    const { a0, a1 } = arcAngles(o)
    pts = [arcPoint(o, a0), arcPoint(o, a1)]
  } else {
    pts = shapeAnchors(o).map((p) => fxToWorld(o, p.fx, p.fy))
  }
  if (o.rot) {
    const c = objCenter(o)
    return pts.map((p) => rotPt(p, c, o.rot as number))
  }
  return pts
}

/** The object's occupied outline as world-space polygon points —
    `obbOf` for box-like kinds, the actual vertex loop for 'polygon'. */
export function footprintOf(o: WorldObject): Pt[] {
  if (o.kind === 'polygon' && o.shape?.points && o.shape.points.length >= 3) {
    return o.shape.points.map((p) => objPoint(o, p.fx, p.fy))
  }
  return obbOf(o)
}

function distToPolyline(p: Pt, pts: Pt[]): number {
  let best = Infinity
  for (let i = 0; i + 1 < pts.length; i++) {
    best = Math.min(best, distToSegment(p, pts[i], pts[i + 1]))
  }
  return best
}

/** Kind-aware hit test. `tol` is in world units; rect kinds ignore it
    (the bbox is the hit area). Rotated objects are tested by
    inverse-rotating the query point into the local frame. */
export function hitObject(o: WorldObject, p: Pt, tol: number): boolean {
  const lp = o.rot ? invRotPt(p, objCenter(o), o.rot) : p
  const lo = o.rot ? { ...o, rot: 0 } : o
  if (o.kind === 'polygon') {
    const pts = shapePolyline(lo) // closed loop (first point repeated)
    if (pts.length < 4) return pointInRect(lp, rectOf(o))
    // filled → interior hits; unfilled → the outline band hits
    return o.style?.fill !== undefined
      ? pointInPoly(lp, pts.slice(0, -1))
      : distToPolyline(lp, pts) <= tol
  }
  if (o.kind === 'line' || o.kind === 'curve' || o.kind === 'arc') {
    const pts = shapePolyline(lo)
    return pts.length >= 2 && distToPolyline(lp, pts) <= tol
  }
  if (o.kind === 'ellipse') {
    const rx = o.w / 2
    const ry = o.h / 2
    if (rx <= 0 || ry <= 0) return pointInRect(p, rectOf(o))
    const dx = (lp.x - (o.x + rx)) / rx
    const dy = (lp.y - (o.y + ry)) / ry
    const r = Math.hypot(dx, dy)
    const band = tol / Math.min(rx, ry)
    return o.style?.fill ? r <= 1 + band : Math.abs(r - 1) <= band
  }
  return pointInRect(lp, rectOf(o))
}
