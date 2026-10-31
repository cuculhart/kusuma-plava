import { useEffect, useRef } from 'react'
import { deserializeDoc, formatLength, serializeDoc } from '@kimetron/core'
import type { EdgeRoute, Origin, Port, Unit } from '@kimetron/core'
import { IsleCanvas, useEngine, useEngineVersion } from '@kimetron/react'
import './styles.css'

const UNITS: Unit[] = ['mm', 'cm', 'm', 'inch', 'px']
const ORIGINS: Origin[] = ['bottom-left', 'top-left']
const ROUTES: EdgeRoute[] = ['straight', 'orthogonal', 'smoothstep', 'bezier']

/** 4 ports at the edge midpoints (normalized fractions). */
const ports4 = (): Port[] => [
  { id: 'l', fx: 0, fy: 0.5 },
  { id: 't', fx: 0.5, fy: 1 },
  { id: 'r', fx: 1, fy: 0.5 },
  { id: 'b', fx: 0.5, fy: 0 },
]

function nextId(objects: { id: string }[]): string {
  let max = 0
  for (const o of objects) {
    const m = /^r(\d+)$/.exec(o.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `r${max + 1}`
}

export function App() {
  const engine = useEngine({
    units: 'mm',
    origin: 'bottom-left',
    grid: { size: 10, snap: true },
  })
  useEngineVersion(engine)
  const fileRef = useRef<HTMLInputElement>(null)

  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current) return
    seeded.current = true
    engine.connectEdge = { markerEnd: 'arrow' }
    engine.addObject({ id: 'a', kind: 'rect', x: 10, y: 10, w: 80, h: 40, ports: ports4() })
    engine.addObject({ id: 'b', kind: 'rect', x: 110, y: 60, w: 50, h: 30, ports: ports4() })
    engine.addObject({ id: 'c', kind: 'rect', x: 40, y: 110, w: 60, h: 50, ports: ports4() })
  }, [engine])

  const { doc, viewport } = engine
  const u = doc.units

  const addRect = () => {
    const s = doc.grid.size
    engine.addObject({
      id: nextId(doc.objects),
      kind: 'rect',
      x: (1 + Math.floor(Math.random() * 15)) * s,
      y: (1 + Math.floor(Math.random() * 10)) * s,
      w: s * 4,
      h: s * 3,
      ports: ports4(),
    })
  }

  const save = () => {
    const blob = new Blob([serializeDoc(engine.doc)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'kimetron-doc.json'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const load = (file: File) => {
    file.text().then((t) => engine.setDoc(deserializeDoc(t)))
  }

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

  return (
    <div className="app">
      <header className="bar">
        <strong>Kimetron Isle</strong>
        <label>
          units
          <select value={doc.units} onChange={(e) => engine.setUnits(e.target.value as Unit)}>
            {UNITS.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          origin
          <select value={doc.origin} onChange={(e) => engine.setOrigin(e.target.value as Origin)}>
            {ORIGINS.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          grid
          <input
            type="number"
            min={1}
            step={1}
            value={doc.grid.size}
            onChange={(e) => engine.setGrid({ size: Number(e.target.value) || 1 })}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={doc.grid.snap}
            onChange={(e) => engine.setGrid({ snap: e.target.checked })}
          />
          snap
        </label>
        <label>
          route
          <select
            value={engine.connectRoute}
            onChange={(e) => (engine.connectRoute = e.target.value as EdgeRoute)}
          >
            {ROUTES.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <span className="sep" />
        <button onClick={addRect}>+ rect</button>
        <button onClick={() => engine.duplicateSelected()} disabled={engine.selectedIds.size === 0}>
          duplicate
        </button>
        <button onClick={() => engine.reorderSelected('front')} disabled={engine.selectedIds.size === 0}>
          front
        </button>
        <button onClick={() => engine.reorderSelected('back')} disabled={engine.selectedIds.size === 0}>
          back
        </button>
        <button onClick={() => engine.removeSelected()} disabled={engine.selectedIds.size === 0}>
          delete
        </button>
        <span className="sep" />
        <button onClick={() => engine.undo()} disabled={!engine.canUndo}>
          undo
        </button>
        <button onClick={() => engine.redo()} disabled={!engine.canRedo}>
          redo
        </button>
        <span className="sep" />
        <button onClick={save}>save JSON</button>
        <button onClick={() => fileRef.current?.click()}>load JSON</button>
        <input
          ref={fileRef}
          type="file"
          accept=".json"
          hidden
          onChange={(e) => e.target.files?.[0] && load(e.target.files[0])}
        />
      </header>
      <IsleCanvas
        engine={engine}
        style={{ flex: 1 }}
        renderObject={(o) => (
          <div className="obj-label">
            <b>{o.id}</b>
            <span>
              {formatLength(o.w, u)} × {formatLength(o.h, u)}
            </span>
            <span>
              ({formatLength(o.x, u)}, {formatLength(o.y, u)})
            </span>
          </div>
        )}
      />
      <footer className="bar">
        <span>scale {engine.scaleText()}</span>
        <span>zoom {(viewport.zoom * 100).toFixed(0)}%</span>
        <span>
          cursor ({formatLength(engine.cursorWorld.x, u)},{' '}
          {formatLength(engine.cursorWorld.y, u)})
        </span>
        <span>selected {engine.selectedIds.size}</span>
        <span>edges {doc.edges.length}</span>
        <span className="sep" />
        <span className="hint">drag: move / handle: resize / port-drag: connect / empty-drag: marquee / ctrl+z: undo / ctrl+d: duplicate / mid-drag: pan / wheel: zoom / trackpad: pan·pinch</span>
      </footer>
    </div>
  )
}
