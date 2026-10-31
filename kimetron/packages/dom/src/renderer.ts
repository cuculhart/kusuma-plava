import type { Engine, WorldObject } from '@kimetron/core'
import { isShapeKind, renderOrder } from '@kimetron/core'
import { attachInput } from './input'
import {
  bendHandlePoint,
  DOUBLE_INNER,
  doubleWidths,
  EDGE_LINE,
  edgeAttrs,
  edgeMarkerDefs,
  handlePoints,
  handlePointsFor,
  hudText,
  injectStyles,
  marqueeFrame,
  objectFrame,
  pageFrame,
  portPoints,
  rotateHandlePoint,
  routePathD,
  shapeAttrs,
  shapeCapMarkerDefs,
  vertexHandlePoints,
} from './style'

const SVG_NS = 'http://www.w3.org/2000/svg'

function markerEl(def: {
  id: string
  kind: string
  color: string
  strokeW?: number
}): SVGMarkerElement {
  const m = document.createElementNS(SVG_NS, 'marker')
  m.setAttribute('id', def.id)
  m.setAttribute('markerUnits', 'userSpaceOnUse')
  m.setAttribute('orient', 'auto-start-reverse')
  // caps stay proportional to the stroke: thin lines keep the 2px
  // baseline size, thicker ones scale the glyph up via viewBox so
  // the marker is not buried inside the line.
  const k = Math.max(1, (def.strokeW ?? 2) / 2)
  let glyph: SVGElement
  if (def.kind === 'arrow') {
    m.setAttribute('markerWidth', String(10 * k))
    m.setAttribute('markerHeight', String(8 * k))
    m.setAttribute('viewBox', '0 0 10 8')
    m.setAttribute('refX', '9')
    m.setAttribute('refY', '4')
    glyph = document.createElementNS(SVG_NS, 'path')
    glyph.setAttribute('d', 'M 0 0 L 10 4 L 0 8 z')
  } else {
    m.setAttribute('markerWidth', String(8 * k))
    m.setAttribute('markerHeight', String(8 * k))
    m.setAttribute('viewBox', '0 0 8 8')
    m.setAttribute('refX', '4')
    m.setAttribute('refY', '4')
    glyph = document.createElementNS(SVG_NS, 'circle')
    glyph.setAttribute('cx', '4')
    glyph.setAttribute('cy', '4')
    glyph.setAttribute('r', '3')
  }
  glyph.style.fill = def.color
  m.appendChild(glyph)
  return m
}

export interface RendererOptions {
  engine: Engine
  renderObject?: (o: WorldObject) => HTMLElement | string
}

export interface Renderer {
  destroy(): void
}

export function createRenderer(container: HTMLElement, opts: RendererOptions): Renderer {
  const { engine } = opts
  const renderObject = opts.renderObject ?? ((o: WorldObject) => o.id)

  injectStyles()
  container.classList.add('ki-canvas')

  const pageEl = document.createElement('div')
  pageEl.className = 'ki-page'
  pageEl.style.display = 'none'
  container.appendChild(pageEl)

  const edgeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  edgeSvg.setAttribute('class', 'ki-edges')
  container.appendChild(edgeSvg)

  const marqueeEl = document.createElement('div')
  marqueeEl.className = 'ki-marquee'
  marqueeEl.style.display = 'none'
  container.appendChild(marqueeEl)

  const portLayer = document.createElement('div')
  portLayer.className = 'ki-ports'
  container.appendChild(portLayer)

  const guideLayer = document.createElement('div')
  guideLayer.className = 'ki-guides'
  container.appendChild(guideLayer)

  const hudEl = document.createElement('div')
  hudEl.className = 'ki-hud'
  hudEl.style.display = 'none'
  container.appendChild(hudEl)

  const objEls = new Map<string, HTMLElement>()

  const handleEls = handlePoints({ left: 0, top: 0, width: 0, height: 0 }).map((h) => {
    const el = document.createElement('div')
    el.className = 'ki-handle'
    el.dataset.kiHandle = h.dir
    el.hidden = true
    container.appendChild(el)
    return el
  })

  const rotEl = document.createElement('div')
  rotEl.className = 'ki-rot'
  rotEl.dataset.kiRotate = ''
  rotEl.hidden = true
  container.appendChild(rotEl)

  const bendEl = document.createElement('div')
  bendEl.className = 'ki-bend'
  bendEl.dataset.kiBend = ''
  bendEl.hidden = true
  container.appendChild(bendEl)

  const vtxLayer = document.createElement('div')
  vtxLayer.className = 'ki-vtxs'
  container.appendChild(vtxLayer)

  function render(): void {
    const seen = new Set<string>()
    const ordered = renderOrder(engine.doc.objects)
    for (const o of ordered) {
      seen.add(o.id)
      const isShape = isShapeKind(o.kind)
      let el = objEls.get(o.id)
      if (!el) {
        el = document.createElement('div')
        el.className = 'ki-obj'
        el.dataset.id = o.id
        el.dataset.kiObj = o.id
        container.appendChild(el)
        objEls.set(o.id, el)
      }
      const f = objectFrame(engine, o)
      el.style.transform = `translate(${f.left}px, ${f.top}px)${f.rot ? ` rotate(${f.rot}deg)` : ''}`
      el.style.width = `${f.width}px`
      el.style.height = `${f.height}px`
      const sel = engine.selectedIds.has(o.id)
      el.classList.toggle('ki-sel', sel)
      el.classList.toggle('ki-shape', isShape)
      el.classList.toggle(
        'ki-invalid',
        engine.dragInvalid && (sel || engine.resize?.id === o.id),
      )
      if (isShape) {
        el.style.background = ''
        el.style.borderColor = ''
        const sa = shapeAttrs(engine, o)
        if (sa) {
          const svg = document.createElementNS(SVG_NS, 'svg')
          svg.setAttribute('class', 'ki-shape-svg')
          // a 0-size <svg> disables rendering entirely — overflow:visible
          // cannot rescue it — so degenerate shapes need a nonzero viewport
          svg.setAttribute('width', String(Math.max(1, f.width)))
          svg.setAttribute('height', String(Math.max(1, f.height)))
          const defs = document.createElementNS(SVG_NS, 'defs')
          for (const m of shapeCapMarkerDefs(engine, o)) defs.appendChild(markerEl(m))
          const kids: SVGElement[] = [defs]
          if (sa.double) {
            const w = doubleWidths(sa.strokeWidth)
            const outer = document.createElementNS(SVG_NS, 'path')
            outer.setAttribute('d', sa.d)
            outer.setAttribute('fill', sa.fill ?? 'none')
            outer.setAttribute('stroke', sa.stroke ?? '')
            outer.setAttribute('stroke-width', String(w.outer))
            if (sa.strokeDasharray) outer.setAttribute('stroke-dasharray', sa.strokeDasharray)
            kids.push(outer)
            const inner = document.createElementNS(SVG_NS, 'path')
            inner.setAttribute('d', sa.d)
            inner.setAttribute('fill', 'none')
            inner.setAttribute('stroke', DOUBLE_INNER)
            inner.setAttribute('stroke-width', String(w.inner))
            kids.push(inner)
          }
          const p = document.createElementNS(SVG_NS, 'path')
          p.setAttribute('d', sa.d)
          p.setAttribute('fill', sa.double ? 'none' : (sa.fill ?? 'none'))
          if (!sa.double) {
            if (sa.stroke) p.setAttribute('stroke', sa.stroke)
            if (sa.strokeWidth) p.setAttribute('stroke-width', String(sa.strokeWidth))
            if (sa.strokeDasharray) p.setAttribute('stroke-dasharray', sa.strokeDasharray)
          } else {
            // invisible hit/marker carrier — the double rails are drawn above
            p.setAttribute('stroke', 'none')
          }
          if (sa.markerStart) p.setAttribute('marker-start', sa.markerStart)
          if (sa.markerEnd) p.setAttribute('marker-end', sa.markerEnd)
          kids.push(p)
          svg.replaceChildren(...kids)
          el.replaceChildren(svg)
        }
      } else {
        const content = renderObject(o)
        el.replaceChildren()
        if (typeof content === 'string') el.textContent = content
        else el.appendChild(content)
        el.style.background = o.style?.fill ?? ''
        el.style.borderColor = sel ? '' : (o.style?.stroke ?? '')
        el.style.borderWidth = `${o.style?.width ?? 1}px`
        el.style.borderStyle = o.style?.dash
          ? o.style.dash[0] <= 2
            ? 'dotted'
            : 'dashed'
          : ''
      }
    }
    for (const [id, el] of objEls) {
      if (!seen.has(id)) {
        el.remove()
        objEls.delete(id)
      }
    }
    // keep DOM order == paint order (all .ki-obj share z-index: 1)
    for (const o of ordered) {
      const el = objEls.get(o.id)
      if (el) container.appendChild(el)
    }

    const selObj =
      engine.selectedIds.size === 1
        ? engine.doc.objects.find((o) => engine.selectedIds.has(o.id))
        : undefined
    if (selObj) {
      const pts = handlePointsFor(engine, selObj)
      for (const el of handleEls) {
        const p = pts.find((p) => p.dir === el.dataset.kiHandle)
        if (!p) continue
        el.hidden = false
        el.dataset.kiObj = selObj.id
        el.style.transform = `translate(${p.x}px, ${p.y}px)`
        el.style.cursor = p.cursor
      }
      const rp = rotateHandlePoint(engine, selObj)
      if (rp) {
        rotEl.hidden = false
        rotEl.dataset.kiObj = selObj.id
        rotEl.style.transform = `translate(${rp.x}px, ${rp.y}px)`
      } else {
        rotEl.hidden = true
      }
    } else {
      for (const el of handleEls) el.hidden = true
      rotEl.hidden = true
    }

    const bp = bendHandlePoint(engine)
    if (bp) {
      bendEl.hidden = false
      bendEl.dataset.kiEdge = bp.id
      bendEl.style.transform = `translate(${bp.x}px, ${bp.y}px)`
      bendEl.style.cursor = bp.cursor
    } else {
      bendEl.hidden = true
    }

    vtxLayer.replaceChildren(
      ...(selObj ? vertexHandlePoints(engine, selObj) : []).map((v) => {
        const el = document.createElement('div')
        el.className = 'ki-vtx'
        el.dataset.kiObj = selObj!.id
        el.dataset.kiVtx = String(v.index)
        el.style.transform = `translate(${v.x}px, ${v.y}px)`
        return el
      }),
    )

    const defs = document.createElementNS(SVG_NS, 'defs')
    for (const e of engine.doc.edges) {
      for (const m of edgeMarkerDefs(engine, e)) defs.appendChild(markerEl(m))
    }
    const edgeEls = engine.doc.edges.flatMap((e) => {
      const a = edgeAttrs(engine, e)
      if (!a) return []
      const cls = engine.selectedIds.has(e.id) ? 'ki-edge ki-sel' : 'ki-edge'
      const out: SVGElement[] = []
      if (a.double) {
        const w = doubleWidths(a.strokeWidth)
        const outer = document.createElementNS(SVG_NS, 'path')
        outer.setAttribute('class', cls)
        outer.setAttribute('d', a.d)
        outer.setAttribute('stroke', a.stroke ?? EDGE_LINE)
        outer.setAttribute('stroke-width', String(w.outer))
        if (a.strokeDasharray) outer.setAttribute('stroke-dasharray', a.strokeDasharray)
        out.push(outer)
        const inner = document.createElementNS(SVG_NS, 'path')
        inner.setAttribute('class', cls)
        inner.setAttribute('d', a.d)
        inner.setAttribute('stroke', DOUBLE_INNER)
        inner.setAttribute('stroke-width', String(w.inner))
        out.push(inner)
      }
      const p = document.createElementNS(SVG_NS, 'path')
      p.setAttribute('class', cls)
      p.setAttribute('d', a.d)
      if (a.double) {
        p.setAttribute('stroke', 'none')
      } else {
        p.setAttribute('stroke', a.stroke ?? EDGE_LINE)
        p.setAttribute('stroke-width', String(a.strokeWidth ?? 1.5))
        if (a.strokeDasharray) p.setAttribute('stroke-dasharray', a.strokeDasharray)
      }
      if (a.markerStart) p.setAttribute('marker-start', a.markerStart)
      if (a.markerEnd) p.setAttribute('marker-end', a.markerEnd)
      out.push(p)
      return out
    })
    const preview = engine.connectPreview()
    if (preview) {
      const p = document.createElementNS(SVG_NS, 'path')
      p.setAttribute(
        'class',
        engine.connect?.invalid ? 'ki-edge-preview ki-invalid' : 'ki-edge-preview',
      )
      p.setAttribute('d', routePathD(engine, preview.from, preview.to, 'straight'))
      edgeEls.push(p)
    }
    edgeSvg.replaceChildren(defs, ...edgeEls)

    portLayer.replaceChildren(
      ...engine.doc.objects.flatMap((o) =>
        portPoints(engine, o).map(({ port, x, y }) => {
          const el = document.createElement('div')
          el.className = 'ki-port'
          el.dataset.kiObj = o.id
          el.dataset.kiPort = port.id
          el.style.transform = `translate(${x}px, ${y}px)`
          return el
        }),
      ),
    )

    guideLayer.replaceChildren(
      ...engine.guides.map((g) => {
        const el = document.createElement('div')
        if (g.axis === 'x') {
          el.className = 'ki-guide ki-guide-v'
          el.style.left = `${engine.worldToScreen({ x: g.at, y: 0 }).x}px`
        } else {
          el.className = 'ki-guide ki-guide-h'
          el.style.top = `${engine.worldToScreen({ x: 0, y: g.at }).y}px`
        }
        return el
      }),
    )

    const mf = marqueeFrame(engine)
    if (mf) {
      marqueeEl.style.display = ''
      marqueeEl.style.transform = `translate(${mf.left}px, ${mf.top}px)`
      marqueeEl.style.width = `${mf.width}px`
      marqueeEl.style.height = `${mf.height}px`
    } else {
      marqueeEl.style.display = 'none'
    }

    const pf = pageFrame(engine)
    if (pf) {
      pageEl.style.display = ''
      pageEl.style.transform = `translate(${pf.left}px, ${pf.top}px)`
      pageEl.style.width = `${pf.width}px`
      pageEl.style.height = `${pf.height}px`
    } else {
      pageEl.style.display = 'none'
    }

    const hud = hudText(engine)
    hudEl.style.display = hud ? '' : 'none'
    if (hud) hudEl.textContent = hud
  }

  const unsubscribe = engine.subscribe(render)
  const detach = attachInput(container, engine)
  render()

  return {
    destroy() {
      unsubscribe()
      detach()
      for (const el of objEls.values()) el.remove()
      objEls.clear()
      for (const el of handleEls) el.remove()
      rotEl.remove()
      bendEl.remove()
      vtxLayer.remove()
      pageEl.remove()
      hudEl.remove()
      marqueeEl.remove()
      guideLayer.remove()
      portLayer.remove()
      edgeSvg.remove()
      container.classList.remove('ki-canvas')
    },
  }
}
