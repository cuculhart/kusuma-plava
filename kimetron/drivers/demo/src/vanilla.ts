import { Engine } from '@kimetron/core'
import { createRenderer } from '@kimetron/dom'

const engine = new Engine({
  units: 'mm',
  origin: 'bottom-left',
  grid: { size: 10, snap: true, major: 10 }, // v0.7.0: bold line every 100 mm
})
const ports4 = () => [
  { id: 'l', fx: 0, fy: 0.5 },
  { id: 't', fx: 0.5, fy: 1 },
  { id: 'r', fx: 1, fy: 0.5 },
  { id: 'b', fx: 0.5, fy: 0 },
]

engine.addObject({ id: 'vanilla', kind: 'rect', x: 20, y: 20, w: 60, h: 40, ports: ports4() })
engine.addObject({ id: 'no-react', kind: 'rect', x: 100, y: 80, w: 50, h: 30, ports: ports4() })
// shape kinds (v0.5.0): line chord / ellipse / arc / curve
engine.addObject({
  id: 'diag', kind: 'line', x: 20, y: 90, w: 60, h: 30,
  style: { stroke: '#b45309', width: 2, capEnd: 'arrow' },
})
engine.addObject({
  id: 'ell', kind: 'ellipse', x: 100, y: 20, w: 40, h: 25,
  style: { stroke: '#3a7bd5', width: 2, fill: 'rgba(58,123,213,0.15)' },
})
engine.addObject({
  id: 'arc', kind: 'arc', x: 160, y: 20, w: 30, h: 30,
  shape: { a0: 0, a1: 270 },
  style: { stroke: '#7c3aed', width: 2 },
})
engine.addObject({
  id: 'wave', kind: 'curve', x: 160, y: 60, w: 80, h: 30,
  shape: { points: [{ fx: 0, fy: 0.8 }, { fx: 0.3, fy: 0 }, { fx: 0.7, fy: 1 }, { fx: 1, fy: 0.2 }] },
  style: { stroke: '#0f766e', width: 2, dash: [5, 3] },
})
// v0.6.0: locked (selectable, not draggable), group (moves together),
// page frame, double-stroke line
engine.addObject({ id: 'fixed', kind: 'rect', x: 20, y: 140, w: 40, h: 20, locked: true, style: { fill: '#fef3c7', stroke: '#d97706' } })

engine.addObject({ id: 'ga', kind: 'rect', x: 80, y: 140, w: 30, h: 15, group: 'pair' })
engine.addObject({ id: 'gb', kind: 'rect', x: 80, y: 160, w: 30, h: 15, group: 'pair' })
engine.addObject({
  id: 'dbl', kind: 'line', x: 130, y: 145, w: 80, h: 15,
  shape: { points: [{ fx: 0, fy: 0.5 }, { fx: 1, fy: 0.5 }] },
  style: { stroke: '#333', width: 5, double: true },
})
engine.doc = { ...engine.doc, page: { x: 10, y: 10, w: 230, h: 180 } }
// v0.7.0: solid/layer — solids may abut but not overlap; layer lifts
// 'heavy' above 'thin' despite array order
engine.collisionMode = 'reject'
engine.addObject({ id: 'heavy', kind: 'rect', x: 20, y: 210, w: 50, h: 20, solid: true, layer: 1, style: { fill: '#e5e0d8' } })
engine.addObject({ id: 'thin', kind: 'rect', x: 30, y: 215, w: 50, h: 10, layer: -1, style: { fill: '#c7d7ea' } })

const el = document.getElementById('canvas') as HTMLElement
createRenderer(el, { engine })

const r = el.getBoundingClientRect()
engine.placeOrigin({ w: r.width, h: r.height })
