import { objPoint } from './geometry'
import { isShapeKind, shapeAnchors } from './shape'
import type { Doc, Edge, EdgeEndpoint, Pt, WorldConfig, WorldObject } from './types'

export function createDocument(cfg: WorldConfig = {}): Doc {
  return {
    schemaVersion: 2,
    units: cfg.units ?? 'mm',
    origin: cfg.origin ?? 'bottom-left',
    grid: {
      size: cfg.grid?.size ?? 10,
      snap: cfg.grid?.snap ?? true,
      ...(typeof cfg.grid?.major === 'number' ? { major: cfg.grid.major } : {}),
      ...(cfg.grid?.pattern ? { pattern: cfg.grid.pattern } : {}),
      ...(cfg.grid?.color ? { color: cfg.grid.color } : {}),
    },
    objects: [],
    edges: [],
  }
}

export function addObject(doc: Doc, o: WorldObject): Doc {
  return { ...doc, objects: [...doc.objects, o] }
}

export function moveObject(doc: Doc, id: string, x: number, y: number): Doc {
  return {
    ...doc,
    objects: doc.objects.map((o) => (o.id === id ? { ...o, x, y } : o)),
  }
}

export function moveObjects(doc: Doc, ids: Iterable<string>, dx: number, dy: number): Doc {
  const set = new Set(ids)
  return {
    ...doc,
    objects: doc.objects.map((o) => (set.has(o.id) ? { ...o, x: o.x + dx, y: o.y + dy } : o)),
  }
}

export function removeObjects(doc: Doc, ids: Iterable<string>): Doc {
  const set = new Set(ids)
  return {
    ...doc,
    objects: doc.objects.filter((o) => !set.has(o.id)),
    // edges referencing removed objects are dropped (no orphans)
    edges: doc.edges.filter(
      (e) => !set.has(e.from.obj) && !set.has(e.to.obj),
    ),
  }
}

export function addEdge(doc: Doc, e: Edge): Doc {
  return { ...doc, edges: [...doc.edges, e] }
}

export function removeEdges(doc: Doc, ids: Iterable<string>): Doc {
  const set = new Set(ids)
  return { ...doc, edges: doc.edges.filter((e) => !set.has(e.id)) }
}

/** Retarget an edge's endpoints (rewire). Presentation fields are kept. */
export function retargetEdge(
  doc: Doc,
  id: string,
  from: EdgeEndpoint,
  to: EdgeEndpoint,
): Doc {
  return {
    ...doc,
    edges: doc.edges.map((e) => (e.id === id ? { ...e, from, to } : e)),
  }
}

/** Set the trunk position (fraction 0..1 along the dominant axis) on
    'orthogonal'/'smoothstep' edges — several ids at once so sibling
    edges sharing a trunk move together. */
export function bendEdges(doc: Doc, ids: Iterable<string>, bend: number): Doc {
  const set = new Set(ids)
  return {
    ...doc,
    edges: doc.edges.map((e) => (set.has(e.id) ? { ...e, bend } : e)),
  }
}

/** Resolve an endpoint to a world point, or null if the target is gone.
    Ports are normalized (fx, fy) so they ride the object's rotation. */
export function endpointPos(doc: Doc, ep: { obj: string; port?: string }): Pt | null {
  const o = doc.objects.find((o) => o.id === ep.obj)
  if (!o) return null
  if (ep.port) {
    const p = o.ports?.find((p) => p.id === ep.port)
    if (p) return objPoint(o, p.fx, p.fy)
  }
  return { x: o.x + o.w / 2, y: o.y + o.h / 2 }
}

/** World points of both ends of an edge, or null if either end is dangling. */
export function edgeEndpoints(doc: Doc, e: Edge): { from: Pt; to: Pt } | null {
  const from = endpointPos(doc, e.from)
  const to = endpointPos(doc, e.to)
  return from && to ? { from, to } : null
}

/** The axis a route bends along — 'h' means the trunk slides on x
    (vertical trunk, horizontal end segments), 'v' the opposite. */
export type RouteAxis = 'h' | 'v'

/** The axis a port faces — 'h' for left/right-side ports, 'v' for
    top/bottom-side ports — derived from the port's offset from the object
    center, rotated with the object. Null for centered/corner ports or
    endpoints without a port. */
export function portFacingAxis(o: WorldObject, portId?: string): RouteAxis | null {
  if (!portId || !o.ports) return null
  const p = o.ports.find((p) => p.id === portId)
  if (!p) return null
  let dx = p.fx - 0.5
  let dy = p.fy - 0.5
  if (o.rot) {
    const r = (o.rot * Math.PI) / 180
    const c = Math.cos(r)
    const s = Math.sin(r)
    const rx = dx * c - dy * s
    const ry = dx * s + dy * c
    dx = rx
    dy = ry
  }
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax > ay) return 'h'
  if (ay > ax) return 'v'
  return null
}

/** Outward unit vector of a port — the direction an edge leaves/enters
    through it: l→(-1,0), r→(+1,0), t→(0,-1), b→(0,+1), rotated with the
    object. Null for centered/corner ports or endpoints without a port. */
export function portNormal(o: WorldObject, portId?: string): Pt | null {
	if (!portId || !o.ports) return null
	const p = o.ports.find((p) => p.id === portId)
	if (!p) return null
	let dx = p.fx - 0.5
	let dy = p.fy - 0.5
	if (o.rot) {
		const r = (o.rot * Math.PI) / 180
		const c = Math.cos(r)
		const s = Math.sin(r)
		const rx = dx * c - dy * s
		const ry = dx * s + dy * c
		dx = rx
		dy = ry
	}
	const len = Math.hypot(dx, dy)
	if (len < 1e-6) return null
	return { x: dx / len, y: dy / len }
}

/** Outward normals of both edge endpoints, for direction-aware routes
    (bezier control points leave/enter along the port normal, not the
    endpoint delta — sibling links on the same side keep a clean S). */
export function edgeOutwardDirs(
	doc: Doc,
	e: Edge,
): { from: Pt; to: Pt } | null {
	const of = doc.objects.find((o) => o.id === e.from.obj)
	const ot = doc.objects.find((o) => o.id === e.to.obj)
	const from = of ? portNormal(of, e.from.port) : null
	const to = ot ? portNormal(ot, e.to.port) : null
	return from && to ? { from, to } : null
}

/** Dominant axis for an edge's 'orthogonal'/'smoothstep' route. Port
    facing wins: r→l is always 'h' so tree brackets keep a vertical trunk
    even when children sit far above/below the parent; a mixed edge uses
    the exit side; portless endpoints fall back to the endpoint delta. */
export function edgeAxis(doc: Doc, e: Edge): RouteAxis {
  const of = doc.objects.find((o) => o.id === e.from.obj)
  const ot = doc.objects.find((o) => o.id === e.to.obj)
  const fa = of ? portFacingAxis(of, e.from.port) : null
  const fb = ot ? portFacingAxis(ot, e.to.port) : null
  const facing = fa ?? fb
  if (facing) return facing
  const ends = edgeEndpoints(doc, e)
  if (!ends) return 'h'
  return Math.abs(ends.to.x - ends.from.x) >= Math.abs(ends.to.y - ends.from.y)
    ? 'h'
    : 'v'
}

/** Objects in paint order — `layer` asc, then array order (last = topmost). */
export function renderOrder(objects: WorldObject[]): WorldObject[] {
  return objects
    .map((o, i) => ({ o, i }))
    .sort((a, b) => (a.o.layer ?? 0) - (b.o.layer ?? 0) || a.i - b.i)
    .map(({ o }) => o)
}

export type ZOrder = 'front' | 'back' | 'forward' | 'backward'

/** Reorder `objects` array (render order = array order; last = topmost). */
export function reorderObjects(
  doc: Doc,
  ids: Iterable<string>,
  op: ZOrder,
): Doc {
  const set = new Set(ids)
  if (set.size === 0) return doc
  const objs = [...doc.objects]
  const sel = objs.filter((o) => set.has(o.id))
  const rest = objs.filter((o) => !set.has(o.id))
  if (op === 'front') return { ...doc, objects: [...rest, ...sel] }
  if (op === 'back') return { ...doc, objects: [...sel, ...rest] }
  const indices = objs.map((o, i) => (set.has(o.id) ? i : -1)).filter((i) => i >= 0)
  if (op === 'forward') {
    for (let k = indices.length - 1; k >= 0; k--) {
      const i = indices[k]
      if (i + 1 >= objs.length || set.has(objs[i + 1].id)) continue
      ;[objs[i], objs[i + 1]] = [objs[i + 1], objs[i]]
    }
  } else {
    for (const i of indices) {
      if (i === 0 || set.has(objs[i - 1].id)) continue
      ;[objs[i], objs[i - 1]] = [objs[i - 1], objs[i]]
    }
  }
  return { ...doc, objects: objs }
}

/** Set an object's rotation (world CCW degrees, about the bbox center). */
export function rotateObject(doc: Doc, id: string, deg: number): Doc {
  return {
    ...doc,
    objects: doc.objects.map((o) => (o.id === id ? { ...o, rot: deg } : o)),
  }
}

export function resizeObject(
  doc: Doc,
  id: string,
  r: { x: number; y: number; w: number; h: number },
): Doc {
  return {
    ...doc,
    objects: doc.objects.map((o) =>
      o.id === id ? { ...o, x: r.x, y: r.y, w: r.w, h: r.h } : o,
    ),
  }
}

/** Rebuild a shape object's bbox so it tightly contains `pts`
    (unrotated-frame world coords) and renormalize its anchors.
    Degenerate axes collapse to fraction 0.5. */
function reframeAnchors(o: WorldObject, pts: Pt[]): WorldObject {
  const x1 = Math.min(...pts.map((p) => p.x))
  const y1 = Math.min(...pts.map((p) => p.y))
  const x2 = Math.max(...pts.map((p) => p.x))
  const y2 = Math.max(...pts.map((p) => p.y))
  const w = x2 - x1
  const h = y2 - y1
  return {
    ...o,
    x: x1,
    y: y1,
    w,
    h,
    shape: {
      ...o.shape,
      points: pts.map((p) => ({
        fx: w > 0 ? (p.x - x1) / w : 0.5,
        fy: h > 0 ? (p.y - y1) / h : 0.5,
      })),
    },
  }
}

/** Move anchor `index` of a shape object to `pt` (unrotated-frame
    world coords — inverse-rotate first when the object is rotated).
    The object's bbox re-normalizes around all anchors. */
export function setShapePoint(doc: Doc, id: string, index: number, pt: Pt): Doc {
  const o = doc.objects.find((o) => o.id === id)
  if (!o || !isShapeKind(o.kind)) return doc
  const anchors = shapeAnchors(o)
  if (index < 0 || index >= anchors.length) return doc
  const pts = anchors.map((p) => objPoint(o, p.fx, p.fy))
  pts[index] = pt
  return {
    ...doc,
    objects: doc.objects.map((x) => (x === o ? reframeAnchors(o, pts) : x)),
  }
}

/** Insert an anchor into a 'curve'/'polygon' object between anchors
    `segIndex` and `segIndex+1` (the polygon's closing segment wraps).
    `pt` is in the object's unrotated frame. 'line' keeps exactly two
    anchors, so insertion is rejected there. */
export function insertShapePoint(doc: Doc, id: string, segIndex: number, pt: Pt): Doc {
  const o = doc.objects.find((o) => o.id === id)
  if (!o || (o.kind !== 'curve' && o.kind !== 'polygon')) return doc
  const anchors = shapeAnchors(o)
  const maxSeg = o.kind === 'polygon' ? anchors.length : anchors.length - 1
  if (segIndex < 0 || segIndex >= maxSeg) return doc
  const pts = anchors.map((p) => objPoint(o, p.fx, p.fy))
  pts.splice(segIndex + 1, 0, pt)
  return {
    ...doc,
    objects: doc.objects.map((x) => (x === o ? reframeAnchors(o, pts) : x)),
  }
}

/** Remove anchor `index` of a 'curve'/'polygon' object — the bbox
    re-normalizes around the remaining anchors. Minimum counts are
    enforced (curve ≥ 2, polygon ≥ 3); 'line' is rejected. */
export function removeShapePoint(doc: Doc, id: string, index: number): Doc {
  const o = doc.objects.find((o) => o.id === id)
  if (!o || (o.kind !== 'curve' && o.kind !== 'polygon')) return doc
  const anchors = shapeAnchors(o)
  const min = o.kind === 'polygon' ? 3 : 2
  if (index < 0 || index >= anchors.length || anchors.length <= min) return doc
  const pts = anchors
    .map((p) => objPoint(o, p.fx, p.fy))
    .filter((_, i) => i !== index)
  return {
    ...doc,
    objects: doc.objects.map((x) => (x === o ? reframeAnchors(o, pts) : x)),
  }
}

export function serializeDoc(doc: Doc): string {
  return JSON.stringify(doc, null, 2)
}

export function deserializeDoc(json: string): Doc {
  const raw = JSON.parse(json) as Partial<Doc>
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.objects)) {
    throw new Error('invalid kimetron document')
  }
  const base = createDocument({
    units: raw.units,
    origin: raw.origin,
    grid: raw.grid,
  })
  return {
    ...base,
    objects: raw.objects.map((o) => ({
      id: String(o.id),
      kind: typeof o.kind === 'string' ? o.kind : 'rect',
      x: Number(o.x) || 0,
      y: Number(o.y) || 0,
      w: Number(o.w) || 0,
      h: Number(o.h) || 0,
      ...(Array.isArray(o.ports)
        ? {
            ports: o.ports.map((p) => ({
              id: String(p.id),
              fx: Number(p.fx) || 0,
              fy: Number(p.fy) || 0,
            })),
          }
        : {}),
      ...(o.style && typeof o.style === 'object'
        ? {
            style: {
              ...(typeof o.style.fill === 'string' ? { fill: o.style.fill } : {}),
              ...(typeof o.style.stroke === 'string' ? { stroke: o.style.stroke } : {}),
              ...(typeof o.style.width === 'number' ? { width: o.style.width } : {}),
              ...(Array.isArray(o.style.dash) ? { dash: o.style.dash.map(Number) } : {}),
              ...(o.style.capStart === 'arrow' || o.style.capStart === 'dot'
                ? { capStart: o.style.capStart }
                : {}),
              ...(o.style.capEnd === 'arrow' || o.style.capEnd === 'dot'
                ? { capEnd: o.style.capEnd }
                : {}),
              ...(o.style.double === true ? { double: true } : {}),
            },
          }
        : {}),
      ...(o.shape && typeof o.shape === 'object'
        ? {
            shape: {
              ...(Array.isArray(o.shape.points)
                ? {
                    points: o.shape.points.map((p) => ({
                      fx: Number(p.fx) || 0,
                      fy: Number(p.fy) || 0,
                    })),
                  }
                : {}),
              ...(typeof o.shape.a0 === 'number' ? { a0: o.shape.a0 } : {}),
              ...(typeof o.shape.a1 === 'number' ? { a1: o.shape.a1 } : {}),
            },
          }
        : {}),
      ...(typeof o.rot === 'number' && Number.isFinite(o.rot) ? { rot: o.rot } : {}),
      ...(typeof o.group === 'string' ? { group: o.group } : {}),
      ...(o.locked === true ? { locked: true } : {}),
      ...(o.solid === true ? { solid: true } : {}),
      ...(typeof o.layer === 'number' ? { layer: o.layer } : {}),
      ...(o.data !== undefined ? { data: o.data } : {}),
    })),
    edges: Array.isArray(raw.edges)
      ? raw.edges
          .filter((e) => e && e.from && e.to)
          .map((e) => ({
            id: String(e.id),
            from: { obj: String(e.from.obj), ...(e.from.port ? { port: String(e.from.port) } : {}) },
            to: { obj: String(e.to.obj), ...(e.to.port ? { port: String(e.to.port) } : {}) },
            ...(e.route ? { route: e.route } : {}),
            ...(typeof e.bend === 'number' && Number.isFinite(e.bend)
              ? { bend: e.bend }
              : {}),
            ...(e.style && typeof e.style === 'object'
              ? {
                  style: {
                    ...(typeof e.style.color === 'string' ? { color: e.style.color } : {}),
                    ...(typeof e.style.width === 'number' ? { width: e.style.width } : {}),
                    ...(Array.isArray(e.style.dash) ? { dash: e.style.dash.map(Number) } : {}),
                    ...(e.style.double === true ? { double: true } : {}),
                  },
                }
              : {}),
            ...(e.markerStart === 'arrow' || e.markerStart === 'dot'
              ? { markerStart: e.markerStart }
              : {}),
            ...(e.markerEnd === 'arrow' || e.markerEnd === 'dot'
              ? { markerEnd: e.markerEnd }
              : {}),
            ...(e.label !== undefined ? { label: String(e.label) } : {}),
          }))
      : [],
    ...(raw.page && typeof raw.page === 'object'
      ? {
          page: {
            x: Number(raw.page.x) || 0,
            y: Number(raw.page.y) || 0,
            w: Number(raw.page.w) || 0,
            h: Number(raw.page.h) || 0,
          },
        }
      : {}),
  }
}
