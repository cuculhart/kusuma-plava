import { describe, expect, it } from 'vitest'
import {
  createDocument,
  deserializeDoc,
  edgeAxis,
  edgeGeom,
  endpointPos,
  Engine,
  formatLength,
  formatScale,
  screenToWorld,
  rectContains,
  rectOverlapArea,
  serializeDoc,
  snap,
  unitToPx,
  type WorldObject,
  worldToScreen,
} from './index'

const vp = { x: 100, y: 400, zoom: 1 }

describe('units', () => {
  it('converts world units to css px at 96dpi', () => {
    expect(unitToPx('px')).toBe(1)
    expect(unitToPx('inch')).toBe(96)
    expect(unitToPx('mm')).toBeCloseTo(96 / 25.4, 6)
    expect(unitToPx('cm')).toBeCloseTo(96 / 2.54, 6)
    expect(unitToPx('m')).toBeCloseTo(96 / 0.0254, 3)
  })

  it('formats lengths and scale', () => {
    expect(formatLength(12.5, 'mm')).toBe('12.5 mm')
    expect(formatLength(10, 'px')).toBe('10 px')
    expect(formatScale(1)).toBe('1:1')
    expect(formatScale(0.5)).toBe('1:2')
    expect(formatScale(4)).toBe('4:1')
  })
})

describe('transforms', () => {
  const mm = { units: 'mm' as const, origin: 'bottom-left' as const }

  it('roundtrips world<->screen in bottom-left origin', () => {
    const w = { x: 30, y: 20 }
    const s = worldToScreen(w, mm, vp)
    expect(s.y).toBeLessThan(vp.y)
    const rt = screenToWorld(s, mm, vp)
    expect(rt.x).toBeCloseTo(w.x, 9)
    expect(rt.y).toBeCloseTo(w.y, 9)
  })

  it('roundtrips in top-left origin', () => {
    const tl = { units: 'mm' as const, origin: 'top-left' as const }
    const w = { x: 30, y: 20 }
    const s = worldToScreen(w, tl, vp)
    expect(s.y).toBeGreaterThan(vp.y)
    const rt = screenToWorld(s, tl, vp)
    expect(rt.x).toBeCloseTo(w.x, 9)
    expect(rt.y).toBeCloseTo(w.y, 9)
  })

  it('snaps to grid when enabled', () => {
    expect(snap(13, { size: 10, snap: true })).toBe(10)
    expect(snap(13, { size: 10, snap: false })).toBe(13)
  })
})

describe('engine drag', () => {
  const obj = { id: 'a', kind: 'rect', x: 20, y: 20, w: 40, h: 30 }

  function make(cfg = {}) {
    const e = new Engine({ units: 'mm', origin: 'bottom-left', grid: { size: 10, snap: true }, ...cfg }, [obj])
    e.viewport = { x: 0, y: 500, zoom: 1 }
    return e
  }

  it('commits position only on pointerUp', () => {
    const e = make()
    let emitted = 0
    e.onDocChange(() => emitted++)
    const s0 = e.worldToScreen({ x: obj.x + 1, y: obj.y + 1 })
    e.pointerDown(s0)
    expect(e.selectedIds.has('a')).toBe(true)

    const s1 = e.worldToScreen({ x: obj.x + 1 + 15, y: obj.y + 1 + 10 })
    e.pointerMove(s1)
    expect(e.dragDelta).toEqual({ x: 20, y: 10 })
    expect(e.doc.objects[0].x).toBe(20)
    expect(emitted).toBe(0)

    e.pointerUp()
    expect(e.doc.objects[0].x).toBe(40)
    expect(e.doc.objects[0].y).toBe(30)
    expect(emitted).toBe(1)
    expect(e.dragDelta).toBeNull()
  })

  it('snaps the dragged object onto grid lines, not just the delta', () => {
    const off = { id: 'off', kind: 'rect', x: 23, y: 17, w: 40, h: 30 }
    const e = new Engine(
      { units: 'mm', origin: 'bottom-left', grid: { size: 10, snap: true } },
      [off],
    )
    e.viewport = { x: 0, y: 500, zoom: 1 }
    e.pointerDown(e.worldToScreen({ x: off.x + 1, y: off.y + 1 }))
    e.pointerMove(e.worldToScreen({ x: off.x + 3, y: off.y + 1 }))
    e.pointerUp()
    expect(e.doc.objects[0].x % 10).toBe(0)
    expect(e.doc.objects[0].y % 10).toBe(0)
  })

  it('does not mutate doc on click without move', () => {
    const e = make()
    const s0 = e.worldToScreen({ x: 21, y: 21 })
    e.pointerDown(s0)
    e.pointerUp()
    expect(e.doc.objects[0].x).toBe(20)
  })

  it('marquee selects intersecting objects and clears on empty area', () => {
    const e = make()
    e.pointerDown(e.worldToScreen({ x: 0, y: 0 }))
    e.pointerMove(e.worldToScreen({ x: 100, y: 100 }))
    expect(e.selectedIds.has('a')).toBe(true)
    e.pointerUp()
    e.pointerDown(e.worldToScreen({ x: 200, y: 200 }))
    e.pointerMove(e.worldToScreen({ x: 300, y: 300 }))
    e.pointerUp()
    expect(e.selectedIds.size).toBe(0)
  })

  it('wheel zoom keeps the cursor world point fixed', () => {
    const e = make()
    const pt = { x: 250, y: 300 }
    const before = e.screenToWorld(pt)
    e.wheel(pt, -240)
    const after = e.screenToWorld(pt)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
    expect(e.viewport.zoom).toBeGreaterThan(1)
  })

  it('pans with middle button', () => {
    const e = make()
    e.pointerDown({ x: 10, y: 10 }, { button: 1 })
    e.pointerMove({ x: 60, y: 40 })
    e.pointerUp()
    expect(e.viewport.x).toBe(50)
    expect(e.viewport.y).toBe(530)
  })
})

describe('engine resize', () => {
  const obj = { id: 'a', kind: 'rect', x: 20, y: 20, w: 40, h: 30 }

  function make(cfg = {}) {
    const e = new Engine({ units: 'mm', origin: 'bottom-left', grid: { size: 10, snap: true }, ...cfg }, [obj])
    e.viewport = { x: 0, y: 500, zoom: 1 }
    return e
  }

  it('commits the new rect only on pointerUp, snapping the moving edges', () => {
    const e = make()
    let emitted = 0
    e.onDocChange(() => emitted++)
    // move the max-x / max-y edges (screen 'se' under bottom-left is {x:+1,y:-1}... here use {x:1,y:1} = grow toward +x,+y)
    e.startResize({ x: 0, y: 0 }, 'a', { x: 1, y: 1 })
    e.pointerMove(e.worldToScreen({ x: 97, y: 83 }))
    // preview only; edges snapped to 100/80 → rect stays anchored at orig min corner
    expect(e.resize?.rect).toEqual({ x: 20, y: 20, w: 80, h: 60 })
    expect(e.doc.objects[0].w).toBe(40)
    expect(emitted).toBe(0)

    e.pointerUp()
    expect(e.doc.objects[0]).toMatchObject({ x: 20, y: 20, w: 80, h: 60 })
    expect(emitted).toBe(1)
    expect(e.resize).toBeNull()
  })

  it('keeps the opposite corner fixed when dragging a min edge', () => {
    const e = make()
    e.startResize({ x: 0, y: 0 }, 'a', { x: -1, y: -1 }) // move min-x/min-y edges
    e.pointerMove(e.worldToScreen({ x: 5, y: 8 }))
    e.pointerUp()
    // snapped min corner lands at (10,10); max corner (60,50) stays fixed
    expect(e.doc.objects[0]).toMatchObject({ x: 10, y: 10, w: 50, h: 40 })
  })

  it('does not commit on a click without move', () => {
    const e = make()
    let emitted = 0
    e.onDocChange(() => emitted++)
    e.startResize({ x: 0, y: 0 }, 'a', { x: 1, y: 1 })
    e.pointerUp()
    expect(e.doc.objects[0]).toMatchObject({ x: 20, y: 20, w: 40, h: 30 })
    expect(emitted).toBe(0)
  })
})

describe('object snapping', () => {
  const cfg = { units: 'mm' as const, origin: 'bottom-left' as const, grid: { size: 10, snap: true } }

  it('snaps dragged edge to a neighbor edge in preference to the grid', () => {
    const e = new Engine(cfg, [
      { id: 'a', kind: 'rect', x: 20, y: 20, w: 40, h: 30 },
      { id: 'b', kind: 'rect', x: 90, y: 0, w: 30, h: 30 },
    ])
    e.viewport = { x: 0, y: 500, zoom: 1 }
    // grab 'a', drag so its max-x edge lands just short of b's min-x (90)
    e.pointerDown(e.worldToScreen({ x: 21, y: 21 }))
    e.pointerMove(e.worldToScreen({ x: 21 + 28, y: 21 })) // anchor lands x=48 → edges 48/68/88
    // nearest within tol: 88→90 (adj +2) wins over grid
    expect(e.dragDelta?.x).toBeCloseTo(30)
    expect(e.dragDelta?.y).toBeCloseTo(0)
    expect(e.guides).toEqual([{ axis: 'x', at: 90 }])
    e.pointerUp()
    expect(e.doc.objects[0].x).toBeCloseTo(50)
    expect(e.guides).toEqual([])
  })

  it('snaps the resize pointer to a neighbor edge', () => {
    const e = new Engine(cfg, [
      { id: 'a', kind: 'rect', x: 20, y: 20, w: 40, h: 30 },
      { id: 'b', kind: 'rect', x: 95, y: 0, w: 30, h: 30 },
    ])
    e.viewport = { x: 0, y: 500, zoom: 1 }
    e.startResize({ x: 0, y: 0 }, 'a', { x: 1, y: 0 })
    e.pointerMove(e.worldToScreen({ x: 94, y: 20 }))
    expect(e.resize?.rect.w).toBe(75) // snapped to x=95: 95-20
    e.pointerUp()
    expect(e.doc.objects[0].w).toBe(75)
  })
})

describe('history / z-order / duplicate', () => {
  const obj = { id: 'a', kind: 'rect', x: 0, y: 0, w: 10, h: 10 }

  it('undo/redo restores committed docs', () => {
    const e = new Engine({}, [{ ...obj }])
    e.viewport = { x: 0, y: 0, zoom: 1 }
    expect(e.canUndo).toBe(false)
    e.moveSelectedBy(0, 0) // no selection — but direct doc ops:
    e.addObject({ id: 'b', kind: 'rect', x: 5, y: 5, w: 10, h: 10 })
    expect(e.doc.objects).toHaveLength(2)
    expect(e.canUndo).toBe(true)
    e.undo()
    expect(e.doc.objects).toHaveLength(1)
    expect(e.canRedo).toBe(true)
    e.redo()
    expect(e.doc.objects).toHaveLength(2)
  })

  it('reorders objects front/back', () => {
    const e = new Engine({}, [
      { ...obj },
      { id: 'b', kind: 'rect', x: 0, y: 0, w: 10, h: 10 },
      { id: 'c', kind: 'rect', x: 0, y: 0, w: 10, h: 10 },
    ])
    e.setSelection(['a'])
    e.reorderSelected('front')
    expect(e.doc.objects.map((o) => o.id)).toEqual(['b', 'c', 'a'])
    e.reorderSelected('back')
    expect(e.doc.objects.map((o) => o.id)).toEqual(['a', 'b', 'c'])
    e.reorderSelected('forward')
    expect(e.doc.objects.map((o) => o.id)).toEqual(['b', 'a', 'c'])
  })

  it('duplicates selection with fresh ids and selects the copies', () => {
    const e = new Engine({ grid: { size: 10, snap: true } }, [{ ...obj }])
    e.setSelection(['a'])
    e.duplicateSelected()
    expect(e.doc.objects).toHaveLength(2)
    const copy = e.doc.objects[1]
    expect(copy.id).toBe('a-copy')
    expect(copy.x).toBe(10)
    expect(e.selectedIds.has('a-copy')).toBe(true)
    e.duplicateSelected()
    expect(e.doc.objects[2].id).toBe('a-copy-copy')
  })
})

describe('history edge cases', () => {
  it('setDoc (load) is one undoable commit', () => {
    const e = new Engine({}, [{ id: 'a', kind: 'rect', x: 0, y: 0, w: 10, h: 10 }])
    const loaded = deserializeDoc(serializeDoc({ ...createDocument(), objects: [{ id: 'z', kind: 'rect', x: 1, y: 2, w: 3, h: 4 }] }))
    e.setDoc(loaded)
    expect(e.doc.objects[0].id).toBe('z')
    e.undo()
    expect(e.doc.objects[0].id).toBe('a')
  })

  it('a new commit clears the redo stack', () => {
    const e = new Engine({}, [{ id: 'a', kind: 'rect', x: 0, y: 0, w: 10, h: 10 }])
    e.addObject({ id: 'b', kind: 'rect', x: 1, y: 1, w: 5, h: 5 })
    e.undo()
    e.addObject({ id: 'c', kind: 'rect', x: 2, y: 2, w: 5, h: 5 })
    expect(e.canRedo).toBe(false)
  })
})

describe('edges and ports', () => {
  const cfg = { units: 'mm' as const, origin: 'bottom-left' as const, grid: { size: 10, snap: true } }
  const two = [
    { id: 'a', kind: 'rect', x: 0, y: 0, w: 40, h: 30, ports: [{ id: 'r', fx: 1, fy: 0.5 }] },
    { id: 'b', kind: 'rect', x: 100, y: 0, w: 40, h: 30, ports: [{ id: 'l', fx: 0, fy: 0.5 }] },
  ]
  const make = () => {
    const e = new Engine(cfg, two)
    e.viewport = { x: 0, y: 500, zoom: 1 }
    return e
  }

  it('connect gesture commits an edge port-to-port', () => {
    const e = make()
    e.startConnect(e.worldToScreen({ x: 40, y: 15 }), 'a', 'r')
    e.pointerMove(e.worldToScreen({ x: 60, y: 15 }))
    expect(e.connect).not.toBeNull()
    expect(e.connectPreview()?.to.x).toBeCloseTo(60)
    expect(e.connectPreview()?.to.y).toBeCloseTo(15)
    // hover over b's left port (at world 100,15)
    e.pointerMove(e.worldToScreen({ x: 99, y: 16 }))
    expect(e.connect?.hover).toEqual({ obj: 'b', port: 'l' })
    e.pointerUp()
    expect(e.doc.edges).toHaveLength(1)
    expect(e.doc.edges[0]).toMatchObject({ id: 'e1', from: { obj: 'a', port: 'r' }, to: { obj: 'b', port: 'l' } })
  })

  it('cancels connect on empty drop and rejects self-connect', () => {
    const e = make()
    e.startConnect(e.worldToScreen({ x: 40, y: 15 }), 'a', 'r')
    e.pointerMove(e.worldToScreen({ x: 200, y: 100 }))
    e.pointerUp()
    expect(e.doc.edges).toHaveLength(0)
    // same-object port hover is not a valid target
    e.startConnect(e.worldToScreen({ x: 40, y: 15 }), 'a', 'r')
    e.pointerMove(e.worldToScreen({ x: 39, y: 15 }))
    expect(e.connect?.hover).toBeNull()
    e.pointerUp()
    expect(e.doc.edges).toHaveLength(0)
  })

  it('edge click selects and Delete removes; object removal prunes edges', () => {
    const e = make()
    e.startConnect(e.worldToScreen({ x: 40, y: 15 }), 'a', 'r')
    e.pointerMove(e.worldToScreen({ x: 99, y: 16 }))
    e.pointerUp()
    // click near the edge midpoint (world ~70,15)
    e.pointerDown(e.worldToScreen({ x: 70, y: 16 }))
    e.pointerUp()
    expect(e.selectedIds.has('e1')).toBe(true)
    e.removeSelected()
    expect(e.doc.edges).toHaveLength(0)
    // reconnect, then delete object 'b' → edge pruned
    e.startConnect(e.worldToScreen({ x: 40, y: 15 }), 'a', 'r')
    e.pointerMove(e.worldToScreen({ x: 99, y: 16 }))
    e.pointerUp()
    expect(e.doc.edges).toHaveLength(1)
    e.setSelection(['b'])
    e.removeSelected()
    expect(e.doc.edges).toHaveLength(0)
  })

  it('keeps ports on the edges after resize (normalized fractions)', () => {
    const e = make()
    const a = () => e.doc.objects.find((o) => o.id === 'a')!
    // shrink 'a' from w=40 to w=10 via the min-x edge
    e.startResize({ x: 0, y: 0 }, 'a', { x: -1, y: 0 })
    e.pointerMove(e.worldToScreen({ x: 30, y: 15 }))
    e.pointerUp()
    const o = a()
    expect(o.w).toBe(10)
    // 'r' port at fx=1 must sit on the right edge, not inside the rect
    const pos = endpointPos(e.doc, { obj: 'a', port: 'r' })
    expect(pos?.x).toBeCloseTo(o.x + o.w)
  })

  it('canConnect rejects the commit and flags hover as invalid', () => {
    const e = make()
    e.canConnect = (_from, to) => to.obj !== 'b'
    e.startConnect(e.worldToScreen({ x: 40, y: 15 }), 'a', 'r')
    e.pointerMove(e.worldToScreen({ x: 99, y: 16 }))
    expect(e.connect?.hover).toEqual({ obj: 'b', port: 'l' })
    expect(e.connect?.invalid).toBe(true)
    e.pointerUp()
    expect(e.doc.edges).toHaveLength(0)
  })

  it('connectEdge stamps style/markers onto gesture-created edges', () => {
    const e = make()
    e.connectEdge = {
      route: 'bezier',
      style: { color: '#b45309', width: 1.8 },
      markerEnd: 'arrow',
    }
    e.startConnect(e.worldToScreen({ x: 40, y: 15 }), 'a', 'r')
    e.pointerMove(e.worldToScreen({ x: 99, y: 16 }))
    e.pointerUp()
    expect(e.doc.edges[0]).toMatchObject({
      route: 'bezier',
      style: { color: '#b45309', width: 1.8 },
      markerEnd: 'arrow',
    })
  })

  it('serializes edge style/markers and object style', () => {
    const e = make()
    e.connectEdge = { style: { color: 'var(--dep)', width: 2, dash: [4, 4] }, markerEnd: 'dot' }
    e.startConnect(e.worldToScreen({ x: 40, y: 15 }), 'a', 'r')
    e.pointerMove(e.worldToScreen({ x: 99, y: 16 }))
    e.pointerUp()
    e.doc = {
      ...e.doc,
      objects: e.doc.objects.map((o) =>
        o.id === 'a' ? { ...o, style: { fill: '#fef3c7', stroke: '#e0d77a' } } : o,
      ),
    }
    const out = deserializeDoc(serializeDoc(e.doc))
    expect(out.edges).toEqual(e.doc.edges)
    expect(out.objects[0].style).toEqual({ fill: '#fef3c7', stroke: '#e0d77a' })
  })

  it('smoothstep resolves to the same geometry as orthogonal', () => {
    const e = make()
    e.connectRoute = 'smoothstep'
    e.startConnect(e.worldToScreen({ x: 40, y: 15 }), 'a', 'r')
    e.pointerMove(e.worldToScreen({ x: 99, y: 16 }))
    e.pointerUp()
    expect(e.doc.edges[0].route).toBe('smoothstep')
    // hit test works on smoothstep (midpoint click selects it)
    e.pointerDown(e.worldToScreen({ x: 70, y: 15 }))
    e.pointerUp()
    expect(e.selectedIds.has(e.doc.edges[0].id)).toBe(true)
  })

  it('serializes edges and reads v1 docs without them', () => {
    const e = make()
    e.startConnect(e.worldToScreen({ x: 40, y: 15 }), 'a', 'r')
    e.pointerMove(e.worldToScreen({ x: 99, y: 16 }))
    e.pointerUp()
    const out = deserializeDoc(serializeDoc(e.doc))
    expect(out.edges).toEqual(e.doc.edges)
    const v1 = JSON.stringify({ units: 'mm', origin: 'bottom-left', grid: { size: 10, snap: true }, objects: [] })
    expect(deserializeDoc(v1).edges).toEqual([])
  })
})

describe('connect orientation and rewiring', () => {
  // a mini sethera: sources expose 'out', calcs take 'a'/'b' and re-emit 'out'
  const objs = [
    { id: 'p1', kind: 'rect', x: 0, y: 0, w: 40, h: 20, ports: [{ id: 'out', fx: 1, fy: 0.5 }] },
    { id: 'p2', kind: 'rect', x: 0, y: 60, w: 40, h: 20, ports: [{ id: 'out', fx: 1, fy: 0.5 }] },
    {
      id: 'c1', kind: 'rect', x: 100, y: 0, w: 40, h: 30,
      ports: [
        { id: 'a', fx: 0, fy: 0.3 },
        { id: 'b', fx: 0, fy: 0.7 },
        { id: 'out', fx: 1, fy: 0.5 },
      ],
    },
  ]
  const isOut = (ep: { obj: string; port?: string }) => ep.port === 'out'
  const isIn = (ep: { obj: string; port?: string }) => ep.port === 'a' || ep.port === 'b'
  const make = () => {
    const e = new Engine(
      { units: 'mm', origin: 'bottom-left', grid: { size: 10, snap: true } },
      objs,
    )
    e.viewport = { x: 0, y: 500, zoom: 1 }
    e.canConnect = (from, to) => isOut(from) && isIn(to)
    e.connectOrient = (a, b) =>
      isOut(a) && isIn(b)
        ? { from: a, to: b }
        : isIn(a) && isOut(b)
          ? { from: b, to: a }
          : null
    e.rewireEdge = (ep) =>
      isIn(ep)
        ? (e.doc.edges.find((x) => x.to.obj === ep.obj && x.to.port === ep.port)?.id ?? null)
        : null
    return e
  }
  const wire = (
    e: Engine,
    s: { x: number; y: number },
    obj: string,
    port: string,
    t: { x: number; y: number },
  ) => {
    e.startConnect(e.worldToScreen(s), obj, port)
    e.pointerMove(e.worldToScreen(t))
    e.pointerUp()
  }
  // p1.out = (40,10), p2.out = (40,70), c1.a = (100,9), c1.b = (100,21)

  it('orients a child→parent drag into a from→to edge', () => {
    const e = make()
    // grab c1's input 'a' and drag back to p1's 'out'
    e.startConnect(e.worldToScreen({ x: 100, y: 9 }), 'c1', 'a')
    e.pointerMove(e.worldToScreen({ x: 40, y: 10 }))
    expect(e.connect?.hover).toEqual({ obj: 'p1', port: 'out' })
    expect(e.connect?.invalid).toBe(false)
    e.pointerUp()
    expect(e.doc.edges).toHaveLength(1)
    expect(e.doc.edges[0]).toMatchObject({
      from: { obj: 'p1', port: 'out' },
      to: { obj: 'c1', port: 'a' },
    })
  })

  it('connectOrient returning null forbids the pair', () => {
    const e = make()
    // out → out is not a valid pair
    e.startConnect(e.worldToScreen({ x: 40, y: 10 }), 'p1', 'out')
    e.pointerMove(e.worldToScreen({ x: 40, y: 70 })) // p2's 'out'
    expect(e.connect?.hover).toEqual({ obj: 'p2', port: 'out' })
    expect(e.connect?.invalid).toBe(true)
    e.pointerUp()
    expect(e.doc.edges).toHaveLength(0)
  })

  it('grabbing an occupied input picks the wire up for rewiring', () => {
    const e = make()
    wire(e, { x: 40, y: 10 }, 'p1', 'out', { x: 100, y: 9 })
    expect(e.doc.edges).toHaveLength(1)
    // grab the occupied 'a' — the wire's source end follows the pointer
    e.startConnect(e.worldToScreen({ x: 100, y: 9 }), 'c1', 'a')
    expect(e.connect?.rewire).toEqual({ edge: 'e1', end: 'from' })
    e.pointerMove(e.worldToScreen({ x: 40, y: 70 })) // p2 'out'
    e.pointerUp()
    expect(e.doc.edges).toHaveLength(1)
    expect(e.doc.edges[0]).toMatchObject({
      id: 'e1',
      from: { obj: 'p2', port: 'out' },
      to: { obj: 'c1', port: 'a' },
    })
  })

  it('dropping a rewired end on empty canvas detaches the wire (undoable)', () => {
    const e = make()
    wire(e, { x: 40, y: 10 }, 'p1', 'out', { x: 100, y: 9 })
    e.startConnect(e.worldToScreen({ x: 100, y: 9 }), 'c1', 'a')
    e.pointerMove(e.worldToScreen({ x: 200, y: 200 }))
    e.pointerUp()
    expect(e.doc.edges).toHaveLength(0)
    e.undo()
    expect(e.doc.edges).toHaveLength(1)
  })

  it('an invalid rewire drop keeps the edge unchanged', () => {
    const e = make()
    wire(e, { x: 40, y: 10 }, 'p1', 'out', { x: 100, y: 9 })
    // pick the wire up at 'a' and drop on c1's own 'b' — same-object port:
    // treated as a cancel, not a detach
    e.startConnect(e.worldToScreen({ x: 100, y: 9 }), 'c1', 'a')
    e.pointerMove(e.worldToScreen({ x: 100, y: 21 }))
    expect(e.connect?.hover).toBeNull()
    expect(e.connect?.overPort).toBe(true)
    e.pointerUp()
    expect(e.doc.edges).toHaveLength(1)
    expect(e.doc.edges[0].from).toEqual({ obj: 'p1', port: 'out' })
  })

  it('startRewire retargets the named end of an edge', () => {
    const e = make()
    wire(e, { x: 40, y: 10 }, 'p1', 'out', { x: 100, y: 9 })
    e.startRewire(e.worldToScreen({ x: 100, y: 9 }), 'e1', 'to')
    e.pointerMove(e.worldToScreen({ x: 100, y: 21 })) // c1 'b'
    e.pointerUp()
    expect(e.doc.edges[0]).toMatchObject({ id: 'e1', to: { obj: 'c1', port: 'b' } })
  })

  it('grabbing a wire end just off the object rewires that end', () => {
    const e = make()
    wire(e, { x: 40, y: 10 }, 'p1', 'out', { x: 100, y: 9 })
    // click the wire a hair off c1's 'a' endpoint (98,9) — outside the bbox,
    // on the line, within endpoint tolerance
    e.pointerDown(e.worldToScreen({ x: 98, y: 9 }))
    expect(e.connect?.rewire).toEqual({ edge: 'e1', end: 'to' })
    e.pointerMove(e.worldToScreen({ x: 100, y: 21 }))
    e.pointerUp()
    expect(e.doc.edges[0].to).toEqual({ obj: 'c1', port: 'b' })
  })

  it('a click mid-wire still selects instead of rewiring', () => {
    const e = make()
    wire(e, { x: 40, y: 10 }, 'p1', 'out', { x: 100, y: 9 })
    e.pointerDown(e.worldToScreen({ x: 70, y: 9.5 }))
    e.pointerUp()
    expect(e.connect).toBeNull()
    expect(e.selectedIds.has('e1')).toBe(true)
  })

  it('retargetEdge rewires an edge programmatically', () => {
    const e = make()
    wire(e, { x: 40, y: 10 }, 'p1', 'out', { x: 100, y: 9 })
    e.retargetEdge('e1', { obj: 'p2', port: 'out' }, { obj: 'c1', port: 'b' })
    expect(e.doc.edges[0]).toMatchObject({
      from: { obj: 'p2', port: 'out' },
      to: { obj: 'c1', port: 'b' },
    })
  })
})

describe('edge bend (trunk position)', () => {
  // a bracket: p feeds c1/c2/c3 through smoothstep edges
  const OUT = { id: 'out', fx: 1, fy: 0.5 }
  const IN = { id: 'in', fx: 0, fy: 0.5 }
  const objs = [
    { id: 'p', kind: 'rect', x: 0, y: 30, w: 40, h: 20, ports: [OUT] },
    { id: 'c1', kind: 'rect', x: 100, y: 0, w: 40, h: 20, ports: [IN] },
    { id: 'c2', kind: 'rect', x: 100, y: 40, w: 40, h: 20, ports: [IN] },
    { id: 'c3', kind: 'rect', x: 100, y: 80, w: 40, h: 20, ports: [IN] },
  ]
  const edges = [1, 2, 3].map((i) => ({
    id: `e${i}`,
    from: { obj: 'p', port: 'out' },
    to: { obj: `c${i}`, port: 'in' },
    route: 'smoothstep' as const,
  }))
  const make = (group = false) => {
    const e = new Engine(
      { units: 'mm', origin: 'bottom-left', grid: { size: 10, snap: true } },
      objs,
    )
    e.viewport = { x: 0, y: 500, zoom: 1 }
    e.doc = { ...e.doc, edges }
    if (group) {
      e.bendGroup = (edge, doc) =>
        doc.edges
          .filter(
            (s) =>
              s.id !== edge.id &&
              (s.route === 'orthogonal' || s.route === 'smoothstep') &&
              s.from.obj === edge.from.obj &&
              s.from.port === edge.from.port,
          )
          .map((s) => s.id)
    }
    return e
  }
  // endpoints: p.out = (40,40); ci.in = (100, yi+10); dx dominant, span = 60

  it('edgeGeom places the trunk at the bend fraction', () => {
    const g = edgeGeom({ x: 40, y: 40 }, { x: 100, y: 10 }, 'orthogonal', 0.25)
    expect(g.kind).toBe('polyline')
    const pts = (g as { pts: { x: number; y: number }[] }).pts
    expect(pts[1].x).toBeCloseTo(55) // 40 + 60*0.25
    expect(pts[2].x).toBeCloseTo(55)
  })

  it('startBend drags the trunk along the dominant axis and commits on up', () => {
    const e = make()
    e.startBend(e.worldToScreen({ x: 70, y: 40 }), 'e1')
    e.pointerMove(e.worldToScreen({ x: 80, y: 45 }))
    expect(e.edgeBend?.t).toBeCloseTo(2 / 3, 2) // (80-40)/60
    e.pointerUp()
    expect(e.doc.edges[0].bend).toBeCloseTo(2 / 3, 2)
    expect(e.doc.edges[1].bend).toBeUndefined() // others untouched
    // and it reroutes
    const g = edgeGeom({ x: 40, y: 40 }, { x: 100, y: 10 }, 'smoothstep', e.doc.edges[0].bend)
    expect((g as { pts: { x: number }[] }).pts[1].x).toBeCloseTo(80)
  })

  it('clamps the trunk between the endpoints', () => {
    const e = make()
    e.startBend(e.worldToScreen({ x: 70, y: 40 }), 'e1')
    e.pointerMove(e.worldToScreen({ x: 400, y: 45 }))
    e.pointerUp()
    expect(e.doc.edges[0].bend).toBe(1)
    e.startBend(e.worldToScreen({ x: 70, y: 40 }), 'e1')
    e.pointerMove(e.worldToScreen({ x: -400, y: 45 }))
    e.pointerUp()
    expect(e.doc.edges[0].bend).toBe(0)
  })

  it('bendGroup moves sibling trunks in the same commit', () => {
    const e = make(true)
    e.startBend(e.worldToScreen({ x: 70, y: 40 }), 'e1')
    expect(e.edgeBend?.ids).toEqual(['e1', 'e2', 'e3'])
    e.pointerMove(e.worldToScreen({ x: 85, y: 45 }))
    e.pointerUp()
    for (const s of e.doc.edges) expect(s.bend).toBeCloseTo(0.75, 2)
    e.undo()
    for (const s of e.doc.edges) expect(s.bend).toBeUndefined()
  })

  it('snaps the trunk to a sibling edge sharing the source', () => {
    const e = make()
    e.doc = {
      ...e.doc,
      edges: e.doc.edges.map((s) => (s.id === 'e2' ? { ...s, bend: 0.3 } : s)),
    }
    // e2's trunk sits at 40 + 60*0.3 = 58 — drag e1 near it
    e.startBend(e.worldToScreen({ x: 70, y: 40 }), 'e1')
    e.pointerMove(e.worldToScreen({ x: 60, y: 45 })) // within 8px of trunk 58
    expect(e.edgeBend?.t).toBeCloseTo(0.3, 2)
    expect(e.guides.some((g) => g.axis === 'x')).toBe(true)
    e.pointerUp()
    expect(e.doc.edges[0].bend).toBeCloseTo(0.3, 2)
  })

  it('grabbing the trunk segment bends it directly, click still selects', () => {
    const e = make()
    // e1's trunk: x=70, y in [10,40] — the top stretch is e1-only
    e.pointerDown(e.worldToScreen({ x: 70, y: 25 }))
    expect(e.edgeBend).not.toBeNull()
    expect(e.selectedIds.has('e1')).toBe(true)
    e.pointerMove(e.worldToScreen({ x: 80, y: 25 }))
    e.pointerUp()
    expect(e.doc.edges[0].bend).toBeCloseTo(2 / 3, 2)
    // a click without moving: selects, no commit
    e.pointerDown(e.worldToScreen({ x: 70, y: 25 }))
    e.pointerUp()
    expect(e.doc.edges[0].bend).toBeCloseTo(2 / 3, 2)
  })

  it('a click on a non-trunk segment selects without bending', () => {
    const e = make()
    // (55,40) sits on the shared from-segment, ~15mm off the x=70 trunk
    e.pointerDown(e.worldToScreen({ x: 55, y: 40 }))
    e.pointerUp()
    expect(e.edgeBend).toBeNull()
    expect(e.selectedIds.size).toBe(1)
    expect(e.doc.edges.every((s) => s.bend === undefined)).toBe(true)
  })

  it('trunk grab + bendGroup keeps the shared trunk unified', () => {
    const e = make(true)
    // grab e1's trunk at x=70 — every sibling should follow
    e.pointerDown(e.worldToScreen({ x: 70, y: 25 }))
    expect(e.edgeBend?.ids).toEqual(['e1', 'e2', 'e3'])
    e.pointerMove(e.worldToScreen({ x: 85, y: 25 }))
    e.pointerUp()
    for (const s of e.doc.edges) expect(s.bend).toBeCloseTo(0.75, 2)
  })

  it('edgeAxis resolves the trunk axis from port facing', () => {
    const e = new Engine({ units: 'mm', origin: 'top-left', grid: { size: 5 } })
    e.doc = {
      ...e.doc,
      objects: [
        {
          id: 'a',
          kind: 'r',
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          ports: [
            { id: 'r', fx: 1, fy: 0.5 },
            { id: 'b', fx: 0.5, fy: 1 },
          ],
        },
        {
          id: 'b',
          kind: 'r',
          x: 20,
          y: 100,
          w: 10,
          h: 10,
          ports: [
            { id: 'l', fx: 0, fy: 0.5 },
            { id: 't', fx: 0.5, fy: 0 },
          ],
        },
      ],
      edges: [
        { id: 'ss', from: { obj: 'a', port: 'r' }, to: { obj: 'b', port: 'l' }, route: 'orthogonal' },
        { id: 'vv', from: { obj: 'a', port: 'b' }, to: { obj: 'b', port: 't' }, route: 'orthogonal' },
        { id: 'mx', from: { obj: 'a', port: 'r' }, to: { obj: 'b', port: 't' }, route: 'orthogonal' },
        { id: 'nc', from: { obj: 'a' }, to: { obj: 'b' }, route: 'orthogonal' },
      ],
    }
    expect(edgeAxis(e.doc, e.doc.edges[0])).toBe('h') // r→l despite |dy|>|dx|
    expect(edgeAxis(e.doc, e.doc.edges[1])).toBe('v') // b→t
    expect(edgeAxis(e.doc, e.doc.edges[2])).toBe('h') // mixed: exit side wins
    expect(edgeAxis(e.doc, e.doc.edges[3])).toBe('v') // no ports → delta fallback
  })

  it('far-offset siblings keep a shared vertical trunk and bend together', () => {
    // regression for the split-bracket bug: children far above/below the
    // parent flipped to a per-edge staircase because the dominant axis was
    // inferred from the endpoint delta instead of the port facing
    const e = make(true)
    e.doc = {
      ...e.doc,
      objects: e.doc.objects.map((o) =>
        o.id === 'c1' ? { ...o, y: -80 } : o.id === 'c3' ? { ...o, y: 160 } : o,
      ),
    }
    // e1: (40,40)→(100,-70), e3: (40,40)→(100,170) — |dy|>|dx| but still 'h'
    for (const s of e.doc.edges) expect(edgeAxis(e.doc, s)).toBe('h')
    // every sibling shares the vertical trunk at x=70 — grabbing e1's
    // stretch moves all three in one gesture
    e.pointerDown(e.worldToScreen({ x: 70, y: -20 }))
    expect(e.edgeBend?.ids).toEqual(['e1', 'e2', 'e3'])
    e.pointerMove(e.worldToScreen({ x: 85, y: -20 }))
    e.pointerUp()
    for (const s of e.doc.edges) expect(s.bend).toBeCloseTo(0.75, 2)
  })

  it('refuses non-bendable routes and serializes bend', () => {
    const e = make()
    e.doc = {
      ...e.doc,
      edges: e.doc.edges.map((s) => ({ ...s, route: 'bezier' as const })),
    }
    e.startBend(e.worldToScreen({ x: 70, y: 40 }), 'e1')
    expect(e.edgeBend).toBeNull()
    e.doc = {
      ...e.doc,
      edges: e.doc.edges.map((s) => ({ ...s, route: 'smoothstep' as const, bend: 0.2 })),
    }
    const out = deserializeDoc(serializeDoc(e.doc))
    expect(out.edges[0].bend).toBe(0.2)
  })
})

describe('shape kinds', () => {
  function make(objs: WorldObject[]) {
    const e = new Engine({ units: 'mm', origin: 'bottom-left', grid: { size: 10, snap: true } }, objs)
    e.viewport = { x: 0, y: 500, zoom: 1 }
    return e
  }
  const hit = (e: Engine, w: { x: number; y: number }) =>
    e.objectAt(e.worldToScreen(w))?.id ?? null

  it('hits a diagonal line only near the chord, not its bbox', () => {
    const e = make([{ id: 'l', kind: 'line', x: 0, y: 0, w: 40, h: 40 }])
    expect(hit(e, { x: 20, y: 20 })).toBe('l') // on the diagonal
    expect(hit(e, { x: 38, y: 2 })).toBe(null) // inside bbox, far from line
  })

  it('hits a custom chord (horizontal rule)', () => {
    const e = make([
      {
        id: 'r',
        kind: 'line',
        x: 0,
        y: 0,
        w: 60,
        h: 10,
        shape: { points: [{ fx: 0, fy: 0.5 }, { fx: 1, fy: 0.5 }] },
      },
    ])
    expect(hit(e, { x: 30, y: 5 })).toBe('r')
    expect(hit(e, { x: 30, y: 1 })).toBe(null)
  })

  it('ellipse: filled hits inside, unfilled hits only the ring', () => {
    const e = make([
      { id: 'ring', kind: 'ellipse', x: 0, y: 0, w: 40, h: 40 },
      { id: 'disk', kind: 'ellipse', x: 60, y: 0, w: 40, h: 40, style: { fill: '#fc0' } },
    ])
    expect(hit(e, { x: 20, y: 20 })).toBe(null) // center of unfilled ring
    expect(hit(e, { x: 40, y: 20 })).toBe('ring') // on the ring
    expect(hit(e, { x: 80, y: 20 })).toBe('disk') // inside filled disk
  })

  it('arc hits along the swept range only', () => {
    const e = make([{ id: 'a', kind: 'arc', x: 0, y: 0, w: 40, h: 40, shape: { a0: 0, a1: 90 } }])
    expect(hit(e, { x: 40, y: 20 })).toBe('a') // a=0 endpoint
    expect(hit(e, { x: 0, y: 20 })).toBe(null) // opposite side of ellipse, not swept
  })

  it('curve hits along the anchors path', () => {
    const e = make([
      {
        id: 'c',
        kind: 'curve',
        x: 0,
        y: 0,
        w: 60,
        h: 40,
        shape: { points: [{ fx: 0, fy: 0 }, { fx: 0.5, fy: 1 }, { fx: 1, fy: 0 }] },
      },
    ])
    expect(hit(e, { x: 30, y: 39.5 })).toBe('c') // just below the curve apex
    expect(hit(e, { x: 30, y: 5 })).toBe(null) // below the curve
  })

  it('snaps dragged objects to shape anchors (line endpoints)', () => {
    const e = make([
      { id: 'l', kind: 'line', x: 0, y: 0, w: 40, h: 40 },
      { id: 'b', kind: 'rect', x: 80, y: 80, w: 10, h: 10 },
    ])
    // drag rect's top-left corner toward the line endpoint at (0,0)... (40,40) end is nearer
    e.pointerDown(e.worldToScreen({ x: 85, y: 85 }))
    // move so bbox edge (x=80+dx) lands at 40 (line's (1,1) endpoint x)
    e.pointerMove(e.worldToScreen({ x: 85 - 41, y: 85 }))
    expect(e.dragDelta?.x).toBe(-40) // snapped: 80-40=40 = endpoint x
  })

  it('serializes shape and extended style fields', () => {
    const doc = createDocument({ units: 'mm', origin: 'top-left' })
    const withShape = {
      ...doc,
      objects: [
        {
          id: 'c',
          kind: 'curve',
          x: 1,
          y: 2,
          w: 30,
          h: 20,
          shape: { points: [{ fx: 0, fy: 0.5 }, { fx: 0.5, fy: 0 }, { fx: 1, fy: 0.5 }] },
          style: { stroke: '#333', width: 2.5, dash: [2, 2], capStart: 'dot' as const, capEnd: 'arrow' as const },
        },
        { id: 'a', kind: 'arc', x: 0, y: 0, w: 40, h: 40, shape: { a0: 0, a1: 270 } },
      ],
    }
    const out = deserializeDoc(serializeDoc(withShape))
    expect(out).toEqual(withShape)
  })
})

describe('lock, group, page and connectReplace', () => {
  function make(objs: WorldObject[], docExtra: Partial<ReturnType<typeof createDocument>> = {}) {
    const e = new Engine({ units: 'mm', origin: 'bottom-left', grid: { size: 10, snap: true } }, objs)
    if (Object.keys(docExtra).length) e.doc = { ...e.doc, ...docExtra }
    e.viewport = { x: 0, y: 500, zoom: 1 }
    return e
  }
  const dragBy = (e: Engine, from: { x: number; y: number }, to: { x: number; y: number }, opts?: { detached?: boolean }) => {
    e.pointerDown(e.worldToScreen(from), opts)
    e.pointerMove(e.worldToScreen(to))
    e.pointerUp()
  }

  it('locked object: selectable, not draggable, not removable, not resizable', () => {
    const e = make([{ id: 'a', kind: 'rect', x: 0, y: 0, w: 20, h: 10, locked: true }])
    dragBy(e, { x: 10, y: 5 }, { x: 30, y: 25 })
    expect(e.doc.objects[0].x).toBe(0)
    expect(e.selectedIds.has('a')).toBe(true)
    e.removeSelected()
    expect(e.doc.objects.length).toBe(1)
    e.startResize(e.worldToScreen({ x: 0, y: 0 }), 'a', { x: 1, y: 1 })
    e.pointerMove(e.worldToScreen({ x: 50, y: 50 }))
    e.pointerUp()
    expect(e.doc.objects[0].w).toBe(20)
  })

  it('group members drag together; Alt+drag detaches', () => {
    const objs = [
      { id: 'g1', kind: 'rect', x: 0, y: 0, w: 10, h: 10, group: 'g' },
      { id: 'g2', kind: 'rect', x: 20, y: 0, w: 10, h: 10, group: 'g' },
      { id: 'u', kind: 'rect', x: 50, y: 0, w: 10, h: 10 },
    ]
    const e = make(objs)
    e.setSelection(['g1'])
    dragBy(e, { x: 5, y: 5 }, { x: 15, y: 5 })
    const moved = e.doc.objects
    expect(moved[0].x).toBe(10)
    expect(moved[1].x).toBe(30)
    expect(moved[2].x).toBe(50)

    const e2 = make(objs)
    e2.setSelection(['g1'])
    dragBy(e2, { x: 5, y: 5 }, { x: 15, y: 5 }, { detached: true })
    expect(e2.doc.objects[0].x).toBe(10)
    expect(e2.doc.objects[1].x).toBe(20)
  })

  it('snapExtra and doc.page edges join snap targets', () => {
    const e = make([{ id: 'b', kind: 'rect', x: 80, y: 80, w: 10, h: 10 }], {
      page: { x: 0, y: 0, w: 200, h: 100 },
    })
    // drag left edge toward page's right edge x=200 — wait, object at 80; move so its right edge snaps to 200? drag by 113 → right edge at 203, tol 6px≈1.6mm — snap to 200 needs |203-200|>tol. Instead snap left edge to page left edge x=0: drag dx=-81 → left at -1, snaps to 0 → dx=-80
    e.pointerDown(e.worldToScreen({ x: 85, y: 85 }))
    e.pointerMove(e.worldToScreen({ x: 85 - 81, y: 85 }))
    expect(e.dragDelta?.x).toBe(-80) // snapped to page edge x=0
    e.pointerUp()

    const e2 = make([{ id: 'b', kind: 'rect', x: 80, y: 80, w: 10, h: 10 }])
    e2.snapExtra = { xs: [50], ys: [] }
    e2.pointerDown(e2.worldToScreen({ x: 85, y: 85 }))
    e2.pointerMove(e2.worldToScreen({ x: 85 - 29, y: 85 }))
    expect(e2.dragDelta?.x).toBe(-30) // snapped: 80-30=50 = snapExtra x
  })

  it('connectReplace swaps the wire on an occupied input', () => {
    const ports = [
      { id: 'out', fx: 1, fy: 0.5 },
      { id: 'a', fx: 0, fy: 0.5 },
    ]
    const e = make([
      { id: 's1', kind: 'rect', x: 0, y: 0, w: 10, h: 10, ports: [ports[0]] },
      { id: 's2', kind: 'rect', x: 0, y: 30, w: 10, h: 10, ports: [ports[0]] },
      { id: 't', kind: 'rect', x: 60, y: 10, w: 10, h: 10, ports: [ports[0], ports[1]] },
    ])
    const connect = (fromObj: string, sx: number, sy: number) => {
      e.startConnect(e.worldToScreen({ x: sx, y: sy }), fromObj, 'out')
      e.pointerMove(e.worldToScreen({ x: 60, y: 15 }))
      e.pointerUp()
    }
    connect('s1', 10, 5)
    expect(e.doc.edges.length).toBe(1)
    e.connectReplace = (_f, to) =>
      e.doc.edges.filter((w) => w.to.obj === to.obj && w.to.port === to.port).map((w) => w.id)
    connect('s2', 10, 35)
    expect(e.doc.edges.length).toBe(1)
    expect(e.doc.edges[0].from.obj).toBe('s2')
    // undo restores the replaced wire and drops the new one
    e.undo()
    expect(e.doc.edges.length).toBe(1)
    expect(e.doc.edges[0].from.obj).toBe('s1')
  })

  it('rectContains and rectOverlapArea', () => {
    expect(rectContains({ x: 0, y: 0, w: 100, h: 100 }, { x: 10, y: 10, w: 20, h: 20 })).toBe(true)
    expect(rectContains({ x: 0, y: 0, w: 100, h: 100 }, { x: 90, y: 10, w: 20, h: 20 })).toBe(false)
    expect(rectOverlapArea({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(25)
    expect(rectOverlapArea({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 })).toBe(0)
  })

  it('serializes locked/group/page/double', () => {
    const doc = createDocument({ units: 'mm', origin: 'top-left' })
    const d = {
      ...doc,
      page: { x: 0, y: 0, w: 200, h: 100 },
      objects: [
        { id: 'a', kind: 'rect', x: 1, y: 2, w: 3, h: 4, locked: true, group: 'g1' },
        { id: 'l', kind: 'line', x: 0, y: 0, w: 10, h: 10, style: { stroke: '#333', width: 4, double: true } },
      ],
      edges: [
        { id: 'e1', from: { obj: 'a' }, to: { obj: 'l' }, style: { color: '#333', width: 4, double: true } },
      ],
    }
    const out = deserializeDoc(serializeDoc(d))
    expect(out).toEqual(d)
  })
})

describe('collision, layer and major grid', () => {
  function make(objs: WorldObject[]) {
    const e = new Engine({ units: 'mm', origin: 'bottom-left', grid: { size: 10, snap: true } }, objs)
    e.viewport = { x: 0, y: 500, zoom: 1 }
    return e
  }
  const dragBy = (e: Engine, from: { x: number; y: number }, to: { x: number; y: number }) => {
    e.pointerDown(e.worldToScreen(from))
    e.pointerMove(e.worldToScreen(to))
    e.pointerUp()
  }
  const wall = { id: 'w', kind: 'wall', x: 100, y: 0, w: 120, h: 20, solid: true }
  const desk = { id: 'd', kind: 'furniture', x: 0, y: 0, w: 50, h: 30, solid: true }
  const paper = { id: 'p', kind: 'note', x: 0, y: 50, w: 30, h: 20 } // non-solid

  it('reject mode: dragging a solid onto a solid does not commit', () => {
    const e = make([wall, desk])
    e.collisionMode = 'reject'
    e.pointerDown(e.worldToScreen({ x: 10, y: 10 }))
    e.pointerMove(e.worldToScreen({ x: 110, y: 10 })) // desk lands on the wall
    expect(e.dragInvalid).toBe(true)
    e.pointerUp()
    expect(e.doc.objects[1].x).toBe(0)
    expect(e.dragInvalid).toBe(false)
  })

  it('edge-touching is legal: abutting a wall commits', () => {
    const e = make([wall, desk])
    e.collisionMode = 'reject'
    // desk right edge lands exactly on wall left edge (x=100): drag dx=50
    dragBy(e, { x: 10, y: 10 }, { x: 60, y: 10 })
    expect(e.doc.objects[1].x).toBe(50)
  })

  it('flag mode commits but marks the gesture invalid', () => {
    const e = make([wall, desk])
    e.collisionMode = 'flag'
    e.pointerDown(e.worldToScreen({ x: 10, y: 10 }))
    e.pointerMove(e.worldToScreen({ x: 110, y: 10 }))
    expect(e.dragInvalid).toBe(true)
    e.pointerUp()
    expect(e.doc.objects[1].x).toBe(100)
  })

  it('canOverlap whitelists a pair (door on wall)', () => {
    const door = { id: 'door', kind: 'door', x: 0, y: 50, w: 80, h: 20, solid: true }
    const e = make([wall, door])
    e.collisionMode = 'reject'
    e.canOverlap = (a, b) => a.kind === 'door' && b.kind === 'wall'
    dragBy(e, { x: 10, y: 60 }, { x: 110, y: 10 })
    expect(e.doc.objects[1].x).toBe(100)
  })

  it('non-solid movers and non-solid obstacles never collide', () => {
    const e = make([wall, paper])
    e.collisionMode = 'reject'
    dragBy(e, { x: 10, y: 55 }, { x: 110, y: 5 }) // paper is not solid → free
    expect(e.doc.objects[1].x).toBe(100)
    const e2 = make([wall, paper])
    e2.collisionMode = 'reject'
    dragBy(e2, { x: 110, y: 10 }, { x: 10, y: 60 }) // wall onto non-solid paper → free
    expect(e2.doc.objects[0].x).toBe(0)
  })

  it('resize into a solid is rejected', () => {
    const e = make([wall, { id: 'd', kind: 'furniture', x: 0, y: 0, w: 50, h: 20, solid: true }])
    e.collisionMode = 'reject'
    e.startResize(e.worldToScreen({ x: 0, y: 0 }), 'd', { x: 1, y: 0 })
    e.pointerMove(e.worldToScreen({ x: 110, y: 10 }))
    expect(e.dragInvalid).toBe(true)
    e.pointerUp()
    expect(e.doc.objects[1].w).toBe(50)
  })

  it('collisions() returns intersecting solids only', () => {
    const e = make([wall, desk, paper])
    const hits = e.collisions({ x: 110, y: 5, w: 50, h: 20 }).map((o) => o.id)
    expect(hits).toEqual(['w']) // paper is non-solid; desk does not intersect
    const e2 = make([
      wall,
      { id: 'd2', kind: 'furniture', x: 130, y: 0, w: 50, h: 20, solid: true },
    ])
    expect(e2.collisions({ x: 0, y: 0, w: 300, h: 30 }).map((o) => o.id)).toEqual(['w', 'd2'])
  })

  it('layer orders hit-testing regardless of array order', () => {
    const e = make([
      { id: 'top', kind: 'rect', x: 0, y: 0, w: 40, h: 40, layer: 10 },
      { id: 'bottom', kind: 'rect', x: 0, y: 0, w: 40, h: 40, layer: -10 },
    ])
    // 'bottom' is last in array order (would win without layers),
    // but layer 10 paints 'top' above it
    expect(e.objectAt(e.worldToScreen({ x: 20, y: 20 }))?.id).toBe('top')
  })

  it('serializes solid/layer/grid.major', () => {
    const doc = createDocument({ units: 'mm', origin: 'top-left', grid: { size: 10, snap: true, major: 10 } })
    const d = {
      ...doc,
      objects: [
        { id: 'a', kind: 'rect', x: 1, y: 2, w: 3, h: 4, solid: true, layer: 5 },
        { id: 'b', kind: 'rect', x: 0, y: 0, w: 1, h: 1 },
      ],
    }
    const out = deserializeDoc(serializeDoc(d))
    expect(out).toEqual(d)
    expect(out.grid.major).toBe(10)
  })
})

describe('rotation', () => {
  function make(objs: WorldObject[], snapGrid = true) {
    const e = new Engine(
      { units: 'mm', origin: 'bottom-left', grid: { size: 10, snap: snapGrid } },
      objs,
    )
    e.viewport = { x: 0, y: 500, zoom: 1 }
    return e
  }
  const box = { id: 'a', kind: 'rect', x: 0, y: 0, w: 100, h: 50 } // center (50,25)

  it('hit-tests the rotated outline, not the unrotated bbox', () => {
    const e = make([{ ...box, rot: 45 }])
    // rotated +x corner: (50,25) + 50·(cos45,sin45) ≈ (85.4, 60.4); (85,60) lands inside
    expect(e.objectAt(e.worldToScreen({ x: 85, y: 60 }))?.id).toBe('a')
    // the unrotated bbox corner (0,50) lies outside the rotated outline
    expect(e.objectAt(e.worldToScreen({ x: 1, y: 49 }))).toBeNull()
  })

  it('marquee uses the OBB — a rotated corner selects, an AABB-only point does not', () => {
    const e = make([{ ...box, rot: 45 }])
    // world (20,55) is inside the AABB but outside the rotated box
    e.pointerDown(e.worldToScreen({ x: 15, y: 50 }))
    e.pointerMove(e.worldToScreen({ x: 25, y: 60 }))
    e.pointerUp()
    expect(e.selectedIds.size).toBe(0)
    // the rotated corner around (85.4, 60.4) is real geometry
    e.pointerDown(e.worldToScreen({ x: 80, y: 55 }))
    e.pointerMove(e.worldToScreen({ x: 90, y: 65 }))
    e.pointerUp()
    expect(e.selectedIds.has('a')).toBe(true)
  })

  it('collisions are OBB-aware under reject', () => {
    const wall = { id: 'w', kind: 'wall', x: 60, y: 60, w: 40, h: 20, solid: true }
    // box rotated 45°: its tip reaches x≈85 — dragging right overlaps the wall
    const e = make([{ ...box, rot: 45, solid: true }, wall], false)
    e.collisionMode = 'reject'
    e.pointerDown(e.worldToScreen({ x: 50, y: 25 }))
    e.pointerMove(e.worldToScreen({ x: 60, y: 25 })) // dx=+10 → tip reaches the wall
    expect(e.dragInvalid).toBe(true)
    e.pointerUp()
    expect(e.doc.objects[0].x).toBe(0)
  })

  it('snap targets include rotated vertices', () => {
    // 'a' rotated 90°: corner (0,0) maps to world (75,-25)
    const b = { id: 'b', kind: 'rect', x: 200, y: 0, w: 20, h: 20 }
    const e = make([{ ...box, rot: 90 }, b])
    e.pointerDown(e.worldToScreen({ x: 205, y: 10 }))
    e.pointerMove(e.worldToScreen({ x: 79, y: 10 })) // b.x → 74, vertex x=75 in range
    e.pointerUp()
    expect(e.doc.objects[1].x).toBe(75)
  })

  it('rotate gesture commits degrees; shift-style angleSnap rounds to 15°', () => {
    const e = make([box], false)
    e.startRotate(e.worldToScreen({ x: 150, y: 25 }), 'a') // east of center → 0°
    e.pointerMove(e.worldToScreen({ x: 50, y: 125 })) // due north → +90°
    expect(e.rotate?.deg).toBeCloseTo(90, 1)
    e.pointerUp()
    expect(e.doc.objects[0].rot).toBeCloseTo(90, 1)

    const e2 = make([box], false)
    e2.startRotate(e2.worldToScreen({ x: 150, y: 25 }), 'a')
    // atan2(69,71) ≈ 44.16° — snaps to 45 with angleSnap
    e2.pointerMove(e2.worldToScreen({ x: 121, y: 94 }), { angleSnap: true })
    expect(e2.rotate?.deg).toBe(45)
    e2.pointerUp()
    expect(e2.doc.objects[0].rot).toBe(45)
  })

  it('resizing a rotated object works in local axes', () => {
    const e = make([{ ...box, rot: 90 }], false)
    // dir x+1 = local max-x edge; the rotated handle sits at world (50,75)
    e.startResize(e.worldToScreen({ x: 50, y: 75 }), 'a', { x: 1, y: 0 })
    e.pointerMove(e.worldToScreen({ x: 50, y: 125 })) // +100 world-y → local x = 150
    e.pointerUp()
    expect(e.doc.objects[0]).toMatchObject({ w: 150, h: 50, rot: 90 })
  })

  it('ports resolve through rotation', () => {
    const o = {
      ...box,
      rot: 90,
      ports: [{ id: 'p', fx: 1, fy: 0.5 }],
    }
    const e = make([o])
    // local (100,25) → rot90 → (50,75)
    const p = endpointPos(e.doc, { obj: 'a', port: 'p' })
    expect(p?.x).toBeCloseTo(50, 6)
    expect(p?.y).toBeCloseTo(75, 6)
  })

  it('serializes rot', () => {
    const doc = createDocument({ units: 'mm' })
    const d = { ...doc, objects: [{ id: 'r', kind: 'rect', x: 0, y: 0, w: 10, h: 10, rot: 30 }] }
    const out = deserializeDoc(serializeDoc(d))
    expect(out.objects[0].rot).toBe(30)
  })
})

describe('objectsIn / canPlace / tryMove / polygon', () => {
  function make(objs: WorldObject[]) {
    const e = new Engine(
      { units: 'mm', origin: 'bottom-left', grid: { size: 10, snap: true } },
      objs,
    )
    e.viewport = { x: 0, y: 500, zoom: 1 }
    return e
  }
  const wall = { id: 'w', kind: 'wall', x: 100, y: 0, w: 120, h: 20, solid: true }
  const rock = {
    id: 'rock', kind: 'polygon', x: 300, y: 0, w: 100, h: 100, solid: true, locked: true,
    // L-shaped concave polygon in normalized anchors
    shape: {
      points: [
        { fx: 0, fy: 0 }, { fx: 0.6, fy: 0 }, { fx: 0.6, fy: 0.4 },
        { fx: 1, fy: 0.4 }, { fx: 1, fy: 1 }, { fx: 0, fy: 1 },
      ],
    },
    style: { fill: '#888' },
  }
  const unit = { id: 'u', kind: 'unit', x: 0, y: 0, w: 30, h: 30, solid: true }

  it('objectsIn returns non-solid objects too; collisions stays solid-only', () => {
    const paper = { id: 'p', kind: 'note', x: 105, y: 5, w: 30, h: 10 }
    const e = make([wall, paper])
    expect(e.objectsIn({ x: 100, y: 0, w: 60, h: 30 }).map((o) => o.id)).toEqual(['w', 'p'])
    expect(e.collisions({ x: 100, y: 0, w: 60, h: 30 }).map((o) => o.id)).toEqual(['w'])
  })

  it('tryMove respects the collision policy and locks', () => {
    const e = make([wall, unit, rock])
    e.collisionMode = 'reject'
    expect(e.tryMove('u', 100, 0)).toBe(false) // would land on the wall
    expect(e.tryMove('u', 50, 30)).toBe(true) // free space commits
    expect(e.doc.objects[1].x).toBe(50)
    expect(e.tryMove('rock', 10, 10)).toBe(false) // locked never moves
    const free = make([wall, unit])
    expect(free.tryMove('u', 100, 0)).toBe(true) // collisionMode none → free
  })

  it('canPlace is a pure solid-policy check', () => {
    const e = make([wall, unit])
    expect(e.canPlace(unit, { x: 100, y: 0, w: 30, h: 30 })).toBe(false) // on the wall
    expect(e.canPlace(unit, { x: 60, y: 0, w: 30, h: 30 })).toBe(true) // abutting
    expect(e.canPlace(unit)).toBe(true) // its own current spot
  })

  it('polygon hit test: interior fills, concave notch does not', () => {
    const e = make([rock])
    // the notch cut out of the L is at fx 0.6-1.0 / fy 0-0.4 → world (360-400, 0-40)
    expect(e.objectAt(e.worldToScreen({ x: 320, y: 60 }))?.id).toBe('rock') // inside body
    expect(e.objectAt(e.worldToScreen({ x: 390, y: 10 }))).toBeNull() // inside the notch
  })

  it('polygon collision uses the real outline, not the bbox', () => {
    const e = make([rock, unit])
    e.collisionMode = 'reject'
    // unit dragged into the notch area — no actual overlap with the L
    expect(e.tryMove('u', 370, 5)).toBe(true)
    // dragged into the solid body — rejected
    const e2 = make([rock, { ...unit, id: 'u2' }])
    e2.collisionMode = 'reject'
    expect(e2.tryMove('u2', 330, 50)).toBe(false)
  })

  it('concave polygon vs concave polygon detects real overlap', () => {
    const e = make([rock, { ...rock, id: 'rock2', locked: false }])
    e.collisionMode = 'reject'
    // slide rock2 left so its body enters rock's notch — still an overlap
    expect(e.tryMove('rock2', -40, 0)).toBe(false)
    // sliding it far right is free
    expect(e.tryMove('rock2', 200, 0)).toBe(true)
  })

  it('serializes polygon shape points', () => {
    const doc = createDocument({ units: 'mm' })
    const d = { ...doc, objects: [rock as WorldObject] }
    const out = deserializeDoc(serializeDoc(d))
    expect(out.objects[0].shape?.points?.length).toBe(6)
  })
})

describe('doc serialize', () => {
  it('roundtrips units/origin/grid/objects', () => {
    const doc = createDocument({ units: 'inch', origin: 'top-left', grid: { size: 0.5, snap: false } })
    const withObj = { ...doc, objects: [{ id: 'x', kind: 'rect', x: 1, y: 2, w: 3, h: 4 }] }
    const out = deserializeDoc(serializeDoc(withObj))
    expect(out).toEqual(withObj)
  })

  it('rejects invalid json', () => {
    expect(() => deserializeDoc('{"foo":1}')).toThrow()
  })
})

describe('spatial index (v1.3)', () => {
  const make = (objs: WorldObject[]) => {
    const e = new Engine({ units: 'mm', origin: 'top-left' }, objs)
    e.viewport = { x: 0, y: 500, zoom: 1 }
    return e
  }
  const box = (id: string, x: number, y: number, w = 10, h = 10): WorldObject =>
    ({ id, kind: 'rect', x, y, w, h, solid: true })

  it('narrows queries to nearby candidates and keeps doc order on a large doc', () => {
    // 600 packed units + one huge non-solid site — the site exceeds the
    // per-object cell cap and lands in the always-candidates bucket
    const objs: WorldObject[] = [
      { id: 'site', kind: 'site', x: -500, y: -500, w: 5000, h: 5000, solid: false },
    ]
    for (let r = 0; r < 24; r++)
      for (let c = 0; c < 25; c++) objs.push(box(`u${r}x${c}`, c * 40, r * 40))
    const e = make(objs)
    e.collisionMode = 'reject'

    const hits = e.objectsIn({ x: -1, y: -1, w: 82, h: 12 })
    expect(hits.map((o) => o.id)).toEqual(['site', 'u0x0', 'u0x1', 'u0x2'])
    expect(e.collisions({ x: -1, y: -1, w: 82, h: 12 }).map((o) => o.id)).toEqual([
      'u0x0', 'u0x1', 'u0x2',
    ])
    // far away → only the always-candidate site (non-solid → no
    // collision hits at all), even though the doc is big
    expect(e.objectsIn({ x: 3000, y: 3000, w: 10, h: 10 }).map((o) => o.id)).toEqual(['site'])
    expect(e.collisions({ x: 3000, y: 3000, w: 10, h: 10 })).toEqual([])
    // canPlace agrees with the same narrowed check (offset by 5 —
    // polysIntersect treats coincident edges as non-overlapping)
    expect(e.canPlace(box('c', 5, 0))).toBe(false)
    expect(e.canPlace(box('c', 500, 500))).toBe(true)
  })

  it('follows doc mutations — the index rebuilds against the new doc', () => {
    const e = make([box('a', 0, 0), box('b', 1000, 0)])
    e.collisionMode = 'reject'
    // build the index with a first query, then mutate
    expect(e.objectsIn({ x: 990, y: -1, w: 20, h: 12 }).map((o) => o.id)).toEqual(['b'])
    expect(e.tryMove('b', -980, 0)).toBe(true) // lands at (20,0) — clear of a
    expect(e.objectsIn({ x: 990, y: -1, w: 20, h: 12 })).toEqual([])
    expect(e.objectsIn({ x: 15, y: -1, w: 20, h: 12 }).map((o) => o.id)).toEqual(['b'])
  })

  it('rotated objects are found via their OBB AABB', () => {
    const e = make([{ ...box('r', 0, 0, 20, 20), rot: 45 }])
    // the +x corner of a 45°-rotated 20×20 reaches x ≈ 10 + 14.14
    expect(e.objectAt(e.worldToScreen({ x: 24, y: 10 }))?.id).toBe('r')
    expect(e.objectAt(e.worldToScreen({ x: 200, y: 200 }))).toBe(null)
  })
})

describe('shape vertex editing (P48)', () => {
  const cfg = {
    units: 'mm' as const,
    origin: 'bottom-left' as const,
    grid: { size: 10, snap: true },
  }
  const line: WorldObject = {
    id: 'l',
    kind: 'line',
    x: 0,
    y: 0,
    w: 40,
    h: 30,
    // no points → default chord (0,0)→(1,1)
  }
  const curve: WorldObject = {
    id: 'c',
    kind: 'curve',
    x: 0,
    y: 0,
    w: 40,
    h: 20,
    shape: {
      points: [
        { fx: 0, fy: 0.5 },
        { fx: 0.5, fy: 1 },
        { fx: 1, fy: 0.5 },
      ],
    },
  }
  const make = (objs: WorldObject[]) => {
    const e = new Engine(cfg, objs)
    e.viewport = { x: 0, y: 500, zoom: 1 }
    return e
  }

  it('setShapePoint re-normalizes bbox and anchors', () => {
    const e = make([line])
    // drag anchor 0 to (-10,-10): bbox grows, anchor1 stays at fx=fy=1
    const next = e.doc.objects[0]
    e.startVertexMove({ x: 0, y: 0 }, 'l', 0)
    e.pointerMove(e.worldToScreen({ x: -8, y: -8 })) // snaps to (-10,-10)
    e.pointerUp()
    const o = e.doc.objects[0]
    expect(o).toMatchObject({ x: -10, y: -10, w: 50, h: 40 })
    expect(o.shape?.points).toEqual([
      { fx: 0, fy: 0 },
      { fx: 1, fy: 1 },
    ])
    expect(next).not.toBe(o)
  })

  it('live preview patches the doc silently; pointerUp commits once', () => {
    const e = make([line])
    let emitted = 0
    e.onDocChange(() => emitted++)
    e.startVertexMove({ x: 0, y: 0 }, 'l', 1)
    e.pointerMove(e.worldToScreen({ x: 55, y: 35 })) // snaps to (60,40)? → (50,40)
    // during the gesture the doc is already patched (renderers follow),
    // but no history entry / docListener fires yet
    expect(emitted).toBe(0)
    expect(e.doc.objects[0].w).toBeGreaterThan(40)
    e.pointerUp()
    expect(emitted).toBe(1)
    expect(e.vertex).toBeNull()
    expect(e.mode).toBe('idle')
    // one undo restores the whole gesture
    e.undo()
    expect(e.doc.objects[0]).toMatchObject({ x: 0, y: 0, w: 40, h: 30 })
  })

  it('collapses a fully degenerate axis to fraction 0.5', () => {
    const e = make([line])
    e.startVertexMove({ x: 0, y: 0 }, 'l', 1)
    e.pointerMove(e.worldToScreen({ x: -2, y: -2 })) // snaps to (0,0)
    e.pointerUp()
    const o = e.doc.objects[0]
    // snapped -0 may survive — normalize before comparing
    expect([o.x + 0, o.y + 0, o.w + 0, o.h + 0]).toEqual([0, 0, 0, 0])
    expect(o.shape?.points).toEqual([
      { fx: 0.5, fy: 0.5 },
      { fx: 0.5, fy: 0.5 },
    ])
  })

  it('ignores out-of-range indices and non-shape kinds', () => {
    const e = make([line, { id: 'r', kind: 'rect', x: 0, y: 0, w: 10, h: 10 }])
    e.startVertexMove({ x: 0, y: 0 }, 'l', 5)
    expect(e.mode).toBe('idle')
    e.startVertexMove({ x: 0, y: 0 }, 'r', 0)
    expect(e.mode).toBe('idle')
  })

  it('insertShapeVertex adds an anchor on the nearest segment', () => {
    const e = make([curve])
    e.setSelection(['c'])
    // dblclick near the first segment midpoint (world 10,15)
    expect(e.insertShapeVertex(e.worldToScreen({ x: 10, y: 15 }))).toBe(true)
    const pts = e.doc.objects[0].shape!.points!
    expect(pts).toHaveLength(4)
    // bbox re-normalizes to (0,10)-(40,20) — inserted world (10,15)
    // lands at fx=0.25, fy=0.5
    expect(pts[1].fx).toBeCloseTo(0.25)
    expect(pts[1].fy).toBeCloseTo(0.5)
    // far from the outline → no insert
    expect(e.insertShapeVertex(e.worldToScreen({ x: 200, y: 200 }))).toBe(false)
    // a 'line' keeps its two-anchor contract
    const el = make([line])
    el.setSelection(['l'])
    expect(el.insertShapeVertex(el.worldToScreen({ x: 20, y: 15 }))).toBe(false)
  })

  it('deleteShapeVertex removes an anchor, honoring the minimum', () => {
    const e = make([curve])
    e.deleteShapeVertex('c', 1)
    const o = e.doc.objects[0]
    expect(o.shape!.points).toHaveLength(2)
    // bbox shrinks to the remaining anchors (10,10)-(40,10) → degenerate h
    expect(o).toMatchObject({ x: 0, y: 10, w: 40, h: 0 })
    // curve at the 2-anchor minimum refuses further deletion
    e.deleteShapeVertex('c', 0)
    expect(e.doc.objects[0].shape!.points).toHaveLength(2)
  })
})

describe('multi-point shape draw (P49) and resizeAspect', () => {
  const e = () => new Engine({ units: 'mm', origin: 'top-left', grid: { size: 5, snap: true } })
  const click = (en: Engine, x: number, y: number) => {
    en.pointerDown(en.worldToScreen({ x, y }))
    en.pointerUp()
  }

  it('click chain builds a curve object with normalized anchors', () => {
    const en = e()
    en.startShapeDraw('curve')
    click(en, 10, 10)
    click(en, 20, 30)
    click(en, 40, 10)
    expect(en.mode).toBe('shape') // click chain survives pointerUp
    const o = en.commitShapeDraw('c1')
    expect(o).not.toBeNull()
    expect(o).toMatchObject({ id: 'c1', kind: 'curve', x: 10, y: 10, w: 30, h: 20 })
    expect(o!.shape!.points!.map((p) => [p.fx, p.fy])).toEqual([
      [0, 0],
      [expect.closeTo(1 / 3), 1],
      [1, 0],
    ])
    expect(en.selectedIds.has('c1')).toBe(true)
    expect(en.mode).toBe('idle')
  })

  it('commit with <2 points discards; cancel aborts', () => {
    const en = e()
    en.startShapeDraw()
    click(en, 5, 5)
    expect(en.commitShapeDraw('x')).toBeNull()
    en.startShapeDraw()
    click(en, 0, 0)
    click(en, 5, 5)
    en.cancelShapeDraw()
    expect(en.shapeDraw).toBeNull()
    expect(en.doc.objects).toHaveLength(0)
  })

  it('resizeAspect constrains corner drags to the h/w ratio', () => {
    const en = e()
    en.doc.objects.push({ id: 'im', kind: 'image', x: 0, y: 0, w: 20, h: 10 })
    en.resizeAspect = (o) => (o.id === 'im' ? 0.5 : null)
    en.startResize(en.worldToScreen({ x: 20, y: 10 }), 'im', { x: 1, y: 1 })
    // grid snap off → free pointer; drag far right, aspect pulls h
    en.doc.grid.snap = false
    en.pointerMove(en.worldToScreen({ x: 60, y: 15 }))
    expect(en.resize!.rect.w).toBeCloseTo(60)
    expect(en.resize!.rect.h).toBeCloseTo(30)
    en.pointerUp()
  })
})
