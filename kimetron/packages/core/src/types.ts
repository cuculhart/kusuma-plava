export type Unit = 'mm' | 'cm' | 'm' | 'inch' | 'px'
export type Origin = 'bottom-left' | 'top-left'

export interface GridConfig {
  size: number
  snap: boolean
  /** Major grid interval in cells — every Nth grid line renders bold
      (e.g. size=10, major=10 → a bold line every 100 mm). */
  major?: number
  /** Canvas background pattern — 'lines' (default), 'dashed',
      'cross' (small + at cell corners), 'dots' (React Flow-style
      dots). Display only, never affects snapping. */
  pattern?: 'lines' | 'dashed' | 'cross' | 'dots'
  /** Grid color — a literal CSS color used by every pattern.
      When unset, 'lines'/'dots' resolve --ki-grid / --ki-grid-major
      and the data-URI patterns ('dashed'/'cross') use the built-in
      default. Set this when the grid color must live in the doc. */
  color?: string
}

export interface WorldConfig {
  units?: Unit
  origin?: Origin
  grid?: Partial<GridConfig>
}

export interface Pt {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Port {
  id: string
  /** Position as a fraction of the object's size, 0..1.
      World position = (o.x + fx*o.w, o.y + fy*o.h) — tracks resizes. */
  fx: number
  fy: number
}

export interface WorldObjectStyle {
  /** CSS color string, e.g. '#fef3c7' or 'var(--fill)'. */
  fill?: string
  /** Border (stroke) color. */
  stroke?: string
  /** Stroke width in screen px — meaningful for shape kinds. */
  width?: number
  /** stroke-dasharray pattern for shape kinds, e.g. [4, 4]. */
  dash?: number[]
  /** Start cap for 'line'/'curve' kinds. */
  capStart?: EdgeMarker
  /** End cap for 'line'/'curve' kinds. */
  capEnd?: EdgeMarker
  /** Double-stroke rendering (outer = stroke color, inner = `--ki-bg`). */
  double?: boolean
}

/** A shape anchor as a fraction of the object's bounding box, 0..1 —
    same normalization as Port, so anchors track resizes. */
export interface ShapePoint {
  fx: number
  fy: number
}

/** Kind-specific geometry inside the x/y/w/h bounding box. */
export interface ObjectShape {
  /** 'line': exactly 2 points — a chord across the box (default:
      the (0,0)→(1,1) diagonal). 'curve': 2+ anchors — an open
      Catmull-Rom curve passing through all of them. */
  points?: ShapePoint[]
  /** 'arc': start angle in degrees, world space (+x = 0°, CCW). */
  a0?: number
  /** 'arc': end angle in degrees. a0 === a1 draws a full ellipse ring. */
  a1?: number
}

export interface WorldObject {
  id: string
  kind: string
  x: number
  y: number
  w: number
  h: number
  /** Rotation in degrees, world space, about the bbox center.
      x/y/w/h always describe the unrotated box — rot spins it. */
  rot?: number
  ports?: Port[]
  style?: WorldObjectStyle
  shape?: ObjectShape
  /** Group id — objects sharing one move together on drag.
      Alt+drag detaches the gesture to the hit object only. */
  group?: string
  /** Locked objects can be selected but not moved/resized/removed. */
  locked?: boolean
  /** Objects with occupancy — two solids may not overlap
      (see Engine.collisionMode / canOverlap). */
  solid?: boolean
  /** Category layer — render order = layer asc, then array order;
      hit-testing walks the reverse order. */
  layer?: number
  data?: unknown
}

export type EdgeRoute = 'straight' | 'orthogonal' | 'smoothstep' | 'bezier'

export interface EdgeStyle {
  /** CSS color string, e.g. '#b45309' or 'var(--dep)'. */
  color?: string
  /** Stroke width in screen px — a semantic attribute, not world size. */
  width?: number
  /** stroke-dasharray pattern, e.g. [4, 4] for dashed. */
  dash?: number[]
  /** Double-stroke rendering (outer = color, inner = `--ki-bg`). */
  double?: boolean
}

export type EdgeMarker = 'arrow' | 'dot'

export interface EdgeEndpoint {
  obj: string
  /** Port id; omitted = object center. */
  port?: string
}

export interface Edge {
  id: string
  from: EdgeEndpoint
  to: EdgeEndpoint
  route?: EdgeRoute
  /** Trunk position for 'orthogonal'/'smoothstep' routes — a fraction
      0..1 along the dominant axis from `from` to `to` (default 0.5). */
  bend?: number
  style?: EdgeStyle
  markerStart?: EdgeMarker
  markerEnd?: EdgeMarker
  label?: string
}

export interface Viewport {
  x: number
  y: number
  zoom: number
}

export interface Doc {
  schemaVersion: number
  units: Unit
  origin: Origin
  grid: GridConfig
  objects: WorldObject[]
  edges: Edge[]
  /** Optional paper frame in world coords — rendered backmost,
      its edges join the object-snap targets. */
  page?: Rect
}
