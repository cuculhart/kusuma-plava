import { useEffect } from 'react'
import { formatLength } from '@kimetron/core'
import type { WorldObject } from '@kimetron/core'
import { IsleCanvas, useEngine, useEngineVersion } from '@kimetron/react'
import { canConnect, connectOrient, connectReplace, GRID_CFG, objectValue, OP_LABEL, rewirePickup, sampleDoc, WIRE_DEFAULTS } from './model'
import type { CalcData, Meta, ZoneData } from './model'
import '../../demo/src/styles.css'

const fmt = (v: number | null) =>
  v === null ? '—' : Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)

export function App() {
  const engine = useEngine({
    units: 'mm',
    origin: 'top-left',
    grid: GRID_CFG,
  })
  useEngineVersion(engine)

  useEffect(() => {
    engine.connectEdge = WIRE_DEFAULTS
    engine.canConnect = canConnect
    engine.connectReplace = (_from, to) => connectReplace(to, engine.doc.edges)
    engine.connectOrient = connectOrient
    engine.rewireEdge = (ep) => rewirePickup(ep, engine.doc.edges)
  }, [engine])

  useEffect(() => {
    const { objects, edges, page } = sampleDoc()
    engine.setDoc({ ...engine.doc, objects, edges, page })
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

  return (
    <div className="app">
      <header className="bar">
        <strong><a href="../" style={{ color: 'inherit', textDecoration: 'none' }}>Kimetron Isle</a></strong>
        <span className="sep" />
        <span className="hint">sethera-piece driver (spike)</span>
        <button onClick={() => engine.undo()} disabled={!engine.canUndo}>undo</button>
        <button onClick={() => engine.redo()} disabled={!engine.canRedo}>redo</button>
      </header>
      <IsleCanvas
        engine={engine}
        style={{ flex: 1 }}
        renderObject={(o: WorldObject) => {
          const d = o.data as (CalcData & ZoneData & Meta) | undefined
          if (o.kind === 'zone')
            return (
              <div className="obj-label">
                <b>{d?.label ?? 'Σ'}</b>
                <span>{fmt(objectValue(o.id, doc.objects, doc.edges))}</span>
              </div>
            )
          if (o.kind === 'calc')
            return (
              <div className="obj-label">
                <b>{d?.op ? OP_LABEL[d.op] : '?'}</b>
                <span>{fmt(objectValue(o.id, doc.objects, doc.edges))}</span>
              </div>
            )
          const p = o.data as { label?: string; value?: number | null } & Meta | undefined
          return (
            <div className="obj-label">
              <b>{p?.label ?? o.id}</b>
              {p?.value !== null && p?.value !== undefined && <span>{fmt(p.value)}</span>}
              {o.locked && <span>🔒</span>}
              {o.group && <span className="hint">{o.group}</span>}
            </div>
          )
        }}
      />
      <footer className="bar">
        <span>scale {engine.scaleText()}</span>
        <span>
          cursor ({formatLength(engine.cursorWorld.x, u)},{' '}
          {formatLength(engine.cursorWorld.y, u)})
        </span>
        <span>selected {engine.selectedIds.size}</span>
        <span>objects {doc.objects.length}</span>
        <span>wires {doc.edges.length}</span>
        <span className="sep" />
        <span className="hint">wire: out-port ⇄ calc a/b, either drag direction (occupied input = replace) / drag an occupied input or a wire's end to rewire, drop on empty to detach / Σ aggregates contained pieces / lock & group & page & double-line are engine features</span>
      </footer>
    </div>
  )
}
