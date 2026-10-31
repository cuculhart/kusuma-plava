export type {

  Doc,

  Edge,

  EdgeEndpoint,

  EdgeMarker,

  EdgeRoute,

  EdgeStyle,

  GridConfig,

  ObjectShape,

  Origin,

  Port,

  Pt,

  Rect,

  ShapePoint,

  Unit,

  Viewport,

  WorldConfig,

  WorldObject,

  WorldObjectStyle,

} from './types'

export { unitToPx, formatLength, formatScale, PX_PER_INCH, MM_PER_INCH } from './units'

export {

  worldToScreen,

  screenToWorld,

  snap,

  rectOf,

  pointInRect,

  rectsIntersect,

  rectContains,

  rectOverlapArea,

  rectBetween,

  rotPt,

  invRotPt,

  objCenter,

  objPoint,

  obbOf,

  aabbOf,

  rectPoly,

  polysIntersect,

  segsProperlyIntersect,

  pointInPoly,

} from './geometry'

export {

  createDocument,

  addObject,

  moveObject,

  moveObjects,

  removeObjects,

  removeEdges,

  reorderObjects,

  renderOrder,

  resizeObject,

  rotateObject,

  serializeDoc,

  deserializeDoc,

  addEdge,

  endpointPos,

  edgeEndpoints,

  edgeAxis,
  edgeOutwardDirs,

  portFacingAxis,
  portNormal,

  retargetEdge,

  bendEdges,

  setShapePoint,

  insertShapePoint,

  removeShapePoint,

} from './doc'

export type { RouteAxis, ZOrder } from './doc'

export { edgeGeom, geomPolyline, distToGeom, distToSegment } from './edge'

export type { EdgeGeom } from './edge'

export {

  isShapeKind,

  shapeAnchors,

  arcAngles,

  arcPoint,

  catmullRomPolyline,

  shapePolyline,

  shapeSnapPoints,

  hitObject,

  footprintOf,

} from './shape'

export { Engine } from './engine'

export type { PointerOpts, EngineListener, ResizeDir, Guide, Mode } from './engine'

export const KIMETRON_VERSION = '1.6.1'

