import type { EdgeRoute, Pt } from './types'

/** Geometry of a resolved edge, in world coordinates. */
export type EdgeGeom =
  | { kind: 'polyline'; pts: Pt[] }
  | { kind: 'bezier'; pts: [Pt, Pt, Pt, Pt] } // P0, C1, C2, P3

/**
 * Compute the route between two world points.
 * straight: direct line. orthogonal: single bend at `bend` (a fraction
 * 0..1, default 0.5) along the dominant axis. smoothstep: same points as
 * orthogonal (the renderer rounds the corners). bezier: cubic with
 * controls along the dominant axis.
 * `axis` forces the dominant axis ('h' = trunk slides on x); when omitted
 * it is inferred from the endpoint delta (callers with port knowledge
 * should pass `edgeAxis` so port facing wins over the delta).
 */
export function edgeGeom(
  from: Pt,
  to: Pt,
  route: EdgeRoute = 'straight',
  bend = 0.5,
  axis?: 'h' | 'v',
  /** outward unit normals of the from/to ports — bezier controls extend
      along them (out of the port), giving the classic S-curve even when
      the target sits "behind" the port (sibling links on the same side) */
  outward?: { from: Pt; to: Pt },
): EdgeGeom {
  const hDom =
    axis !== undefined
      ? axis === 'h'
      : Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)
  if (route === 'bezier') {
    const dx = to.x - from.x
    const dy = to.y - from.y
    if (outward) {
      const m = Math.hypot(dx, dy) * 0.25
      return {
        kind: 'bezier',
        pts: [
          from,
          { x: from.x + outward.from.x * m, y: from.y + outward.from.y * m },
          { x: to.x + outward.to.x * m, y: to.y + outward.to.y * m },
          to,
        ],
      }
    }
    const c1 = hDom
      ? { x: from.x + dx * 0.5, y: from.y }
      : { x: from.x, y: from.y + dy * 0.5 }
    const c2 = hDom
      ? { x: to.x - dx * 0.5, y: to.y }
      : { x: to.x, y: to.y - dy * 0.5 }
    return { kind: 'bezier', pts: [from, c1, c2, to] }
  }
  if (route === 'orthogonal' || route === 'smoothstep') {
    const mid = hDom
      ? { x: from.x + (to.x - from.x) * bend, y: from.y }
      : { x: from.x, y: from.y + (to.y - from.y) * bend }
    const mid2 = hDom
      ? { x: from.x + (to.x - from.x) * bend, y: to.y }
      : { x: to.x, y: from.y + (to.y - from.y) * bend }
    return { kind: 'polyline', pts: [from, mid, mid2, to] }
  }
  return { kind: 'polyline', pts: [from, to] }
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  const qx = a.x + t * dx - p.x
  const qy = a.y + t * dy - p.y
  return Math.hypot(qx, qy)
}

function bezierPoint(p0: Pt, c1: Pt, c2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y,
  }
}

/** Approximate the geometry as a polyline (beziers sampled into segments). */
export function geomPolyline(g: EdgeGeom, samples = 16): Pt[] {
  if (g.kind === 'polyline') return g.pts
  const [p0, c1, c2, p3] = g.pts
  const pts: Pt[] = []
  for (let i = 0; i <= samples; i++) pts.push(bezierPoint(p0, c1, c2, p3, i / samples))
  return pts
}

/** Minimum distance from `p` to the edge geometry, in world units. */
export function distToGeom(p: Pt, g: EdgeGeom): number {
  const pts = geomPolyline(g)
  let best = Infinity
  for (let i = 0; i + 1 < pts.length; i++) {
    best = Math.min(best, distToSegment(p, pts[i], pts[i + 1]))
  }
  return best
}
