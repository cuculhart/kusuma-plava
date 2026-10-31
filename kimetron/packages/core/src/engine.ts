import {
  addEdge,
  addObject,
  bendEdges,
  createDocument,
  edgeAxis,
  edgeEndpoints,
  edgeOutwardDirs,
  endpointPos,
  insertShapePoint as docInsertShapePoint,
  moveObjects,
  removeEdges,
  removeObjects,
  removeShapePoint as docRemoveShapePoint,
  reorderObjects,
  renderOrder,
  resizeObject,
  retargetEdge,
  rotateObject,
  setShapePoint,
  type ZOrder,
} from './doc'
import { distToGeom, distToSegment, edgeGeom } from './edge'
import {
  aabbOf,
  invRotPt,
  objCenter,
  objPoint,
  obbOf,
  polysIntersect,
  rectBetween,
  rectPoly,
  screenToWorld,
  worldToScreen,
} from './geometry'
import { footprintOf, hitObject, isShapeKind, shapeAnchors, shapeSnapPoints } from './shape'
import type { Doc, Edge, EdgeEndpoint, EdgeRoute, GridConfig, Origin, Pt, Rect, Unit, Viewport, WorldConfig, WorldObject } from './types'
import { formatScale, unitToPx } from './units'

export type Mode =
  | 'idle'
  | 'drag'
  | 'marquee'
  | 'pan'
  | 'resize'
  | 'connect'
  | 'rotate'
  | 'bend'
  | 'vertex'
  | 'shape'

export interface PointerOpts {
  button?: number
  additive?: boolean
  /** Alt+drag: drag only the hit object, ignoring its group. */
  detached?: boolean
  /** Interactive element under the pointer (`.nodrag` content like
      inputs/buttons inside a custom-rendered object): still applies
      selection, but never arms a move/marquee gesture. */
  noDrag?: boolean
}

/** Which world-space edges a resize handle moves: -1 = min edge, +1 = max edge, 0 = untouched. */
export interface ResizeDir {
  x: -1 | 0 | 1
  y: -1 | 0 | 1
}

export type EngineListener = (engine: Engine) => void

/** A world-space alignment line shown while dragging/resizing. axis 'x' = vertical line at x=at. */
export interface Guide {
  axis: 'x' | 'y'
  at: number
}

const ZOOM_MIN = 0.02
const ZOOM_MAX = 50
const MIN_SIZE = 1e-3
const SNAP_TOL_PX = 8
const PORT_TOL_PX = 10
const EDGE_TOL_PX = 6
const HIT_TOL_PX = 6

export class Engine {
  doc: Doc
  viewport: Viewport = { x: 40, y: 40, zoom: 1 }
  readonly selectedIds = new Set<string>()
  dragDelta: Pt | null = null
  resize: { id: string; rect: Rect } | null = null
  guides: Guide[] = []
  /** In-progress connect gesture: source endpoint and hovered target (if any).
      `invalid` is set when the hovered endpoint fails `canConnect`.
      `rewire` retargets an existing edge — `end` marks which side follows
      the pointer; the other side stays anchored. */
  connect: {
    from: EdgeEndpoint
    hover: EdgeEndpoint | null
    invalid: boolean
    /** Pointer is over some port even when `hover` is null (same-object
        ports don't count as empty canvas for a rewire detach). */
    overPort?: boolean
    rewire?: { edge: string; end: 'from' | 'to' }
  } | null = null
  /** Route assigned to edges created by the connect gesture. */
  connectRoute: Edge['route'] = 'straight'
  /** Defaults merged into edges created by the connect gesture
      (route/style/markers/label; id/from/to are always taken from the gesture). */
  connectEdge?: Partial<Edge>
  /** Optional policy hook — return false to reject a connection (commit and hover are blocked). */
  canConnect?: (from: EdgeEndpoint, to: EdgeEndpoint) => boolean
  /** Optional hook — edge ids removed when a connection commits, in the
      same commit (e.g. replacing the wire on an occupied calc input). */
  connectReplace?: (from: EdgeEndpoint, to: EdgeEndpoint) => Iterable<string>
  /** Optional hook — impose direction on a fresh connection. Given the
      grabbed endpoint `a` and hovered endpoint `b`, return the edge's
      ordered {from,to} (e.g. always out→in regardless of drag direction),
      or null to forbid the pair. Default: {from: a, to: b}. */
  connectOrient?: (
    a: EdgeEndpoint,
    b: EdgeEndpoint,
  ) => { from: EdgeEndpoint; to: EdgeEndpoint } | null
  /** Optional hook — when a connect gesture starts on `ep`, return the id
      of an existing edge to rewire instead of creating a new one (e.g.
      grabbing an occupied input picks up its wire's free end). The end
      matching `ep` stays anchored; the other end follows the pointer. */
  rewireEdge?: (ep: EdgeEndpoint) => string | null
  /** Optional hook — additional edge ids whose trunk follows a bend
      gesture on `edge` in the same commit (e.g. siblings sharing one
      visual trunk in a bracket). Default: only the dragged edge. */
  bendGroup?: (edge: Edge, doc: Doc) => Iterable<string>
  /** In-progress bend gesture preview: affected edge ids and the live
      trunk fraction. */
  edgeBend: { ids: string[]; t: number } | null = null
  /** Collision handling for `solid` objects:
      'none' = physics-free, 'flag' = mark colliding gestures via
      `dragInvalid` but commit anyway, 'reject' = refuse the commit. */
  collisionMode: 'none' | 'flag' | 'reject' = 'none'
  /** Optional exception hook — return true to allow a pair of solids
      to overlap (e.g. a door object placed on a wall). */
  canOverlap?: (a: WorldObject, b: WorldObject) => boolean
  /** Optional hook — aspect ratio (h/w) the resize gesture must hold
      for `o` (e.g. a locked image). Corner drags grow to cover the
      pointer while preserving the ratio; edge drags stay free. */
  resizeAspect?: (o: WorldObject) => number | null
  /** In-progress shape-draw gesture (P49): the driver picked a shape
      tool and each click appends a snapped point. `commitShapeDraw`
      turns the chain into an object; `cancelShapeDraw` discards it. */
  shapeDraw: { kind: string; pts: Pt[] } | null = null
  /** True while the drag/resize hover position illegally overlaps a solid. */
  dragInvalid = false
  /** Extra snap candidates injected by the app (page frames, guides). */
  snapExtra: { xs: number[]; ys: number[] } = { xs: [], ys: [] }
  /** Object-edge/center snapping during drag/resize. Independent of
      `doc.grid.snap` — set false to disable snapping entirely. */
  snapObjects = true
  /** Optional hook — return false to hide an object from pointer
      hit-testing (click/drag selection). E.g. a strokes-only edit
      mode, or click-through zones handled by their own chrome. */
  hitFilter?: (o: WorldObject) => boolean
  /** Optional hook — return false to exclude an object from marquee
      selection (e.g. zones selected only via their own chrome). */
  marqueeFilter?: (o: WorldObject) => boolean
  /** Optional hook — return false to exclude an edge from pointer
      hit-testing (e.g. a wires-hidden "final figure" view where
      invisible wires shouldn't be clickable/bendable). */
  edgeFilter?: (e: Edge) => boolean
  /** Optional hook — when several objects overlap at a click point,
      the one with the highest rank wins (ties keep render order —
      topmost first). Lets apps deprioritize background linework
      without removing it from hit-testing entirely. */
  hitPriority?: (o: WorldObject) => number
  /** In-progress vertex gesture: target object + anchor index. The doc
      is patched live via `patchDoc` (renders follow immediately) and
      folded into one undo step by `commitDoc` on pointerUp. */
  vertex: { id: string; index: number } | null = null
  /** In-progress rotate gesture preview: target id and live angle (deg). */
  rotate: { id: string; deg: number } | null = null
  /** Angle snap for the rotate gesture while `pointerMove`'s
      `angleSnap` opt is held (deg; 0 disables snapping). */
  rotateSnapDeg = 15
  marquee: Rect | null = null
  cursorWorld: Pt = { x: 0, y: 0 }
  version = 0

  mode: Mode = 'idle'
  private start: Pt = { x: 0, y: 0 }
  private startWorld: Pt = { x: 0, y: 0 }
  private vpStart: Viewport | null = null
  private dragIds: string[] = []
  private dragAnchor: Pt = { x: 0, y: 0 }
  private dragAnchorSize: { w: number; h: number } = { w: 0, h: 0 }
  private resizeId: string | null = null
  private resizeDir: ResizeDir = { x: 0, y: 0 }
  private resizeOrig: Rect | null = null
  private resizeCenter: Pt = { x: 0, y: 0 }
  private resizeRot = 0
  private rotateId: string | null = null
  private rotateOrig = 0
  private rotateCenter: Pt = { x: 0, y: 0 }
  private rotateStartAng = 0
  private listeners = new Set<EngineListener>()
  private docListeners = new Set<(doc: Doc) => void>()
  private selectionListeners = new Set<(ids: ReadonlySet<string>) => void>()
  private past: Doc[] = []
  private future: Doc[] = []
  private lastDoc: Doc | null = null

  constructor(cfg: WorldConfig = {}, objects: WorldObject[] = []) {
    this.doc = { ...createDocument(cfg), objects }
    this.lastDoc = this.doc
  }

  subscribe(fn: EngineListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  onDocChange(fn: (doc: Doc) => void): () => void {
    this.docListeners.add(fn)
    return () => this.docListeners.delete(fn)
  }

  onSelectionChange(fn: (ids: ReadonlySet<string>) => void): () => void {
    this.selectionListeners.add(fn)
    return () => this.selectionListeners.delete(fn)
  }

  private emit(): void {
    this.version++
    for (const fn of this.listeners) fn(this)
  }

  private emitDoc(): void {
    if (this.lastDoc && this.lastDoc !== this.doc) {
      this.past.push(this.lastDoc)
      if (this.past.length > 100) this.past.shift()
      this.future = []
    }
    this.lastDoc = this.doc
    for (const fn of this.docListeners) fn(this.doc)
    this.emit()
  }

  private emitSelection(): void {
    for (const fn of this.selectionListeners) fn(this.selectedIds)
    this.emit()
  }

  // --- config (doc-level, serialized with the document) ---

  setUnits(units: Unit): void {
    if (this.doc.units === units) return
    this.doc = { ...this.doc, units }
    this.emitDoc()
  }

  setOrigin(origin: Origin): void {
    if (this.doc.origin === origin) return
    this.doc = { ...this.doc, origin }
    this.emitDoc()
  }

  setGrid(grid: Partial<GridConfig>): void {
    this.doc = { ...this.doc, grid: { ...this.doc.grid, ...grid } }
    this.emitDoc()
  }

  // --- transforms ---

  worldToScreen(p: Pt): Pt {
    return worldToScreen(p, this.doc, this.viewport)
  }

  screenToWorld(p: Pt): Pt {
    return screenToWorld(p, this.doc, this.viewport)
  }

  scaleText(): string {
    return formatScale(this.viewport.zoom)
  }

  /** Place the world origin inside the visible canvas. */
  placeOrigin(bounds: { w: number; h: number }, margin = 40): void {
    this.viewport = {
      x: margin,
      y: this.doc.origin === 'bottom-left' ? bounds.h - margin : margin,
      zoom: 1,
    }
    this.emit()
  }

  // --- document ops ---

  /** Replace the whole document (e.g. file load). Counts as one undoable commit. */
  setDoc(doc: Doc): void {
    this.doc = doc
    for (const id of [...this.selectedIds]) {
      if (
        !doc.objects.some((o) => o.id === id) &&
        !doc.edges.some((e) => e.id === id)
      ) {
        this.selectedIds.delete(id)
      }
    }
    this.emitDoc()
  }

  /** Swap the doc without a history commit — gesture-live previews.
      Follow with `commitDoc` at gesture end to fold the edits into one
      undo step (the pre-gesture doc becomes the undo point). */
  patchDoc(doc: Doc): void {
    this.doc = doc
    this.emit()
  }

  /** Commit the current doc as one history entry after silent `patchDoc`
      updates. No-op when nothing changed. */
  commitDoc(): void {
    if (this.lastDoc === this.doc) return
    this.emitDoc()
  }

  // --- undo / redo (document commits only) ---

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  undo(): void {
    const prev = this.past.pop()
    if (!prev) return
    this.future.push(this.doc)
    this.applyDoc(prev)
  }

  redo(): void {
    const next = this.future.pop()
    if (!next) return
    this.past.push(this.doc)
    this.applyDoc(next)
  }

  private applyDoc(doc: Doc): void {
    this.doc = doc
    this.lastDoc = doc
    let selChanged = false
    for (const id of [...this.selectedIds]) {
      if (
        !doc.objects.some((o) => o.id === id) &&
        !doc.edges.some((e) => e.id === id)
      ) {
        this.selectedIds.delete(id)
        selChanged = true
      }
    }
    for (const fn of this.docListeners) fn(this.doc)
    if (selChanged) for (const fn of this.selectionListeners) fn(this.selectedIds)
    this.emit()
  }

  addObject(o: WorldObject): void {
    this.doc = addObject(this.doc, o)
    this.emitDoc()
  }

  moveSelectedBy(dx: number, dy: number): void {
    const ids = [...this.selectedIds].filter((id) => !this.lockedById(id))
    this.doc = moveObjects(this.doc, ids, dx, dy)
    this.emitDoc()
  }

  private lockedById(id: string): boolean {
    return this.objById(id)?.locked === true
  }

  /** Lazily-built spatial + identity index for the current doc.
      Rebuilt when the doc reference changes — every mutation swaps
      `this.doc`, so reference comparison is the staleness check.
      Queries filter `doc.objects` by the candidate set, so results
      keep doc-registration order exactly. */
  private idx: {
    doc: Doc
    byId: Map<string, WorldObject>
    footprints: Map<string, Pt[]>
    cell: number
    grid: Map<string, string[]>
    always: string[]
  } | null = null

  private spatial() {
    const idx = this.idx
    if (idx && idx.doc === this.doc) return idx
    const objects = this.doc.objects
    const byId = new Map<string, WorldObject>()
    const footprints = new Map<string, Pt[]>()
    const boxes = objects.map((o) => {
      byId.set(o.id, o)
      const f = footprintOf(o)
      footprints.set(o.id, f)
      return aabbOf(f)
    })
    // cell ≈ the typical object span — median of the larger AABB
    // side — so a typical object covers only a few cells
    const sides = boxes.map((b) => Math.max(b.w, b.h)).sort((a, b) => a - b)
    const cell = Math.max(sides[Math.floor(sides.length / 2)] ?? 1, 1e-9)
    const grid = new Map<string, string[]>()
    const always: string[] = []
    const MAX_CELLS = 64 // objects spanning more cells go to `always`
    objects.forEach((o, i) => {
      const b = boxes[i]
      const x0 = Math.floor(b.x / cell)
      const x1 = Math.floor((b.x + b.w) / cell)
      const y0 = Math.floor(b.y / cell)
      const y1 = Math.floor((b.y + b.h) / cell)
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS) {
        always.push(o.id)
        return
      }
      for (let gx = x0; gx <= x1; gx++) {
        for (let gy = y0; gy <= y1; gy++) {
          const k = `${gx},${gy}`
          ;(grid.get(k) ?? grid.set(k, []).get(k)!).push(o.id)
        }
      }
    })
    this.idx = { doc: this.doc, byId, footprints, cell, grid, always }
    return this.idx
  }

  /** Objects whose AABB may intersect `rect` — a superset of the
      footprint answer, so the exact tests still decide. `always`
      (objects too large for the grid) is included unconditionally. */
  private candidates(rect: Rect): ReadonlySet<string> {
    const idx = this.spatial()
    const out = new Set<string>(idx.always)
    const x0 = Math.floor(rect.x / idx.cell)
    const x1 = Math.floor((rect.x + rect.w) / idx.cell)
    const y0 = Math.floor(rect.y / idx.cell)
    const y1 = Math.floor((rect.y + rect.h) / idx.cell)
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        for (const id of idx.grid.get(`${gx},${gy}`) ?? []) out.add(id)
      }
    }
    return out
  }

  private objById(id: string): WorldObject | undefined {
    return this.spatial().byId.get(id)
  }

  removeSelected(): void {
    if (this.selectedIds.size === 0) return
    const objIds = [...this.selectedIds].filter(
      (id) => this.doc.objects.some((o) => o.id === id) && !this.lockedById(id),
    )
    const edgeIds = [...this.selectedIds].filter((id) =>
      this.doc.edges.some((e) => e.id === id),
    )
    this.doc = removeEdges(removeObjects(this.doc, objIds), edgeIds)
    this.selectedIds.clear()
    this.emitDoc()
    this.emitSelection()
  }

  /** Patch an edge's presentation fields (route/style/markers/label). One commit. */
  updateEdge(id: string, patch: Partial<Omit<Edge, 'id' | 'from' | 'to'>>): void {
    if (!this.doc.edges.some((e) => e.id === id)) return
    this.doc = {
      ...this.doc,
      edges: this.doc.edges.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    }
    this.emitDoc()
  }

  /** Rewire an edge's endpoints programmatically (the gesture-less
      counterpart of startRewire). One commit. */
  retargetEdge(id: string, from: EdgeEndpoint, to: EdgeEndpoint): void {
    if (!this.doc.edges.some((e) => e.id === id)) return
    this.doc = retargetEdge(this.doc, id, from, to)
    this.emitDoc()
  }

  /** Move the selected objects in z-order (array order = render order, last = top). */
  reorderSelected(op: ZOrder): void {
    if (this.selectedIds.size === 0) return
    this.doc = reorderObjects(this.doc, this.selectedIds, op)
    this.emitDoc()
  }

  /** Duplicate the selection, offset by one grid step, and select the copies. */
  duplicateSelected(): void {
    if (this.selectedIds.size === 0) return
    const step = this.doc.grid.size > 0 ? this.doc.grid.size : 10
    const ids = new Set(this.doc.objects.map((o) => o.id))
    const fresh = (base: string) => {
      let n = 1
      let id = `${base}-copy`
      while (ids.has(id)) id = `${base}-copy${++n}`
      ids.add(id)
      return id
    }
    const copies = this.doc.objects
      .filter((o) => this.selectedIds.has(o.id) && !o.locked)
      .map((o) => ({
        ...o,
        id: fresh(o.id),
        x: o.x + step,
        y: o.y + step,
        ...(o.shape
          ? {
              shape: {
                ...o.shape,
                points: o.shape.points?.map((p) => ({ ...p })),
              },
            }
          : {}),
      }))
    this.doc = { ...this.doc, objects: [...this.doc.objects, ...copies] }
    this.emitDoc()
    this.setSelection(copies.map((o) => o.id))
  }

  setSelection(ids: Iterable<string>): void {
    this.selectedIds.clear()
    for (const id of ids) this.selectedIds.add(id)
    this.emitSelection()
  }

  // --- hit test ---

  objectAt(screenPt: Pt): WorldObject | null {
    const w = this.screenToWorld(screenPt)
    const tol = HIT_TOL_PX / (unitToPx(this.doc.units) * this.viewport.zoom)
    const objs = renderOrder(this.doc.objects)
    const cands = this.candidates({ x: w.x - tol, y: w.y - tol, w: 2 * tol, h: 2 * tol })
    let best: WorldObject | null = null
    let bestRank = -Infinity
    for (let i = objs.length - 1; i >= 0; i--) {
      const o = objs[i]
      if (!cands.has(o.id)) continue
      if (this.hitFilter && !this.hitFilter(o)) continue
      if (!hitObject(o, w, tol)) continue
      if (!this.hitPriority) return o
      const r = this.hitPriority(o)
      if (r > bestRank) {
        bestRank = r
        best = o
      }
    }
    return best
  }

  /** All objects whose footprint intersects `rect` — solid or not.
      Rotated objects use their OBB, polygons their vertex loop.
      Edge-touching is not an overlap. */
  objectsIn(rect: Rect, exclude?: ReadonlySet<string>): WorldObject[] {
    const poly = rectPoly(rect)
    const idx = this.spatial()
    const cands = this.candidates(rect)
    return this.doc.objects.filter(
      (o) =>
        !exclude?.has(o.id) &&
        cands.has(o.id) &&
        polysIntersect(poly, idx.footprints.get(o.id)!),
    )
  }

  /** Solid objects whose footprint intersects `rect` — the solid-only
      view of `objectsIn`. */
  collisions(rect: Rect, exclude?: ReadonlySet<string>): WorldObject[] {
    return this.objectsIn(rect, exclude).filter((o) => o.solid === true)
  }

  /** Would `o` fit at `rect` (default: its current position) without
      illegally overlapping solids? Honors `canOverlap`, ignores
      `collisionMode` — a pure geometry/policy check. */
  canPlace(o: WorldObject, rect?: Rect): boolean {
    const mover = rect ? { ...o, ...rect } : o
    return !this.blockedBySolid(mover, new Set([o.id]))
  }

  /** Programmatic move through the collision policy — like a drag
      commit without the gesture. Returns false when `collisionMode`
      isn't 'none' and the target spot is illegally occupied, or when
      the object is locked/missing. */
  tryMove(id: string, dx: number, dy: number): boolean {
    const o = this.objById(id)
    if (!o || o.locked) return false
    if (
      this.collisionMode !== 'none' &&
      !this.canPlace(o, { x: o.x + dx, y: o.y + dy, w: o.w, h: o.h })
    ) {
      return false
    }
    this.doc = moveObjects(this.doc, [id], dx, dy)
    this.emitDoc()
    return true
  }

  /** Would `mover` (at the position/rotation it carries) illegally
      overlap a non-excluded solid? */
  private blockedBySolid(mover: WorldObject, exclude: ReadonlySet<string>): boolean {
    if (!mover.solid) return false
    const pts = footprintOf(mover)
    const idx = this.spatial()
    const cands = this.candidates(aabbOf(pts))
    return this.doc.objects.some(
      (o) =>
        o.solid === true &&
        !exclude.has(o.id) &&
        cands.has(o.id) &&
        polysIntersect(pts, idx.footprints.get(o.id)!) &&
        !this.canOverlap?.(mover, o),
    )
  }

  /** Nearest port to a screen point within PORT_TOL_PX, as an edge endpoint. */
  portAt(screenPt: Pt): EdgeEndpoint | null {
    const w = this.screenToWorld(screenPt)
    const tol = PORT_TOL_PX / (unitToPx(this.doc.units) * this.viewport.zoom)
    const cands = this.candidates({ x: w.x - tol, y: w.y - tol, w: 2 * tol, h: 2 * tol })
    let best: EdgeEndpoint | null = null
    let bd = tol
    for (const o of this.doc.objects) {
      if (!cands.has(o.id)) continue
      for (const p of o.ports ?? []) {
        const wp = objPoint(o, p.fx, p.fy)
        const d = Math.hypot(wp.x - w.x, wp.y - w.y)
        if (d <= bd) {
          bd = d
          best = { obj: o.id, port: p.id }
        }
      }
    }
    return best
  }

  /** Nearest edge to a screen point within EDGE_TOL_PX. */
  edgeAt(screenPt: Pt): Edge | null {
    const w = this.screenToWorld(screenPt)
    const tol = EDGE_TOL_PX / (unitToPx(this.doc.units) * this.viewport.zoom)
    let best: Edge | null = null
    let bd = tol
    for (const e of this.doc.edges) {
      if (this.edgeFilter && !this.edgeFilter(e)) continue
      const ends = edgeEndpoints(this.doc, e)
      if (!ends) continue
      const d = distToGeom(
        w,
        edgeGeom(ends.from, ends.to, e.route, this.edgeBendT(e), edgeAxis(this.doc, e), edgeOutwardDirs(this.doc, e) ?? undefined),
      )
      if (d <= bd) {
        bd = d
        best = e
      }
    }
    return best
  }

  /** Bend fraction used for route computation — the live gesture value
      while bending, the edge's stored `bend` (default 0.5) otherwise. */
  edgeBendT(e: Edge): number {
    return this.edgeBend && this.edgeBend.ids.includes(e.id)
      ? this.edgeBend.t
      : (e.bend ?? 0.5)
  }

  /** Begin a bend gesture — drag the trunk of an 'orthogonal'/'smoothstep'
      edge along the dominant axis. Extra ids returned by `bendGroup`
      follow in the same commit. */
  startBend(pt: Pt, edgeId: string): void {
    const e = this.doc.edges.find((e) => e.id === edgeId)
    if (!e || (e.route !== 'orthogonal' && e.route !== 'smoothstep')) return
    if (!edgeEndpoints(this.doc, e)) return
    const ids = [
      ...new Set([
        edgeId,
        ...(this.bendGroup ? [...this.bendGroup(e, this.doc)] : []),
      ]),
    ]
    this.mode = 'bend'
    this.edgeBend = { ids, t: e.bend ?? 0.5 }
    this.cursorWorld = this.screenToWorld(pt)
  }

  /** Begin a vertex gesture — drag anchor `index` of a shape-kind
      object. Each move patches the doc live; pointerUp commits once. */
  startVertexMove(pt: Pt, objId: string, index: number): void {
    const o = this.objById(objId)
    if (!o || o.locked || !isShapeKind(o.kind)) return
    if (index < 0 || index >= shapeAnchors(o).length) return
    this.mode = 'vertex'
    this.vertex = { id: objId, index }
    this.cursorWorld = this.screenToWorld(pt)
  }

  /** Insert a vertex into the single-selected curve/polygon at the
      nearest anchor segment to `pt` (screen px). Returns false when
      no eligible shape is selected or the point is off the outline. */
  insertShapeVertex(pt: Pt): boolean {
    if (this.selectedIds.size !== 1) return false
    const o = this.objById([...this.selectedIds][0])
    if (!o || o.locked) return false
    if (o.kind !== 'curve' && o.kind !== 'polygon') return false
    const anchors = shapeAnchors(o)
    if (anchors.length < 2) return false
    const w = this.screenToWorld(pt)
    const lp = o.rot ? invRotPt(w, objCenter(o), o.rot) : w
    const wp = anchors.map((p) => objPoint(o, p.fx, p.fy))
    const n = o.kind === 'polygon' ? wp.length : wp.length - 1
    const tol = HIT_TOL_PX / (unitToPx(this.doc.units) * this.viewport.zoom)
    let seg = -1
    let bd = tol
    for (let i = 0; i < n; i++) {
      const d = distToSegment(lp, wp[i], wp[(i + 1) % wp.length])
      if (d <= bd) {
        bd = d
        seg = i
      }
    }
    if (seg < 0) return false
    const next = docInsertShapePoint(this.doc, o.id, seg, lp)
    if (next === this.doc) return false
    this.doc = next
    this.emitDoc()
    return true
  }

  /** Delete anchor `index` of a shape object — respects the minimum
      anchor counts enforced by `removeShapePoint`. */
  deleteShapeVertex(id: string, index: number): void {
    const next = docRemoveShapePoint(this.doc, id, index)
    if (next === this.doc) return
    this.doc = next
    this.emitDoc()
  }

  /** Begin a multi-point shape gesture (P49). While `mode==='shape'`
      every left-button pointerDown appends a grid-snapped point —
      call `commitShapeDraw(id)` on Enter/dblclick to build the
      object, or `cancelShapeDraw` on Esc. */
  startShapeDraw(kind = 'curve'): void {
    this.mode = 'shape'
    this.shapeDraw = { kind, pts: [] }
    this.emit()
  }

  /** Finish the multi-point gesture: build the shape object under
      `id` (extra fields merged over the generated geometry), add it
      to the doc, and select it. Returns the created object, or null
      when fewer than two points were placed (gesture discarded). */
  commitShapeDraw(id: string, extra: Partial<WorldObject> = {}): WorldObject | null {
    const d = this.shapeDraw
    this.mode = 'idle'
    this.shapeDraw = null
    if (!d || d.pts.length < 2) {
      this.emit()
      return null
    }
    const x0 = Math.min(...d.pts.map((p) => p.x))
    const x1 = Math.max(...d.pts.map((p) => p.x))
    const y0 = Math.min(...d.pts.map((p) => p.y))
    const y1 = Math.max(...d.pts.map((p) => p.y))
    const w = Math.max(x1 - x0, MIN_SIZE)
    const h = Math.max(y1 - y0, MIN_SIZE)
    const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
    const o: WorldObject = {
      ...extra,
      id,
      kind: d.kind,
      x: x0,
      y: y0,
      w,
      h,
      shape: {
        points: d.pts.map((p) => ({
          fx: clamp01((p.x - x0) / w),
          fy: clamp01((p.y - y0) / h),
        })),
      },
    }
    this.doc = addObject(this.doc, o)
    this.emitDoc()
    this.setSelection([id])
    return o
  }

  /** Abort the in-progress multi-point gesture. */
  cancelShapeDraw(): void {
    if (!this.shapeDraw) return
    this.mode = 'idle'
    this.shapeDraw = null
    this.emit()
  }

  /** Begin a connect gesture from a port (or object center if port omitted).
      If `rewireEdge` returns an existing edge for the grabbed endpoint, the
      gesture rewires that edge instead of creating a new one. */
  startConnect(pt: Pt, obj: string, port?: string): void {
    const o = this.objById(obj)
    if (!o) return
    const ep: EdgeEndpoint = port ? { obj, port } : { obj }
    const re = this.rewireEdge?.(ep)
    const edge = re ? this.doc.edges.find((e) => e.id === re) : undefined
    this.mode = 'connect'
    this.connect = edge
      ? {
          from: ep,
          hover: null,
          invalid: false,
          rewire: { edge: edge.id, end: sameEndpoint(edge.from, ep) ? 'to' : 'from' },
        }
      : { from: ep, hover: null, invalid: false }
    this.cursorWorld = this.screenToWorld(pt)
  }

  /** Begin a rewire gesture on `edgeId` — the `end` endpoint follows the
      pointer until dropped on a port (retarget) or on empty canvas
      (disconnect). */
  startRewire(pt: Pt, edgeId: string, end: 'from' | 'to'): void {
    const edge = this.doc.edges.find((e) => e.id === edgeId)
    if (!edge) return
    this.mode = 'connect'
    this.connect = {
      from: edge[end],
      hover: null,
      invalid: false,
      rewire: { edge: edgeId, end },
    }
    this.cursorWorld = this.screenToWorld(pt)
  }

  /** The fixed end of the in-progress gesture — for a rewire, the side
      that isn't being dragged. */
  private connectAnchor(): EdgeEndpoint | null {
    const c = this.connect
    if (!c) return null
    if (!c.rewire) return c.from
    const e = this.doc.edges.find((e) => e.id === c.rewire!.edge)
    if (!e) return null
    return c.rewire.end === 'from' ? e.to : e.from
  }

  /** Order a fresh pair of endpoints into edge direction (connectOrient
      hook, or grab→drop when unset). Null = pair forbidden. */
  private orientedEnds(
    a: EdgeEndpoint,
    b: EdgeEndpoint,
  ): { from: EdgeEndpoint; to: EdgeEndpoint } | null {
    return this.connectOrient ? this.connectOrient(a, b) : { from: a, to: b }
  }

  /** Points for the live connect preview, or null. */
  connectPreview(): { from: Pt; to: Pt } | null {
    const c = this.connect
    if (!c) return null
    const loose =
      (c.hover ? endpointPos(this.doc, c.hover) : null) ?? this.cursorWorld
    if (c.rewire) {
      const anchor = this.connectAnchor()
      const ap = anchor ? endpointPos(this.doc, anchor) : null
      if (!ap) return null
      return c.rewire.end === 'from' ? { from: loose, to: ap } : { from: ap, to: loose }
    }
    const from = endpointPos(this.doc, c.from)
    return from ? { from, to: loose } : null
  }

  private nextEdgeId(): string {
    let n = 0
    for (const e of this.doc.edges) {
      const m = /^e(\d+)$/.exec(e.id)
      if (m) n = Math.max(n, Number(m[1]))
    }
    return `e${n + 1}`
  }

  // --- input (screen px, canvas-relative) ---

  /** Begin a resize gesture on `id`, moving the local-space edges given
      by `dir` (for a rotated object the handles ride its rotation, so
      `dir` is in the object's own axes). */
  startResize(pt: Pt, id: string, dir: ResizeDir): void {
    const o = this.objById(id)
    if (!o || o.locked || (dir.x === 0 && dir.y === 0)) return
    this.mode = 'resize'
    this.resizeId = id
    this.resizeDir = dir
    this.resizeOrig = { x: o.x, y: o.y, w: o.w, h: o.h }
    this.resizeCenter = objCenter(o)
    this.resizeRot = o.rot ?? 0
    this.cursorWorld = this.screenToWorld(pt)
  }

  /** Begin a rotate gesture on `id` (e.g. its rotate handle). */
  startRotate(pt: Pt, id: string): void {
    const o = this.objById(id)
    if (!o || o.locked) return
    this.mode = 'rotate'
    this.rotateId = id
    this.rotateOrig = o.rot ?? 0
    this.rotateCenter = objCenter(o)
    const w = this.screenToWorld(pt)
    this.rotateStartAng = Math.atan2(w.y - this.rotateCenter.y, w.x - this.rotateCenter.x)
    this.rotate = { id, deg: this.rotateOrig }
    this.cursorWorld = w
  }

  pointerDown(pt: Pt, opts: PointerOpts = {}): void {
    this.start = pt
    this.startWorld = this.screenToWorld(pt)
    this.cursorWorld = this.startWorld

    if (this.mode === 'shape' && this.shapeDraw) {
      if (opts.button === undefined || opts.button === 0) {
        const g = this.doc.grid
        const w = this.startWorld
        const sp =
          g.snap && g.size > 0
            ? {
                x: Math.round(w.x / g.size) * g.size,
                y: Math.round(w.y / g.size) * g.size,
              }
            : w
        const last = this.shapeDraw.pts[this.shapeDraw.pts.length - 1]
        if (!last || Math.hypot(sp.x - last.x, sp.y - last.y) > 1e-6) {
          this.shapeDraw.pts.push(sp)
        }
      }
      this.emit()
      return
    }

    if (opts.button === 1) {
      this.mode = 'pan'
      this.vpStart = { ...this.viewport }
      return
    }
    if (opts.button !== undefined && opts.button !== 0) return

    const hit = this.objectAt(pt)
    if (hit) {
      if (opts.additive) {
        if (this.selectedIds.has(hit.id)) this.selectedIds.delete(hit.id)
        else this.selectedIds.add(hit.id)
        this.emitSelection()
        return
      }
      if (!this.selectedIds.has(hit.id)) this.setSelection([hit.id])
      if (hit.locked || opts.noDrag) {
        // selectable but not draggable (locked, or .nodrag content)
        this.mode = 'idle'
        return
      }
      this.dragIds = opts.detached
        ? [hit.id]
        : this.expandDragIds(this.selectedIds)
      this.dragAnchor = { x: hit.x, y: hit.y }
      this.dragAnchorSize = { w: hit.w, h: hit.h }
      this.mode = 'drag'
      return
    }

    const edge = this.edgeAt(pt)
    if (edge) {
      // grabbing just off an endpoint picks that end up for rewiring
      // (the segment outside the object — ports themselves connect)
      const ends = edgeEndpoints(this.doc, edge)
      if (ends) {
        const tol = PORT_TOL_PX / (unitToPx(this.doc.units) * this.viewport.zoom)
        const df = Math.hypot(ends.from.x - this.startWorld.x, ends.from.y - this.startWorld.y)
        const dt = Math.hypot(ends.to.x - this.startWorld.x, ends.to.y - this.startWorld.y)
        if (Math.min(df, dt) <= tol) {
          this.startRewire(pt, edge.id, df <= dt ? 'from' : 'to')
          this.emit()
          return
        }
        // grabbing the trunk segment bends it; the click still selects
        if (edge.route === 'orthogonal' || edge.route === 'smoothstep') {
          const g = edgeGeom(
            ends.from,
            ends.to,
            edge.route,
            this.edgeBendT(edge),
            edgeAxis(this.doc, edge),
          )
          if (
            !opts.additive &&
            g.kind === 'polyline' &&
            g.pts.length === 4 &&
            distToSegment(this.startWorld, g.pts[1], g.pts[2]) <=
              EDGE_TOL_PX / (unitToPx(this.doc.units) * this.viewport.zoom)
          ) {
            if (!this.selectedIds.has(edge.id)) this.setSelection([edge.id])
            this.startBend(pt, edge.id)
            this.emit()
            return
          }
        }
      }
      if (opts.additive) {
        if (this.selectedIds.has(edge.id)) this.selectedIds.delete(edge.id)
        else this.selectedIds.add(edge.id)
        this.emitSelection()
      } else {
        this.setSelection([edge.id])
      }
      this.mode = 'idle'
      this.emit()
      return
    }

    this.mode = 'marquee'
    this.marquee = { x: this.startWorld.x, y: this.startWorld.y, w: 0, h: 0 }
    if (!opts.additive && this.selectedIds.size > 0) this.setSelection([])
    this.emit()
  }

  pointerMove(pt: Pt, opts: { angleSnap?: boolean } = {}): void {
    const w = this.screenToWorld(pt)
    this.cursorWorld = w

    if (this.mode === 'rotate' && this.rotateId && this.rotate) {
      const ang = Math.atan2(w.y - this.rotateCenter.y, w.x - this.rotateCenter.x)
      let deg = this.rotateOrig + ((ang - this.rotateStartAng) * 180) / Math.PI
      if (opts.angleSnap && this.rotateSnapDeg > 0) {
        deg = Math.round(deg / this.rotateSnapDeg) * this.rotateSnapDeg
      }
      deg = ((deg % 360) + 360) % 360
      this.rotate = { id: this.rotateId, deg }
      if (this.collisionMode !== 'none') {
        const o = this.objById(this.rotateId)
        this.dragInvalid =
          o !== undefined &&
          this.blockedBySolid({ ...o, rot: deg }, new Set([o.id]))
      }
      this.emit()
      return
    }

    if (this.mode === 'drag') {
      const g = this.doc.grid
      const tol = SNAP_TOL_PX / (unitToPx(this.doc.units) * this.viewport.zoom)
      const { xs, ys } = this.snapObjects
        ? this.snapTargets(new Set(this.dragIds))
        : { xs: [], ys: [] }
      const raw = { x: w.x - this.startWorld.x, y: w.y - this.startWorld.y }
      const ax = this.dragAnchor.x + raw.x
      const ay = this.dragAnchor.y + raw.y
      const { w: aw, h: ah } = this.dragAnchorSize
      let dx = raw.x
      let dy = raw.y
      this.guides = []
      const sx = snapEdges([ax, ax + aw / 2, ax + aw], xs, tol)
      if (sx) {
        dx += sx.adj
        this.guides.push({ axis: 'x', at: sx.at })
      } else if (g.snap && g.size > 0) {
        dx = Math.round(ax / g.size) * g.size - this.dragAnchor.x
      }
      const sy = snapEdges([ay, ay + ah / 2, ay + ah], ys, tol)
      if (sy) {
        dy += sy.adj
        this.guides.push({ axis: 'y', at: sy.at })
      } else if (g.snap && g.size > 0) {
        dy = Math.round(ay / g.size) * g.size - this.dragAnchor.y
      }
      this.dragDelta = { x: dx, y: dy }
      if (this.collisionMode !== 'none') {
        const moving = new Set(this.dragIds)
        this.dragInvalid = this.dragIds.some((id) => {
          const o = this.objById(id)
          return (
            o !== undefined &&
            this.blockedBySolid({ ...o, x: o.x + dx, y: o.y + dy }, moving)
          )
        })
      }
      this.emit()
      return
    }

    if (this.mode === 'marquee') {
      this.marquee = rectBetween(this.startWorld, w)
      const mq = rectPoly(this.marquee)
      const idx = this.spatial()
      const cands = this.candidates(this.marquee)
      const ids = new Set(
        this.doc.objects
          .filter(
            (o) =>
              cands.has(o.id) &&
              (!this.marqueeFilter || this.marqueeFilter(o)) &&
              polysIntersect(mq, idx.footprints.get(o.id)!),
          )
          .map((o) => o.id),
      )
      const groups = new Set(
        this.doc.objects.filter((o) => ids.has(o.id) && o.group).map((o) => o.group),
      )
      if (groups.size > 0) {
        for (const o of this.doc.objects) {
          if (o.group && groups.has(o.group)) ids.add(o.id)
        }
      }
      this.setSelection(ids)
      this.emit()
      return
    }

    if (this.mode === 'resize' && this.resizeOrig && this.resizeId) {
      const { resizeDir: dir, resizeOrig: orig } = this
      const g = this.doc.grid
      const tol = SNAP_TOL_PX / (unitToPx(this.doc.units) * this.viewport.zoom)
      const { xs, ys } = this.snapObjects
        ? this.snapTargets(new Set([this.resizeId]))
        : { xs: [], ys: [] }
      this.guides = []
      let wx = w.x
      let wy = w.y
      const sx = nearest(w.x, xs, tol)
      if (sx !== null) {
        wx = sx
        this.guides.push({ axis: 'x', at: sx })
      } else if (g.snap && g.size > 0) {
        wx = Math.round(w.x / g.size) * g.size
      }
      const sy = nearest(w.y, ys, tol)
      if (sy !== null) {
        wy = sy
        this.guides.push({ axis: 'y', at: sy })
      } else if (g.snap && g.size > 0) {
        wy = Math.round(w.y / g.size) * g.size
      }
      // rotated objects resize along their own axes — inverse-rotate the
      // pointer into the local frame, then run the usual rect math
      const lp = this.resizeRot
        ? invRotPt({ x: wx, y: wy }, this.resizeCenter, this.resizeRot)
        : { x: wx, y: wy }
      const r = { x: orig.x, y: orig.y, w: orig.w, h: orig.h }
      if (dir.x > 0) {
        r.x = Math.min(orig.x, lp.x)
        r.w = Math.max(Math.abs(lp.x - orig.x), MIN_SIZE)
      } else if (dir.x < 0) {
        const x1 = orig.x + orig.w
        r.x = Math.min(lp.x, x1)
        r.w = Math.max(Math.abs(x1 - lp.x), MIN_SIZE)
      }
      if (dir.y > 0) {
        r.y = Math.min(orig.y, lp.y)
        r.h = Math.max(Math.abs(lp.y - orig.y), MIN_SIZE)
      } else if (dir.y < 0) {
        const y1 = orig.y + orig.h
        r.y = Math.min(lp.y, y1)
        r.h = Math.max(Math.abs(y1 - lp.y), MIN_SIZE)
      }
      this.resize = { id: this.resizeId, rect: r }
      // aspect lock (resizeAspect hook): corner drags grow the free
      // axis to cover the pointer while holding h/w
      const ro = this.objById(this.resizeId)
      const ar = ro ? this.resizeAspect?.(ro) : undefined
      if (ar && ar > 0 && dir.x !== 0 && dir.y !== 0) {
        if (r.w * ar >= r.h) {
          const dh = r.w * ar - r.h
          r.h += dh
          if (dir.y < 0) r.y -= dh
        } else {
          const dw = r.h / ar - r.w
          r.w += dw
          if (dir.x < 0) r.x -= dw
        }
        this.resize = { id: this.resizeId, rect: r }
      }
      if (this.collisionMode !== 'none') {
        const mover = this.objById(this.resizeId)
        this.dragInvalid =
          mover !== undefined &&
          this.blockedBySolid({ ...mover, ...r }, new Set([this.resizeId]))
      }
      this.emit()
      return
    }

    if (this.mode === 'vertex' && this.vertex) {
      const g = this.doc.grid
      const tol = SNAP_TOL_PX / (unitToPx(this.doc.units) * this.viewport.zoom)
      const { xs, ys } = this.snapObjects
        ? this.snapTargets(new Set([this.vertex.id]))
        : { xs: [], ys: [] }
      this.guides = []
      let wx = w.x
      let wy = w.y
      const sx = nearest(w.x, xs, tol)
      if (sx !== null) {
        wx = sx
        this.guides.push({ axis: 'x', at: sx })
      } else if (g.snap && g.size > 0) {
        wx = Math.round(w.x / g.size) * g.size
      }
      const sy = nearest(w.y, ys, tol)
      if (sy !== null) {
        wy = sy
        this.guides.push({ axis: 'y', at: sy })
      } else if (g.snap && g.size > 0) {
        wy = Math.round(w.y / g.size) * g.size
      }
      const o = this.objById(this.vertex.id)
      if (o) {
        // rotated objects edit in their local frame — inverse-rotate
        // the (snapped) pointer about the current center
        const lp = o.rot
          ? invRotPt({ x: wx, y: wy }, objCenter(o), o.rot)
          : { x: wx, y: wy }
        this.patchDoc(setShapePoint(this.doc, o.id, this.vertex.index, lp))
      }
      return
    }

    if (this.mode === 'connect' && this.connect) {
      const c = this.connect
      const anchor = this.connectAnchor() ?? c.from
      const hover = this.portAt(pt)
      const h = hover && hover.obj !== anchor.obj ? hover : null
      let invalid = false
      if (h) {
        const pair = c.rewire
          ? c.rewire.end === 'from'
            ? { from: h, to: anchor }
            : { from: anchor, to: h }
          : this.orientedEnds(c.from, h)
        invalid =
          pair === null ||
          (!!this.canConnect && !this.canConnect(pair.from, pair.to))
      }
      this.connect = { ...c, hover: h, invalid, overPort: hover !== null }
      this.emit()
      return
    }

    if (this.mode === 'bend' && this.edgeBend) {
      const e = this.doc.edges.find((x) => x.id === this.edgeBend!.ids[0])
      const ends = e ? edgeEndpoints(this.doc, e) : null
      if (e && ends) {
        const hDom = edgeAxis(this.doc, e) === 'h'
        const base = hDom ? ends.from.x : ends.from.y
        const span = hDom ? ends.to.x - ends.from.x : ends.to.y - ends.from.y
        const cur = hDom ? w.x : w.y
        let t = span !== 0 ? (cur - base) / span : 0.5
        // snap to a sibling trunk: a bendable edge sharing the same source
        this.guides = []
        const tol = SNAP_TOL_PX / (unitToPx(this.doc.units) * this.viewport.zoom)
        const ids = new Set(this.edgeBend.ids)
        for (const s of this.doc.edges) {
          if (
            ids.has(s.id) ||
            (s.route !== 'orthogonal' && s.route !== 'smoothstep') ||
            s.from.obj !== e.from.obj ||
            s.from.port !== e.from.port
          ) {
            continue
          }
          const se = edgeEndpoints(this.doc, s)
          if (!se) continue
          const sHDom = edgeAxis(this.doc, s) === 'h'
          const sSpan = hDom ? se.to.x - se.from.x : se.to.y - se.from.y
          if (sHDom !== hDom || sSpan === 0) continue
          const trunk = (hDom ? se.from.x : se.from.y) + sSpan * (s.bend ?? 0.5)
          if (Math.abs(trunk - cur) <= tol) {
            t = (trunk - base) / span
            this.guides.push({ axis: hDom ? 'x' : 'y', at: trunk })
            break
          }
        }
        this.edgeBend = { ...this.edgeBend, t: Math.min(1, Math.max(0, t)) }
      }
      this.emit()
      return
    }

    if (this.mode === 'pan' && this.vpStart) {
      this.viewport = {
        ...this.vpStart,
        x: this.vpStart.x + pt.x - this.start.x,
        y: this.vpStart.y + pt.y - this.start.y,
      }
      this.emit()
      return
    }

    this.emit()
  }

  pointerUp(): void {
    // multi-point draw survives clicks — only commit/cancel ends it
    if (this.mode === 'shape') {
      this.emit()
      return
    }
    const blocked = this.collisionMode === 'reject' && this.dragInvalid
    if (this.mode === 'drag' && this.dragDelta && !blocked) {
      const { x: dx, y: dy } = this.dragDelta
      if (dx !== 0 || dy !== 0) {
        this.doc = moveObjects(this.doc, this.dragIds, dx, dy)
        this.emitDoc()
      }
    }
    if (this.mode === 'rotate' && this.rotate && !blocked) {
      const o = this.objById(this.rotate!.id)
      if (o && this.rotate.deg !== (o.rot ?? 0)) {
        this.doc = rotateObject(this.doc, o.id, this.rotate.deg)
        this.emitDoc()
      }
    }
    if (this.mode === 'resize' && this.resize && this.resizeOrig && !blocked) {
      const r = this.resize.rect
      const o = this.resizeOrig
      if (r.x !== o.x || r.y !== o.y || r.w !== o.w || r.h !== o.h) {
        this.doc = resizeObject(this.doc, this.resize.id, r)
        this.emitDoc()
      }
    }
    if (this.mode === 'connect' && this.connect) {
      const c = this.connect
      const re = c.rewire
        ? this.doc.edges.find((e) => e.id === c.rewire!.edge)
        : undefined
      if (c.rewire && re) {
        if (c.hover && !c.invalid) {
          const anchor = this.connectAnchor()!
          const target =
            c.rewire.end === 'from'
              ? { from: c.hover, to: anchor }
              : { from: anchor, to: c.hover }
          if (!sameEndpoint(target.from, re.from) || !sameEndpoint(target.to, re.to)) {
            const drop = [
              ...(this.connectReplace?.(target.from, target.to) ?? []),
            ].filter((id) => id !== re.id)
            let doc = drop.length > 0 ? removeEdges(this.doc, drop) : this.doc
            doc = retargetEdge(doc, re.id, target.from, target.to)
            this.doc = doc
            this.emitDoc()
          }
        } else if (!c.hover && !c.overPort) {
          // dropped on empty canvas — detach the wire
          this.doc = removeEdges(this.doc, [re.id])
          this.emitDoc()
        }
        // invalid hover → gesture cancels, the edge is left unchanged
      } else if (!c.rewire && c.hover && !c.invalid) {
        const pair = this.orientedEnds(c.from, c.hover)
        if (pair) {
          const edge: Edge = {
            ...this.connectEdge,
            id: this.nextEdgeId(),
            from: pair.from,
            to: pair.to,
            route: this.connectEdge?.route ?? this.connectRoute,
          }
          const drop = this.connectReplace
            ? [...this.connectReplace(pair.from, pair.to)]
            : []
          let doc = drop.length > 0 ? removeEdges(this.doc, drop) : this.doc
          doc = addEdge(doc, edge)
          this.doc = doc
          this.emitDoc()
        }
      }
    }
    if (this.mode === 'bend' && this.edgeBend) {
      const b = this.edgeBend
      const set = new Set(b.ids)
      const changed = this.doc.edges.some(
        (e) => set.has(e.id) && (e.bend ?? 0.5) !== b.t,
      )
      if (changed) {
        this.doc = bendEdges(this.doc, b.ids, b.t)
        this.emitDoc()
      }
    }
    if (this.mode === 'vertex' && this.vertex) {
      // folds the live patchDoc edits into one undoable commit
      this.commitDoc()
    }
    this.mode = 'idle'
    this.dragDelta = null
    this.dragIds = []
    this.dragInvalid = false
    this.guides = []
    this.connect = null
    this.edgeBend = null
    this.resize = null
    this.resizeId = null
    this.resizeOrig = null
    this.vertex = null
    this.marquee = null
    this.rotate = null
    this.rotateId = null
    this.emit()
  }

  /** Selection-expanded drag set: same-group members, minus locked. */
  private expandDragIds(ids: Iterable<string>): string[] {
    const set = new Set(ids)
    const groups = new Set(
      this.doc.objects.filter((o) => set.has(o.id) && o.group).map((o) => o.group),
    )
    for (const o of this.doc.objects) {
      if (o.group && groups.has(o.group)) set.add(o.id)
    }
    return [...set].filter((id) => !this.lockedById(id))
  }

  /** World-space bounding box of the selected objects, or null.
      Rotated objects contribute their OBB's axis-aligned bounds. */
  selectionBounds(): Rect | null {
    const objs = this.doc.objects.filter((o) => this.selectedIds.has(o.id))
    if (objs.length === 0) return null
    return aabbOf(objs.flatMap((o) => footprintOf(o)))
  }

  private snapTargets(exclude: Set<string>): { xs: number[]; ys: number[] } {
    const xs: number[] = [...this.snapExtra.xs]
    const ys: number[] = [...this.snapExtra.ys]
    const p = this.doc.page
    if (p) {
      xs.push(p.x, p.x + p.w / 2, p.x + p.w)
      ys.push(p.y, p.y + p.h / 2, p.y + p.h)
    }
    for (const o of this.doc.objects) {
      if (exclude.has(o.id)) continue
      const corners = footprintOf(o)
      for (const pt of corners) {
        xs.push(pt.x)
        ys.push(pt.y)
      }
      for (let i = 0; i < corners.length; i++) {
        const a = corners[i]
        const b = corners[(i + 1) % corners.length]
        xs.push((a.x + b.x) / 2)
        ys.push((a.y + b.y) / 2)
      }
      const c = objCenter(o)
      xs.push(c.x)
      ys.push(c.y)
      for (const sp of shapeSnapPoints(o)) {
        xs.push(sp.x)
        ys.push(sp.y)
      }
    }
    return { xs, ys }
  }

  /** Pan the viewport by screen-px deltas (e.g. trackpad scroll). */
  panBy(dx: number, dy: number): void {
    this.viewport = { ...this.viewport, x: this.viewport.x - dx, y: this.viewport.y - dy }
    this.emit()
  }

  wheel(pt: Pt, deltaY: number): void {
    const zoom = Math.min(
      ZOOM_MAX,
      Math.max(ZOOM_MIN, this.viewport.zoom * Math.pow(1.0015, -deltaY)),
    )
    if (zoom === this.viewport.zoom) return
    const w = this.screenToWorld(pt)
    const u = unitToPx(this.doc.units) * zoom
    this.viewport = {
      zoom,
      x: pt.x - w.x * u,
      y: this.doc.origin === 'top-left' ? pt.y - w.y * u : pt.y + w.y * u,
    }
    this.emit()
  }
}

function sameEndpoint(a: EdgeEndpoint, b: EdgeEndpoint): boolean {
  return a.obj === b.obj && a.port === b.port
}

/** Nearest candidate to `v` within `tol`, or null. */
function nearest(v: number, cands: number[], tol: number): number | null {
  let best: number | null = null
  let bd = tol
  for (const c of cands) {
    const d = Math.abs(c - v)
    if (d <= bd) {
      bd = d
      best = c
    }
  }
  return best
}

/**
 * Snap any of the moving `edges` to the nearest candidate within `tol`.
 * Returns the adjustment to apply to the gesture and the target line.
 */
function snapEdges(
  edges: number[],
  cands: number[],
  tol: number,
): { adj: number; at: number } | null {
  let best: { adj: number; at: number } | null = null
  for (const e of edges) {
    for (const c of cands) {
      const adj = c - e
      if (Math.abs(adj) <= tol && (!best || Math.abs(adj) < Math.abs(best.adj))) {
        best = { adj, at: c }
      }
    }
  }
  return best
}
