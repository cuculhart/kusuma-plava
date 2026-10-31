import { useCallback, useEffect, useState } from 'react'
import { formatLength } from '@kimetron/core'
import type { EdgeMarker, EdgeRoute, WorldObject } from '@kimetron/core'
import { IsleCanvas, useEngine, useEngineVersion } from '@kimetron/react'
import { layoutTasks, SAMPLE_TASKS } from './model'
import type { Orientation, TaskData } from './model'
import '../../demo/src/styles.css'

export function App() {
  const engine = useEngine({
    units: 'mm',
    origin: 'top-left',
    grid: { size: 5, snap: true },
  })
  useEngineVersion(engine)
  const [orientation, setOrientation] = useState<Orientation>('h')

  useEffect(() => {
    // hand-drawn links become dependency edges; a second edge between the
    // same task pair is meaningless, so the policy hook rejects it
    engine.connectEdge = {
      route: 'bezier',
      style: { color: '#b45309', width: 1.8 },
      markerEnd: 'arrow',
    }
    engine.canConnect = (from, to) =>
      !engine.doc.edges.some((e) => e.from.obj === from.obj && e.to.obj === to.obj)
    // sibling hier edges share one visual trunk — bend them together
    engine.bendGroup = (edge, doc) =>
      doc.edges
        .filter(
          (s) =>
            s.id !== edge.id &&
            (s.route === 'orthogonal' || s.route === 'smoothstep') &&
            s.from.obj === edge.from.obj &&
            s.from.port === edge.from.port,
        )
        .map((s) => s.id)
  }, [engine])

  const relayout = useCallback(() => {
    const { objects, edges } = layoutTasks(SAMPLE_TASKS, orientation)
    const live = new Map(engine.doc.objects.map((o) => [o.id, o]))
    engine.setDoc({
      ...engine.doc,
      // keep objects the user added; re-derive positions for task nodes
      objects: engine.doc.objects
        .map((o) => {
          const fresh = objects.find((f) => f.id === o.id)
          return fresh ? { ...o, x: fresh.x, y: fresh.y } : o
        })
        .concat(objects.filter((f) => !live.has(f.id))),
      edges,
    })
  }, [engine, orientation])

  useEffect(() => relayout(), [relayout])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (e.key === 'Delete' || e.key === 'Backspace') engine.removeSelected()
      else if (mod && e.key.toLowerCase() === 'z' && e.shiftKey) { e.preventDefault(); engine.redo() }
      else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); engine.undo() }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); engine.redo() }
      else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); engine.duplicateSelected() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine])

  const { doc } = engine
  const u = doc.units
  const selEdge =
    engine.selectedIds.size === 1
      ? doc.edges.find((e) => engine.selectedIds.has(e.id))
      : undefined
  const ROUTES: EdgeRoute[] = ['straight', 'orthogonal', 'smoothstep', 'bezier']
  const MARKERS: (EdgeMarker | '')[] = ['', 'arrow', 'dot']

  return (
    <div className="app">
      <header className="bar">
        <strong><a href="../" style={{ color: 'inherit', textDecoration: 'none' }}>Kimetron Isle</a></strong>
        <span className="sep" />
        <span className="hint">plesfeda-style driver (spike)</span>
        <button onClick={() => setOrientation((o) => (o === 'h' ? 'v' : 'h'))}>
          {orientation === 'h' ? 'horizontal' : 'vertical'}
        </button>
        <button onClick={relayout}>relayout</button>
        <button onClick={() => engine.undo()} disabled={!engine.canUndo}>undo</button>
        <button onClick={() => engine.redo()} disabled={!engine.canRedo}>redo</button>
        {selEdge && (
          <>
            <span className="sep" />
            <label>
              route
              <select
                value={selEdge.route ?? 'straight'}
                onChange={(e) => engine.updateEdge(selEdge.id, { route: e.target.value as EdgeRoute })}
              >
                {ROUTES.map((v) => <option key={v}>{v}</option>)}
              </select>
            </label>
            <label>
              color
              <input
                type="color"
                value={selEdge.style?.color ?? '#a39e93'}
                onChange={(e) =>
                  engine.updateEdge(selEdge.id, { style: { ...selEdge.style, color: e.target.value } })
                }
              />
            </label>
            <label>
              width
              <select
                value={String(selEdge.style?.width ?? 1.5)}
                onChange={(e) =>
                  engine.updateEdge(selEdge.id, {
                    style: { ...selEdge.style, width: Number(e.target.value) },
                  })
                }
              >
                {[1, 1.5, 1.8, 2.5, 3, 4].map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={!!selEdge.style?.dash}
                onChange={(e) =>
                  engine.updateEdge(selEdge.id, {
                    style: { ...selEdge.style, dash: e.target.checked ? [4, 4] : undefined },
                  })
                }
              />
              dash
            </label>
            <label>
              start
              <select
                value={selEdge.markerStart ?? ''}
                onChange={(e) =>
                  engine.updateEdge(selEdge.id, {
                    markerStart: (e.target.value || undefined) as EdgeMarker | undefined,
                  })
                }
              >
                {MARKERS.map((v) => <option key={v} value={v}>{v || 'none'}</option>)}
              </select>
            </label>
            <label>
              end
              <select
                value={selEdge.markerEnd ?? ''}
                onChange={(e) =>
                  engine.updateEdge(selEdge.id, {
                    markerEnd: (e.target.value || undefined) as EdgeMarker | undefined,
                  })
                }
              >
                {MARKERS.map((v) => <option key={v} value={v}>{v || 'none'}</option>)}
              </select>
            </label>
          </>
        )}
      </header>
      <IsleCanvas
        engine={engine}
        style={{ flex: 1 }}
        renderObject={(o: WorldObject) => {
          const d = o.data as TaskData | undefined
          return (
            <div className="obj-label">
              <b>{d ? `${d.wbs} ${d.name}` : o.id}</b>
              {d && <span>{d.effort}d</span>}
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
        <span>tasks {doc.objects.length}</span>
        <span>edges {doc.edges.length}</span>
        <span className="sep" />
        <span className="hint">WBS & layout derived / hier edges follow depth axis / dep edges pick facing sides / drag snaps to grid / grab a trunk line (or the ▢ on a selected edge) to slide the bend — siblings follow</span>
      </footer>
    </div>
  )
}
