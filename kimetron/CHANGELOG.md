# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.6.1] - 2026-10-29

### Added

- `@kimetron/dom`, `@kimetron/react`: the object frame (`.ki-obj`
  border used by rect and other non-shape objects) now honors
  `style.dash` — a dash pattern maps to `borderStyle`
  (`dotted` when the first dash length is ≤ 2px, `dashed`
  otherwise). Shape outlines already painted `dash` via
  `stroke-dasharray`; the DOM border path did not.

## [1.6.0] - 2026-10-28

### Added

- Multi-point shape draw (P49): `Engine.startShapeDraw(kind)` arms a
  `'shape'` mode where each left-button `pointerDown` appends a
  grid-snapped point. `commitShapeDraw(id, extra?)` builds the
  object (2+ points; `shape.points` normalized into the bounding
  box) and selects it; `cancelShapeDraw()` aborts. The gesture
  survives click chains — `pointerUp` no longer ends the mode.
  `engine.shapeDraw` exposes `{ kind, pts }` for previews.
- `Engine.resizeAspect` hook — return an h/w ratio for an object
  and corner resizes grow the free axis to cover the pointer while
  preserving the ratio (edge drags stay free).

### Fixed

- Cap markers (arrow/dot) on edges and shapes now scale with the
  stroke width. `markerUnits` stays `userSpaceOnUse` but the marker
  viewport carries a `viewBox`, so the glyph grows proportionally
  for strokes above ~2px — thick lines no longer bury their caps.
- Object elements now carry `data-ki-obj` (same id as `data-id`).
  DOM-level `closest('[data-ki-obj]')` lookups — used by drivers for
  context menus and click routing — previously resolved only via
  chrome elements (handles/vertices/ports), so right-clicks on an
  unselected shape could not identify their object.

## [1.5.0] - 2026-10-27

### Added

- Shape vertex editing (P48): the single-selected shape object
  (line/curve/polygon) now shows a `.ki-vtx` grip per anchor. Dragging
  a grip runs a `vertex` mode gesture — pointer position honors
  grid/object snap with guides, rotated objects edit in their local
  frame, and every move patches the doc live (`patchDoc`) so the grip
  drag commits as one undoable step (`commitDoc` on pointerUp).
  Double-clicking a grip deletes the anchor (minimum counts are kept:
  curve ≥ 2, polygon ≥ 3); double-clicking the outline of a selected
  curve/polygon inserts an anchor on the nearest segment.
- `@kimetron/core`: `setShapePoint` / `insertShapePoint` /
  `removeShapePoint` — move/insert/delete a shape anchor and
  re-normalize the object's bbox (degenerate axes collapse to
  fraction 0.5). Plus `Engine.startVertexMove`,
  `Engine.insertShapeVertex`, `Engine.deleteShapeVertex` and the
  `'vertex'` mode.
- `@kimetron/dom`: `vertexHandlePoints` — screen-space grip points
  riding the object's rotation. `input.ts` routes pointerdown on
  `[data-ki-vtx]` and dblclick on grips/outline (deferred pointer
  capture so click/dblclick still reach the handle).

### Fixed

- `@kimetron/dom`, `@kimetron/react`: shape `<svg>` viewports are
  clamped to a 1px minimum. An `<svg>` element with a zero (or
  sub-pixel) width/height disables rendering entirely —
  `overflow: visible` cannot rescue it — so a line or shape resized to
  a degenerate bbox (e.g. zero height) vanished. The chord now keeps
  painting. (Reported from silim-murlun: horizontal/vertical lines
  disappear after resizing one dimension to zero.)

## [1.4.1] - 2026-10-27

### Fixed

- `@kimetron/dom`, `@kimetron/react`: non-shape object frames now use
  `style.width` for their border width instead of the fixed 1px from
  `.ki-obj`. Objects with `style.width: 0` no longer show a stray thin
  frame. (Reported from silim-murlun: a rectangle with stroke width 0
  still showed a faint border.)

## [1.4.0] - 2026-10-25

### Added

- `GridConfig.pattern: 'lines' | 'dashed' | 'cross' | 'dots'` and
  `GridConfig.color` — `gridBackground` can now draw grid lines,
  dashed lines, small crosses, or React Flow-style dots per cell
  corner, in a doc-chosen color. `'dashed'`/`'cross'` render via an
  inline SVG tile (they can't be built from plain CSS gradients and
  therefore need a literal color — unset `color` falls back to the
  built-in default there, while 'lines'/'dots' keep honoring the
  `--ki-grid` / `--ki-grid-major` CSS vars). Default stays `'lines'`;
  display only, snapping is unaffected (backlog P47, from the
  plesfeda v1 port).

### Fixed

- `@kimetron/core`, `@kimetron/dom`: bezier edges whose endpoints sit
  on ports now place their control points along the **port outward
  normals** (`edgeOutwardDirs`, exported alongside a new `portNormal`)
  instead of halfway along the endpoint delta. Sibling links that leave
  and enter on the same side (e.g. `r`→`l` while the target is below)
  used to kink back inside the card; they now sweep out in the classic
  S-curve. Portless endpoints keep the delta-based controls. Rendering
  and hit-testing share the updated geometry.
  Found during the plesfeda v1 port (finish-to-start deps between
  siblings looked angular instead of curved).

- `@kimetron/dom`, `@kimetron/react`: per-edge `Edge.style`
  (`color`/`width`/`dash`) never rendered — the `.ki-edge` CSS rule set
  `stroke`/`stroke-width` as *properties*, which beat the `stroke`
  presentation attributes the renderers emitted, so every edge drew in
  the default gray regardless of its style (markers were unaffected —
  they already resolve color into an inline style). The defaults moved
  to attribute fallbacks (`EDGE_LINE`, 1.5) so per-edge styles apply,
  and `.ki-edge.ki-sel` still overrides for the selected state.
  Found during the plesfeda v1 port (dep edges should have been brown
  1.8px but drew as gray 1.5px).

## [1.3.0] - 2026-10-25

### Fixed

- `@kimetron/core`: spatial index for physical queries —
  `objectsIn`/`collisions`/`canPlace`/`tryMove`/`objectAt`/`portAt`
  and the marquee ran a linear `doc.objects` scan with a
  `footprintOf` + `polysIntersect` per object on every call, so
  hundreds of objects made each query O(doc) with heavy constant
  factors (a downstream movement-arbitration layer calls these
  per-intent per-tick and stalled frames). A lazily-built per-doc
  index — id map, uniform AABB hash grid with an adaptive cell
  size and an always-candidates bucket for oversized objects, and
  cached footprints — now narrows candidates first; the exact
  tests still decide, and results keep doc-registration order
  (backlog P46, escalated via sagbal)
- `kimetron-drivers`: pinned workspace dependencies `@kimetron/core`,
  `@kimetron/dom`, `@kimetron/react` to `1.2.0`. They were left at
  `1.1.0` after the 1.2.0 release, which no longer matched the
  workspace versions and made `npm install` / `npm update` resolve
  them from the registry (404) instead of linking the workspaces.

## [1.2.0] - 2026-10-20

### Added

- `@kimetron/core`: `PointerOpts.noDrag` — pointer-down on `.nodrag`
  content / form elements (`input`, `select`, `textarea`,
  `contenteditable`) inside a custom-rendered object applies selection
  but never arms a move/marquee gesture, leaving native focus,
  text-selection and click behavior intact
- `@kimetron/core`: `Engine.snapObjects` flag — toggles object-edge/
  center snapping during drag and resize independently of
  `doc.grid.snap`; set `false` to disable snapping entirely
- `@kimetron/core`: `Engine.hitFilter` hook — excludes objects from
  pointer hit-testing (e.g. a strokes-only edit mode, or click-through
  zones handled by their own chrome)
- `@kimetron/core`: `Engine.marqueeFilter` hook — excludes objects from
  marquee selection (e.g. zones selectable only via their own chrome)
- `@kimetron/core`: `Engine.edgeFilter` hook — excludes edges from
  `edgeAt` hit-testing, so hidden wires can't be clicked, bent or
  rewired (e.g. a wires-hidden "final figure" view)
- `@kimetron/core`: `Engine.hitPriority` hook — when several objects
  overlap at a click point, the highest rank wins (ties keep render
  order, topmost first); lets apps deprioritize background linework
  without removing it from hit-testing entirely
- `@kimetron/core`: `Engine.patchDoc` / `Engine.commitDoc` — swap the
  doc without a history commit for gesture-live previews, then fold the
  edits into one undo step at gesture end (`commitDoc` no-ops when
  nothing changed)
- `@kimetron/core`: `Engine.mode` is now public and the `Mode` type is
  exported, so apps can observe the current gesture state
- `@kimetron/react`: `.ki-obj` elements now carry `data-ki-obj` (object
  id, lets input routing find the owning object of `.nodrag` content)
  and a `ki-kind-{kind}` class (per-kind CSS hooks)

### Fixed

- `@kimetron/dom`: pointer capture is deferred to the first
  pointermove. Capturing on pointerdown retargeted pointerup to the
  canvas and `preventDefault` suppressed compatibility mouse events,
  so click/dblclick inside objects (tool buttons, inline editors,
  selects) never fired

## [1.1.0] - 2026-10-20

### Added

- `@kimetron/core`: `connectOrient(a, b)` hook — imposes direction on a
  fresh connection regardless of drag direction (e.g. always out→in, so a
  drag starting on an input port still creates the wire out→in). Returns
  the ordered {from,to} or null to forbid the pair; the hovered target is
  flagged `invalid` when it returns null
- `@kimetron/core`: edge rewiring — `rewireEdge(ep)` hook picks up an
  existing wire when a gesture starts on an occupied endpoint (the end
  matching `ep` stays anchored, the other end follows the pointer);
  `startRewire(pt, edgeId, end)` and grabbing a wire's endpoint just off
  the object start the same gesture programmatically/from the canvas.
  Dropping on a port retargets, dropping on empty canvas detaches
  (undoable); `engine.retargetEdge(id, from, to)` and the `retargetEdge`
  doc op cover the gesture-less path
- `drivers/sethera`: bidirectional wiring (`connectOrient`) — drag from a
  calc input back to a parent `out` port connects out→in; grabbing an
  occupied input (`rewireEdge` via `rewirePickup`) or a wire's end rewires
  it, empty-canvas drop detaches
- `@kimetron/core`: `Edge.bend` — trunk position of 'orthogonal'/
  'smoothstep' routes as a fraction 0..1 along the dominant axis
  (default 0.5, serialized). Bend gesture: `startBend(pt, edgeId)`, live
  `engine.edgeBend` preview, sibling-trunk snapping with guides, and the
  `bendGroup` hook + `bendEdges` doc op so edges sharing one trunk move
  in a single commit; `engine.edgeBendT` resolves the effective fraction
- `@kimetron/dom`/`@kimetron/react`: grabbing the trunk segment of an
  'orthogonal'/'smoothstep' edge bends it directly (the click still
  selects); a `.ki-bend` handle at the trunk midpoint of a selected
  bendable edge (`data-ki-bend` + `data-ki-edge`) offers the same
  gesture — the trunk slides between parent and child only
- `drivers/plesfeda`: `bendGroup` groups sibling hier edges, so the
  shared bracket trunk moves as one when its handle is dragged
- `@kimetron/core`: `edgeAxis(doc, e)` / `portFacingAxis(o, portId)` —
  the 'orthogonal'/'smoothstep' dominant axis now resolves from port
  facing first (an r→l edge keeps a vertical trunk even when the target
  sits far above/below, so tree brackets no longer collapse into a
  per-edge staircase); portless endpoints keep the endpoint-delta
  heuristic. `edgeGeom`/`routePathD` accept an axis override and the
  bend gesture, trunk hit-test, handle and sibling snapping all follow
  it

## [1.0.0] - 2026-10-16

### Added

- `@kimetron/core`: `kind:'polygon'` — `shape.points` interpreted as a
  closed polygon (normalized anchors, ≥3 points). Polygon hit test
  (interior, concave-aware), vertex snap targets, `footprintOf` for the
  collision footprint; `polysIntersect` generalized to concave loops
  via proper edge crossing + containment (edge-touching still legal)
- `@kimetron/core`: `objectsIn(rect, exclude?)` — footprint query
  that returns non-solid objects too (`collisions` is its solid-only
  view). `canPlace(o, rect?)` — pure geometry/policy check honoring
  `canOverlap`; `tryMove(id, dx, dy)` — programmatic move through the
  collision policy (rejects on lock/missing or illegal overlap when
  `collisionMode` isn't `'none'`)
- `@kimetron/dom`: `polygon` renders as a closed path
- `drivers/game` — game spike: two 300 mm units wander a building via
  `tryMove` (walls/rocks block, the gate zone is the only way out,
  units can't stack), locked polygon rocks, patterned pond, adjacency
  rings + effect link when units come within range

## [0.9.0] - 2026-10-16

### Added

- `@kimetron/core`: `WorldObject.rot` — rotation in world CCW degrees
  about the bbox center (`x/y/w/h` stay the unrotated box). Geometry
  helpers `rotPt`/`invRotPt`/`objCenter`/`objPoint`/`obbOf`/`aabbOf`/
  `rectPoly`/`polysIntersect` (SAT); `rotateObject` doc op
- `@kimetron/core`: rotation-aware engine — hit-test inverse-rotates
  the query point (shape kinds included), `collisions`/marquee use the
  OBB via SAT (edge-touching still legal), snap targets include rotated
  vertices/edge midpoints/center, ports and edge endpoints resolve
  through rotation, `selectionBounds` is the rotated AABB
- `@kimetron/core`: rotate gesture — `startRotate(pt, id)` +
  `engine.rotate` preview, committed on pointerUp; `rotateSnapDeg`
  (default 15) applies while `pointerMove`'s `angleSnap` opt is held
  (Shift). Resizing a rotated object works in its local axes; the
  center-pivot convention means the opposite corner drifts in world
- `@kimetron/dom`/`@kimetron/react`: objects render with
  `rotate()` appended to their translate; `handlePointsFor` puts the 8
  resize handles on the rotated corners with angle-aware cursors;
  `.ki-rot` rotate handle (`data-ki-rotate`) above the selected object;
  HUD shows degrees while rotating; `screenRotDeg` helper
- `drivers/plan`: a 45° diagonal partition wall (+斜め壁 spawn button),
  a rotated chair, and a compass object proving rot rides selection,
  handles, snap and collision; canvas inset under the rulers so
  content can't hide beneath them; startup scale 1:20

## [0.8.0] - 2026-10-16

### Added

- `@kimetron/dom`: `rulerTicks(engine, axis, spanPx)` — world-unit
  ruler tick marks with automatic "nice" step selection and major
  labels (CAD ruler overlay primitive)
- `drivers/plan`: canvas-edge rulers (top/left), `dim` kind objects
  (extension lines, double-arrow dimension line, live mm text,
  own-span measurement; spawn matched to the selection's span via
  +H寸法/+V寸法), wall core lines (壁芯 — dash-dot on the long axis;
  dims snap onto cores via existing center snap), and architectural
  area readouts derived from the wall layout — 敷地 (site) /
  建築 (outer-face envelope) / 床壁芯 (core-line) / 床内法
  (inner-face), minus interior partitions; wall area nets out door
  openings

## [0.7.0] - 2026-10-16

### Added

- `@kimetron/core`: `WorldObject.solid` — objects with occupancy; two
  solids may not overlap (edge-touching is legal). `collisionMode`
  (`'none'`/`'flag'`/`'reject'`, default `'none'`) and the
  `engine.canOverlap` pair exception hook; `dragInvalid` marks
  colliding gestures. `engine.collisions(rect)` query
- `@kimetron/core`: `WorldObject.layer` — category layer ordering
  (render = layer asc, then array order; hit-test walks the reverse);
  `renderOrder()` helper; `Doc.grid.major` — every Nth grid cell
- `@kimetron/dom`/`@kimetron/react`: major grid lines render bold;
  colliding drag/resize previews show a danger outline
- `drivers/plan`: floor-plan spike — 10 mm grid with 100 mm major
  lines, thickness×length walls with "|-" T junctions, solid
  furniture rejected on walls, doors allowed on walls via
  `canOverlap`

## [0.6.0] - 2026-10-16

### Added

- `@kimetron/core`: `WorldObject.locked` (selectable but not
  movable/resizable/removable) and `WorldObject.group` (dragging one
  member drags the whole group; Alt+drag detaches; marquee selection
  expands to groups)
- `@kimetron/core`: `Doc.page` — a world-space paper frame; its edges
  join snap targets automatically, plus `engine.snapExtra` for
  app-injected snap candidates
- `@kimetron/core`: `engine.connectReplace` hook — edges it returns
  are removed in the same commit as a new connection (one-wire-per-
  input replace semantics); `rectContains`/`rectOverlapArea` helpers
- `@kimetron/core`: `EdgeStyle`/`WorldObjectStyle` `double` flag for
  double-stroke lines; `engine.selectionBounds()`
- `@kimetron/dom`/`@kimetron/react`: `doc.page` renders as a backmost
  paper frame; double strokes draw two rails; a HUD chip shows
  position/size readouts while dragging or resizing
- `drivers/sethera`: locked piece, grouped pair, page frame,
  replace-on-occupied-input wiring, double rule — the remaining
  sethera migration features

## [0.5.0] - 2026-10-16

### Added

- `@kimetron/core`: shape kinds — `line` (chord across the bbox),
  `curve` (open Catmull-Rom through normalized anchors),
  `ellipse` (inscribed in the bbox), `arc` (sweep of the inscribed
  ellipse, `shape.a0`/`a1` in world degrees, `a0===a1` = full ring).
  `ObjectShape`/`ShapePoint` types; kind-aware `hitObject` (lines hit
  on the stroke only, unfilled ellipses on the ring); shape anchors
  join object-snap targets; `shape` serialized (schemaVersion 2)
- `@kimetron/core`: `WorldObjectStyle` gains `width`/`dash`/
  `capStart`/`capEnd` (`'arrow'` | `'dot'`) for shape strokes
- `@kimetron/dom`/`@kimetron/react`: shape kinds render as an inline
  `<svg>` inside the object frame (z-order preserved); caps reuse the
  edge `<marker>` machinery; selection shows a dashed bbox
- `drivers/sethera`: sethera-piece migration spike — pieces, Σ zone
  aggregation, calc wiring with directed `out`→`a`/`b` ports via
  `canConnect`, plus a line/ellipse/arc/curve shape gallery

## [0.4.0] - 2026-10-16

### Added

- `@kimetron/core`: edge/object styling as data — `Edge.style`
  (`color`, `width` in screen px, `dash`), `Edge.markerStart` /
  `markerEnd` (`'arrow'` | `'dot'`), `WorldObject.style`
  (`fill`, `stroke`); all serialized with the document
- `@kimetron/core`: new route `smoothstep` (orthogonal geometry,
  rounded corners at render), `engine.canConnect` policy hook
  (rejects commit and flags `connect.invalid`), `engine.connectEdge`
  defaults stamped onto gesture-created edges
- `@kimetron/dom`/`@kimetron/react`: edge rendering maps style to
  stroke attributes, generates SVG `<marker>` defs per edge,
  smoothstep corner rounding; object `style` maps to fill/border;
  invalid connect preview styling
- `drivers/` is now a multi-page app (launcher + demo + vanilla +
  `plesfeda` spike with derived WBS layout, hierarchy/dependency
  edge semantics, h/v orientation toggle)

## [0.3.0] - 2026-10-16

### Added

- `@kimetron/core`: edges and ports — `Doc.edges`, `Port` (normalized
  `fx`/`fy` fractions of object size, tracking resizes automatically),
  `Edge` as pure reference data (from/to endpoints,
  `route`, `label`); `schemaVersion: 2` with tolerant reading of v1 docs;
  `removeObjects` prunes referencing edges (no orphans)
- `@kimetron/core`: edge routes — straight / orthogonal / bezier geometry
  (`edgeGeom`), polyline hit-testing (`distToGeom`)
- `@kimetron/core`: connect gesture — `startConnect` port-to-port drag,
  port snapping, self-connect rejection, live preview (`connectPreview`);
  `engine.connectRoute` picks the route of new edges
- `@kimetron/core`: edge selection — `edgeAt` hit test, edges share
  `selectedIds`, Delete removes selected objects and edges
- `@kimetron/dom`: SVG edge layer (`.ki-edges`), port dots (`.ki-port`,
  `data-ki-port` input), dashed connect preview, `.ki-edge` styles
- `drivers/demo`: 4-port rectangles, route switcher, edge count,
  connect gesture in the playground and vanilla page

## [0.2.0] - 2026-10-16

### Added

- `@kimetron/core`: resize gesture — 8 screen-space handles on a single
  selection, fixed opposite corner/edge, commit on pointerUp
  (`engine.startResize`, `resizeObject`)
- `@kimetron/core`: object snapping — moving edges/centers snap to other
  objects' edges/centers during drag and resize, prioritized over grid snap,
  with visible alignment guides (`engine.guides`)
- `@kimetron/core`: undo/redo via document snapshots
  (`undo`/`redo`/`canUndo`/`canRedo`, commit-only history, cap 100)
- `@kimetron/core`: z-order ops (`reorderSelected` — front/back/forward/
  backward) and `duplicateSelected` (grid-step offset copy, fresh ids)
- `@kimetron/core`: `panBy(dx, dy)` viewport pan
- `@kimetron/dom`: resize handles (`data-ki-handle`), guide layer,
  `.ki-handle`/`.ki-guide` styles; wheel routing — trackpad scroll pans,
  Ctrl/pinch zooms, plain wheel still zooms
- `drivers/demo`: undo/redo/duplicate/front/back buttons and keyboard
  shortcuts (Ctrl+Z/Y, Ctrl+D)

## [0.1.0] - 2026-10-15


### Added

- Initial monorepo scaffold: `@kimetron/core`, `@kimetron/dom`,
  `@kimetron/react` packages and `drivers/` sample-app area
- `@kimetron/core`: world-coordinate model — real units (mm/cm/m/inch/px),
  `bottom-left`/`top-left` origins, grid snap, scale-based zoom,
  `worldToScreen`/`screenToWorld`, immutable doc ops
- `@kimetron/core`: `Engine` — drag / marquee / middle-drag pan / wheel zoom,
  selection set, commit-on-dragend semantics
- `@kimetron/core`: JSON serialize/deserialize (`schemaVersion`, units and
  origin stored in the document)
- `@kimetron/dom`: input wiring, grid background, object/marquee frames,
  style injection, vanilla `createRenderer`
- `@kimetron/react`: `IsleCanvas`, `useEngine`, `useEngineVersion`
- `drivers/demo` playground: units/origin/grid/snap switching, add/delete,
  JSON save/load, scale + cursor readout, no-React `vanilla.html` page
