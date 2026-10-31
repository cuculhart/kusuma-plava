import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Engine, isShapeKind, renderOrder } from '@kimetron/core'
import type { Doc, WorldConfig, WorldObject } from '@kimetron/core'
import { attachInput, bendHandlePoint, DOUBLE_INNER, doubleWidths, EDGE_LINE, edgeAttrs, edgeMarkerDefs, gridBackground, handlePointsFor, hudText, injectStyles, marqueeFrame, objectFrame, pageFrame, portPoints, rotateHandlePoint, routePathD, shapeAttrs, shapeCapMarkerDefs, vertexHandlePoints } from '@kimetron/dom'

export function useEngine(cfg?: WorldConfig): Engine {
  const ref = useRef<Engine | null>(null)
  if (!ref.current) ref.current = new Engine(cfg)
  return ref.current
}

export function useEngineVersion(engine: Engine): number {
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => engine.version,
  )
}

export interface IsleCanvasProps {
  engine: Engine
  renderObject?: (o: WorldObject) => ReactNode
  onDocChange?: (doc: Doc) => void
  onSelectionChange?: (ids: ReadonlySet<string>) => void
  autoOrigin?: boolean
  className?: string
  style?: CSSProperties
}

export function IsleCanvas({
  engine,
  renderObject,
  onDocChange,
  onSelectionChange,
  autoOrigin = true,
  className,
  style,
}: IsleCanvasProps) {
  const ref = useRef<HTMLDivElement>(null)
  useEngineVersion(engine)

  useEffect(() => {
    injectStyles()
    const el = ref.current
    if (!el) return
    const detach = attachInput(el, engine)
    const offDoc = onDocChange ? engine.onDocChange(onDocChange) : undefined
    const offSel = onSelectionChange ? engine.onSelectionChange(onSelectionChange) : undefined
    return () => {
      detach()
      offDoc?.()
      offSel?.()
    }
  }, [engine, onDocChange, onSelectionChange])

  const origin = engine.doc.origin
  useEffect(() => {
    if (!autoOrigin || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) engine.placeOrigin({ w: r.width, h: r.height })
  }, [autoOrigin, origin, engine])

  const marquee = marqueeFrame(engine)
  const page = pageFrame(engine)
  const hud = hudText(engine)
  const connectPreview = engine.connectPreview()
  const selObj =
    engine.selectedIds.size === 1
      ? engine.doc.objects.find((o) => engine.selectedIds.has(o.id))
      : undefined
  const handles = selObj ? handlePointsFor(engine, selObj) : []
  const rotHandle = selObj ? rotateHandlePoint(engine, selObj) : null
  const bendHandle = bendHandlePoint(engine)
  const vtxHandles = selObj ? vertexHandlePoints(engine, selObj) : []

  return (
    <div
      ref={ref}
      className={className ?? 'ki-canvas'}
      style={{ ...gridBackground(engine), ...style }}
    >
      {page && (
        <div
          className="ki-page"
          style={{
            transform: `translate(${page.left}px, ${page.top}px)`,
            width: page.width,
            height: page.height,
          }}
        />
      )}
      <svg className="ki-edges">
        <defs>
          {engine.doc.edges.flatMap((e) =>
            edgeMarkerDefs(engine, e).map((m) => (
              <marker
                key={m.id}
                id={m.id}
                markerUnits="userSpaceOnUse"
                orient="auto-start-reverse"
                markerWidth={m.kind === 'arrow' ? 10 : 8}
                markerHeight={8}
                refX={m.kind === 'arrow' ? 9 : 4}
                refY={4}
              >
                {m.kind === 'arrow' ? (
                  <path d="M 0 0 L 10 4 L 0 8 z" style={{ fill: m.color }} />
                ) : (
                  <circle cx={4} cy={4} r={3} style={{ fill: m.color }} />
                )}
              </marker>
            )),
          )}
        </defs>
        {engine.doc.edges.map((e) => {
          const a = edgeAttrs(engine, e)
          if (!a) return null
          const cls = engine.selectedIds.has(e.id) ? 'ki-edge ki-sel' : 'ki-edge'
          const dw = a.double ? doubleWidths(a.strokeWidth) : null
          return (
            <g key={e.id}>
              {dw && (
                <>
                  <path className={cls} d={a.d} stroke={a.stroke ?? EDGE_LINE} strokeWidth={dw.outer} strokeDasharray={a.strokeDasharray} />
                  <path className={cls} d={a.d} stroke={DOUBLE_INNER} strokeWidth={dw.inner} />
                </>
              )}
              <path
                className={cls}
                d={a.d}
                stroke={a.double ? 'none' : (a.stroke ?? EDGE_LINE)}
                strokeWidth={a.double ? undefined : (a.strokeWidth ?? 1.5)}
                strokeDasharray={a.double ? undefined : a.strokeDasharray}
                markerStart={a.markerStart}
                markerEnd={a.markerEnd}
              />
            </g>
          )
        })}
        {connectPreview && (
          <path
            className={
              engine.connect?.invalid ? 'ki-edge-preview ki-invalid' : 'ki-edge-preview'
            }
            d={routePathD(engine, connectPreview.from, connectPreview.to, 'straight')}
          />
        )}
      </svg>
      {renderOrder(engine.doc.objects).map((o) => {
        const f = objectFrame(engine, o)
        const sel = engine.selectedIds.has(o.id)
        const shape = isShapeKind(o.kind) ? shapeAttrs(engine, o) : null
        return (
          <div
            key={o.id}
            data-ki-obj={o.id}
            className={
              (isShapeKind(o.kind) ? 'ki-obj ki-shape' : 'ki-obj') +
              ` ki-kind-${o.kind}` +
              (sel ? ' ki-sel' : '') +
              (engine.dragInvalid && (sel || engine.resize?.id === o.id)
                ? ' ki-invalid'
                : '')
            }
            style={{
              transform: `translate(${f.left}px, ${f.top}px)${f.rot ? ` rotate(${f.rot}deg)` : ''}`,
              width: f.width,
              height: f.height,
              ...(isShapeKind(o.kind)
                ? {}
                : {
                    background: o.style?.fill,
                    borderColor: sel ? undefined : o.style?.stroke,
                    borderWidth: o.style?.width ?? 1,
                    borderStyle: o.style?.dash
                      ? o.style.dash[0] <= 2
                        ? 'dotted'
                        : 'dashed'
                      : undefined,
                  }),
            }}
          >
            {shape ? (
              // a 0-size <svg> disables rendering entirely — overflow:visible
              // cannot rescue it — so degenerate shapes (a line resized to
              // zero height) need a nonzero viewport for their chord to paint
              <svg
                className="ki-shape-svg"
                width={Math.max(1, f.width)}
                height={Math.max(1, f.height)}
              >
                <defs>
                  {shapeCapMarkerDefs(engine, o).map((m) => (
                    <marker
                      key={m.id}
                      id={m.id}
                      markerUnits="userSpaceOnUse"
                      orient="auto-start-reverse"
                      markerWidth={m.kind === 'arrow' ? 10 : 8}
                      markerHeight={8}
                      refX={m.kind === 'arrow' ? 9 : 4}
                      refY={4}
                    >
                      {m.kind === 'arrow' ? (
                        <path d="M 0 0 L 10 4 L 0 8 z" style={{ fill: m.color }} />
                      ) : (
                        <circle cx={4} cy={4} r={3} style={{ fill: m.color }} />
                      )}
                    </marker>
                  ))}
                </defs>
                {shape.double &&
                  (() => {
                    const w = doubleWidths(shape.strokeWidth)
                    return (
                      <>
                        <path d={shape.d} fill={shape.fill} stroke={shape.stroke} strokeWidth={w.outer} strokeDasharray={shape.strokeDasharray} />
                        <path d={shape.d} fill="none" stroke={DOUBLE_INNER} strokeWidth={w.inner} />
                      </>
                    )
                  })()}
                <path
                  d={shape.d}
                  fill={shape.double ? 'none' : shape.fill}
                  stroke={shape.double ? 'none' : shape.stroke}
                  strokeWidth={shape.double ? undefined : shape.strokeWidth}
                  strokeDasharray={shape.double ? undefined : shape.strokeDasharray}
                  markerStart={shape.markerStart}
                  markerEnd={shape.markerEnd}
                />
              </svg>
            ) : renderObject ? (
              renderObject(o)
            ) : (
              o.id
            )}
          </div>
        )
      })}
      <div className="ki-ports">
        {engine.doc.objects.flatMap((o) =>
          portPoints(engine, o).map(({ port, x, y }) => (
            <div
              key={`${o.id}:${port.id}`}
              className="ki-port"
              data-ki-obj={o.id}
              data-ki-port={port.id}
              style={{ transform: `translate(${x}px, ${y}px)` }}
            />
          )),
        )}
      </div>
      {engine.guides.map((g, i) => {
        const pos = engine.worldToScreen({ x: g.at, y: g.at })
        return (
          <div
            key={i}
            className={g.axis === 'x' ? 'ki-guide ki-guide-v' : 'ki-guide ki-guide-h'}
            style={g.axis === 'x' ? { left: pos.x } : { top: pos.y }}
          />
        )
      })}
      {handles.map((h) => (
        <div
          key={h.dir}
          className="ki-handle"
          data-ki-handle={h.dir}
          data-ki-obj={selObj?.id}
          style={{ transform: `translate(${h.x}px, ${h.y}px)`, cursor: h.cursor }}
        />
      ))}
      {rotHandle && selObj && (
        <div
          className="ki-rot"
          data-ki-rotate=""
          data-ki-obj={selObj.id}
          style={{ transform: `translate(${rotHandle.x}px, ${rotHandle.y}px)` }}
        />
      )}
      {bendHandle && (
        <div
          className="ki-bend"
          data-ki-bend=""
          data-ki-edge={bendHandle.id}
          style={{
            transform: `translate(${bendHandle.x}px, ${bendHandle.y}px)`,
            cursor: bendHandle.cursor,
          }}
        />
      )}
      <div className="ki-vtxs">
        {vtxHandles.map((v) => (
          <div
            key={v.index}
            className="ki-vtx"
            data-ki-vtx={v.index}
            data-ki-obj={selObj?.id}
            style={{ transform: `translate(${v.x}px, ${v.y}px)` }}
          />
        ))}
      </div>
      {marquee && (
        <div
          className="ki-marquee"
          style={{
            transform: `translate(${marquee.left}px, ${marquee.top}px)`,
            width: marquee.width,
            height: marquee.height,
          }}
        />
      )}
      {hud && <div className="ki-hud">{hud}</div>}
    </div>
  )
}
