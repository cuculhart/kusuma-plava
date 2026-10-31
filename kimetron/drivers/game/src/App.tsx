import { useEffect, useMemo, useRef, useState } from 'react'
import type { Pt, WorldObject } from '@kimetron/core'
import { formatLength, unitToPx } from '@kimetron/core'
import { useEngine, useEngineVersion, IsleCanvas } from '@kimetron/react'
import '../../demo/src/styles.css'
import {
  GRID_CFG,
  UNIT_IDS,
  UNIT_RANGE,
  adjacent,
  canOverlap,
  sampleObjects,
  stepUnits,
} from './model'
import type { UnitData, WanderState } from './model'

export function App() {
  const engine = useEngine({ units: 'mm', origin: 'top-left', grid: GRID_CFG })
  useEngineVersion(engine)
  const [paused, setPaused] = useState(false)
  const wps = useRef<Record<string, WanderState>>({})

  useEffect(() => {
    engine.collisionMode = 'reject'
    engine.canOverlap = canOverlap
  }, [engine])

  useEffect(() => {
    engine.setDoc({ ...engine.doc, objects: sampleObjects() })
    engine.viewport = { x: 40, y: 40, zoom: 1 / 20 }
    engine.panBy(0, 0)
  }, [engine])

  // wander loop — programmatic motion through tryMove honors the
  // collision policy (walls block, the gate doesn't, units can't stack)
  useEffect(() => {
    if (paused) return
    const t = setInterval(() => stepUnits(engine, wps.current), 80)
    return () => clearInterval(t)
  }, [engine, paused])

  const objects = engine.doc.objects
  const unitA = objects.find((o) => o.id === 'uA')
  const unitB = objects.find((o) => o.id === 'uB')
  const near = useMemo(
    () =>
      UNIT_IDS.flatMap((id) => {
        const u = objects.find((o) => o.id === id)
        return u ? adjacent(engine, u).map((t) => [u, t] as const) : []
      }).filter(([a, b]) => a.id < b.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [objects],
  )

  const toScreen = (o: WorldObject): Pt =>
    engine.worldToScreen({ x: o.x + o.w / 2, y: o.y + o.h / 2 })

  const rangeRing = (o: WorldObject, key: string) => {
    const c = toScreen(o)
    const r = (o.w / 2 + UNIT_RANGE) * unitToPx(engine.doc.units) * engine.viewport.zoom
    return (
      <circle
        key={key}
        cx={c.x}
        cy={c.y}
        r={r}
        fill="none"
        stroke={(o.data as UnitData).color}
        strokeOpacity={0.35}
        strokeDasharray="6 5"
      />
    )
  }

  return (
    <div className="app">
      <header className="bar">
        <a href="../">← Kimetron Isle</a>
        <b>game driver (spike)</b>
        <button onClick={() => setPaused((p) => !p)}>
          {paused ? '再開 ▶' : '一時停止 ⏸'}
        </button>
        <span className="hint">
          units wander via <code>tryMove</code> — walls &amp; rocks block,
          only the gate opens; adjacency triggers effects
        </span>
      </header>
      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
        <IsleCanvas
          engine={engine}
          autoOrigin={false}
          style={{ flex: 1 }}
          renderObject={(o: WorldObject) => renderObject(o)}
        />
        <svg
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
          }}
        >
          {UNIT_IDS.map((id) => {
            const u = objects.find((o) => o.id === id)
            return u ? rangeRing(u, id) : null
          })}
          {near.map(([a, b]) => {
            const pa = toScreen(a)
            const pb = toScreen(b)
            return (
              <g key={`${a.id}-${b.id}`}>
                <line
                  x1={pa.x}
                  y1={pa.y}
                  x2={pb.x}
                  y2={pb.y}
                  stroke="#e0486f"
                  strokeWidth={2}
                  strokeDasharray="8 6"
                />
                <text
                  x={(pa.x + pb.x) / 2}
                  y={(pa.y + pb.y) / 2 - 8}
                  textAnchor="middle"
                  fontSize={12}
                  fill="#e0486f"
                  fontWeight={600}
                >
                  会話・攻撃可能
                </text>
              </g>
            )
          })}
          {UNIT_IDS.map((id) => {
            const wp = wps.current[id]?.wp
            if (!wp) return null
            const s = engine.worldToScreen(wp)
            return (
              <circle
                key={`wp-${id}`}
                cx={s.x}
                cy={s.y}
                r={4}
                fill="none"
                stroke={(objects.find((o) => o.id === id)?.data as UnitData)?.color}
                strokeWidth={1.5}
              />
            )
          })}
        </svg>
      </div>
      <footer className="bar bar-foot">
        <span>scale {engine.scaleText()}</span>
        <span>
          cursor ({formatLength(engine.cursorWorld.x, 'mm')},{' '}
          {formatLength(engine.cursorWorld.y, 'mm')})
        </span>
        <span className="hint">
          solid walls/gate + locked polygon rocks + pattern pond — drag a
          unit, it still can't cross walls or stack on the other
        </span>
      </footer>
    </div>
  )
}

function renderObject(o: WorldObject) {
  if (o.kind === 'unit') {
    const d = o.data as UnitData
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            borderRadius: '50%',
            background: d.color,
            boxShadow: '0 2px 6px rgba(0,0,0,.3)',
            display: 'grid',
            placeItems: 'center',
            color: '#fff',
            fontWeight: 700,
            fontSize: 14,
          }}
        >
          {d.name}
        </div>
      </div>
    )
  }
  if (o.kind === 'pond') {
    return (
      <svg width="100%" height="100%">
        <defs>
          <pattern
            id="pond-waves"
            width="18"
            height="12"
            patternUnits="userSpaceOnUse"
          >
            <rect width="18" height="12" fill="#bfe3f0" />
            <path
              d="M0 6 Q 4.5 2 9 6 T 18 6"
              fill="none"
              stroke="#7fc4de"
              strokeWidth="1.5"
            />
          </pattern>
        </defs>
        <rect
          width="100%"
          height="100%"
          rx={6}
          fill="url(#pond-waves)"
          stroke="#6cb5d4"
        />
      </svg>
    )
  }
  if (o.kind === 'door') {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'grid',
          placeItems: 'center',
          fontSize: 11,
          color: '#4c5f3a',
          fontWeight: 600,
          letterSpacing: 2,
        }}
      >
        出入口
      </div>
    )
  }
}
