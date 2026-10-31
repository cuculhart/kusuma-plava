import { useEffect } from 'react'
import { formatLength } from '@kimetron/core'
import type { WorldObject } from '@kimetron/core'
import { objectFrame, rulerTicks } from '@kimetron/dom'
import { IsleCanvas, useEngine, useEngineVersion } from '@kimetron/react'
import { areas, canOverlap, FURNITURE, GRID_CFG, sampleDoc, spawn, spawnDim, spawnWall } from './model'
import type { DimData, ItemData } from './model'
import '../../demo/src/styles.css'

const DIM_LINE = '#4a5568'

/** Wall core line (壁芯) — a dash-dot line along the wall's long axis. */
function WallCore({ f }: { f: { width: number; height: number } }) {
  const horiz = f.width >= f.height
  return (
    <svg width={f.width} height={f.height} style={{ display: 'block' }}>
      <line
        x1={horiz ? 0 : f.width / 2}
        y1={horiz ? f.height / 2 : 0}
        x2={horiz ? f.width : f.width / 2}
        y2={horiz ? f.height / 2 : f.height}
        stroke="#e8b86d"
        strokeWidth={1.2}
        strokeDasharray="10 4 2 4"
      />
    </svg>
  )
}

/** Dimension object: extension lines + double-arrow dimension line + value text. */
function DimView({ engine, o }: { engine: Parameters<typeof objectFrame>[0]; o: WorldObject }) {
  const f = objectFrame(engine, o)
  const horiz = (o.data as DimData | undefined)?.axis !== 'y'
  const span = horiz ? o.w : o.h
  const text = formatLength(span, engine.doc.units)
  const A = 6 // arrowhead size px
  if (horiz) {
    const cy = f.height * 0.62
    return (
      <svg width={f.width} height={f.height} style={{ display: 'block', overflow: 'visible' }}>
        <line x1={0.75} y1={0} x2={0.75} y2={f.height} stroke={DIM_LINE} strokeWidth={0.8} />
        <line x1={f.width - 0.75} y1={0} x2={f.width - 0.75} y2={f.height} stroke={DIM_LINE} strokeWidth={0.8} />
        <line x1={0} y1={cy} x2={f.width} y2={cy} stroke={DIM_LINE} strokeWidth={1} />
        <path d={`M 0 ${cy} l ${A} -3 M 0 ${cy} l ${A} 3 M ${f.width} ${cy} l -${A} -3 M ${f.width} ${cy} l -${A} 3`} stroke={DIM_LINE} strokeWidth={1.2} fill="none" />
        <text
          x={f.width / 2} y={cy - 6} textAnchor="middle" fontSize={11} fill={DIM_LINE}
          style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: 3 }}
        >
          {text}
        </text>
      </svg>
    )
  }
  const cx = f.width * 0.38
  return (
    <svg width={f.width} height={f.height} style={{ display: 'block', overflow: 'visible' }}>
      <line x1={0} y1={0.75} x2={f.width} y2={0.75} stroke={DIM_LINE} strokeWidth={0.8} />
      <line x1={0} y1={f.height - 0.75} x2={f.width} y2={f.height - 0.75} stroke={DIM_LINE} strokeWidth={0.8} />
      <line x1={cx} y1={0} x2={cx} y2={f.height} stroke={DIM_LINE} strokeWidth={1} />
      <path d={`M ${cx} 0 l -3 ${A} M ${cx} 0 l 3 ${A} M ${cx} ${f.height} l -3 -${A} M ${cx} ${f.height} l 3 -${A}`} stroke={DIM_LINE} strokeWidth={1.2} fill="none" />
      <text
        x={cx + 8} y={f.height / 2} textAnchor="middle" fontSize={11} fill={DIM_LINE}
        transform={`rotate(-90 ${cx + 8} ${f.height / 2})`}
        style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: 3 }}
      >
        {text}
      </text>
    </svg>
  )
}

/** Compass symbol — rendered in the object's local box, which the
    canvas rotates for us when `o.rot` is set. */
function CompassView({ f }: { f: { width: number; height: number } }) {
  const cx = f.width / 2
  const cy = f.height / 2
  const r = Math.min(f.width, f.height) * 0.42
  return (
    <svg width={f.width} height={f.height} style={{ display: 'block', overflow: 'visible' }}>
      <circle cx={cx} cy={cy} r={r} fill="#fff" stroke={DIM_LINE} strokeWidth={1} />
      <path
        d={`M ${cx} ${cy - r * 0.78} L ${cx + r * 0.22} ${cy + r * 0.3} L ${cx} ${cy + r * 0.12} L ${cx - r * 0.22} ${cy + r * 0.3} Z`}
        fill={DIM_LINE}
      />
      <text x={cx} y={cy - r * 0.9} textAnchor="middle" fontSize={12} fontWeight={700} fill={DIM_LINE}>N</text>
    </svg>
  )
}

export function App() {
  const engine = useEngine({
    units: 'mm',
    origin: 'top-left',
    grid: GRID_CFG,
  })
  useEngineVersion(engine)

  useEffect(() => {
    engine.collisionMode = 'reject'
    engine.canOverlap = canOverlap
  }, [engine])

  useEffect(() => {
    const { objects } = sampleDoc()
    engine.setDoc({ ...engine.doc, objects })
    // start at 1:20 — the site fills a comfortable viewport
    engine.viewport = { x: 60, y: 60, zoom: 1 / 20 }
    engine.panBy(0, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (e.key === 'Delete' || e.key === 'Backspace') engine.removeSelected()
      else if (mod && e.key.toLowerCase() === 'z' && e.shiftKey) { e.preventDefault(); engine.redo() }
      else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); engine.undo() }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); engine.redo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine])

  const { doc } = engine
  const u = doc.units

  const add = (kind: string) => {
    const o = spawn(kind)
    engine.addObject(o)
    engine.setSelection([o.id])
  }
  const addDim = (axis: 'x' | 'y') => {
    const d = spawnDim(axis, engine.selectionBounds())
    engine.addObject(d)
    engine.setSelection([d.id])
  }

  // architectural areas derived from the wall layout (mm² → m²)
  const a = areas(doc.objects)
  const m2 = (mm2: number) => `${(mm2 / 1e6).toFixed(2)} m²`

  const xTicks = rulerTicks(engine, 'x', 3000)
  const yTicks = rulerTicks(engine, 'y', 2000)

  return (
    <div className="app">
      <header className="bar">
        <strong><a href="../" style={{ color: 'inherit', textDecoration: 'none' }}>Kimetron Isle</a></strong>
        <span className="sep" />
        <span className="hint">floor-plan driver (spike)</span>
        {Object.keys(FURNITURE).map((k) => (
          <button key={k} onClick={() => add(k)}>+{FURNITURE[k].label}</button>
        ))}
        <button onClick={() => { const w = spawnWall(); engine.addObject(w); engine.setSelection([w.id]) }}>+斜め壁</button>
        <span className="sep" />
        <button onClick={() => addDim('x')}>+H寸法</button>
        <button onClick={() => addDim('y')}>+V寸法</button>
        <span className="sep" />
        <button onClick={() => engine.undo()} disabled={!engine.canUndo}>undo</button>
        <button onClick={() => engine.redo()} disabled={!engine.canRedo}>redo</button>
      </header>
      <div className="plan-wrap">
        <IsleCanvas
          engine={engine}
          autoOrigin={false}
          style={{ flex: 1 }}
          renderObject={(o: WorldObject) => {
            if (o.kind === 'site') return null
            if (o.kind === 'wall') return <WallCore f={objectFrame(engine, o)} />
            if (o.kind === 'compass') return <CompassView f={objectFrame(engine, o)} />
            if (o.kind === 'dim') return <DimView engine={engine} o={o} />
            const d = o.data as ItemData | undefined
            return (
              <div className="obj-label">
                {d?.label && <b>{d.label}</b>}
                <span>
                  {formatLength(o.w, u)} × {formatLength(o.h, u)}
                </span>
              </div>
            )
          }}
        />
        <div className="ki-ruler ki-ruler-x">
          {xTicks.map((t) => (
            <div
              key={t.px}
              className={t.major ? 'tick major' : 'tick'}
              style={{ left: t.px }}
            />
          ))}
          {xTicks.filter((t) => t.label).map((t) => (
            <div key={`l${t.px}`} className="tick-label" style={{ left: t.px }}>{t.label}</div>
          ))}
        </div>
        <div className="ki-ruler ki-ruler-y">
          {yTicks.map((t) => (
            <div
              key={t.px}
              className={t.major ? 'tick major' : 'tick'}
              style={{ top: t.px }}
            />
          ))}
          {yTicks.filter((t) => t.label).map((t) => (
            <div key={`l${t.px}`} className="tick-label" style={{ top: t.px }}>{t.label}</div>
          ))}
        </div>
        <div className="ki-ruler-corner" />
      </div>
      <footer className="bar">
        <span>scale {engine.scaleText()}</span>
        <span>
          cursor ({formatLength(engine.cursorWorld.x, u)},{' '}
          {formatLength(engine.cursorWorld.y, u)})
        </span>
        <span>
          敷地 {m2(a.site)} ・ 建築 {m2(a.building)} ・ 床(壁芯) {m2(a.core)} ・
          床(内法) {m2(a.inner)} ・ 壁 {m2(a.wallGross - a.openings)}（開口 -{m2(a.openings)}）
        </span>
        <span className="sep" />
        <span className="hint">
          solids abut but never overlap / doors sit on walls / dims snap to wall cores / ◎ rotates (Shift = 15°)
        </span>
      </footer>
    </div>
  )
}
