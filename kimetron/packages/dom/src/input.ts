import type { Engine, Pt } from '@kimetron/core'
import { screenDirToWorld } from './style'

export function attachInput(el: HTMLElement, engine: Engine): () => void {
  const toLocal = (e: { clientX: number; clientY: number }): Pt => {
    const r = el.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  // pointer capture は最初の pointermove まで遅延させる。
  // pointerdown で即キャプチャすると pointerup がキャプチャ要素に
  // 再ターゲットされ、preventDefault も click を抑止するため、
  // オブジェクト内の click/dblclick（ツールボタン・inline 編集）が
  // 一切発火しなくなる。ハンドル/ポート等のジェスチャ起点は即時。
  let wantCapture = false

  const down = (e: PointerEvent) => {
    const handle = (e.target as HTMLElement).closest?.(
      '[data-ki-handle]',
    ) as HTMLElement | null
    const rot = (e.target as HTMLElement).closest?.(
      '[data-ki-rotate]',
    ) as HTMLElement | null
    const bend = (e.target as HTMLElement).closest?.(
      '[data-ki-bend]',
    ) as HTMLElement | null
    const port = (e.target as HTMLElement).closest?.(
      '[data-ki-port]',
    ) as HTMLElement | null
    const vtx = (e.target as HTMLElement).closest?.(
      '[data-ki-vtx]',
    ) as HTMLElement | null
    if (rot?.dataset.kiObj) {
      engine.startRotate(toLocal(e), rot.dataset.kiObj)
    } else if (vtx?.dataset.kiObj) {
      // vertex handles also answer dblclick (delete) — defer capture
      // like the generic path so click/dblclick reach the handle
      engine.startVertexMove(
        toLocal(e),
        vtx.dataset.kiObj,
        Number(vtx.dataset.kiVtx),
      )
      wantCapture = true
      return
    } else if (bend?.dataset.kiEdge) {
      engine.startBend(toLocal(e), bend.dataset.kiEdge)
    } else if (handle?.dataset.kiObj) {
      engine.startResize(
        toLocal(e),
        handle.dataset.kiObj,
        screenDirToWorld(handle.dataset.kiHandle ?? '', engine.doc.origin),
      )
    } else if (port?.dataset.kiObj) {
      engine.startConnect(toLocal(e), port.dataset.kiObj, port.dataset.kiPort)
    } else {
      // `.nodrag` content / form elements inside a custom-rendered object:
      // select the owning object, but run no gesture and leave native
      // focus / text-selection / click behavior intact.
      const t = e.target as HTMLElement
      const nodrag = !!t.closest?.(
        '.nodrag, input, textarea, select, [contenteditable="true"]',
      )
      if (nodrag) {
        const objEl = t.closest('[data-ki-obj]') as HTMLElement | null
        const id = objEl?.dataset.kiObj
        if (id) {
          if (e.shiftKey) {
            const s = new Set(engine.selectedIds)
            if (s.has(id)) s.delete(id)
            else s.add(id)
            engine.setSelection(s)
          } else if (!engine.selectedIds.has(id)) {
            engine.setSelection([id])
          }
        }
        return
      }
      engine.pointerDown(toLocal(e), {
        button: e.button,
        additive: e.shiftKey,
        detached: e.altKey,
      })
      wantCapture = true
      return
    }
    el.setPointerCapture(e.pointerId)
    e.preventDefault()
  }
  const move = (e: PointerEvent) => {
    if (wantCapture) {
      wantCapture = false
      if (e.buttons !== 0 && !el.hasPointerCapture(e.pointerId))
        el.setPointerCapture(e.pointerId)
    }
    engine.pointerMove(toLocal(e), { angleSnap: e.shiftKey })
  }
  const up = (e: PointerEvent) => {
    wantCapture = false
    engine.pointerUp()
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
  }
  const wheel = (e: WheelEvent) => {
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) {
      // trackpad pinch (or Ctrl+wheel): zoom
      engine.wheel(toLocal(e), e.deltaY)
    } else if (e.deltaX !== 0 || e.shiftKey) {
      // trackpad two-finger scroll or Shift+wheel: pan
      const dx = e.deltaX + (e.shiftKey ? e.deltaY : 0)
      const dy = e.shiftKey ? 0 : e.deltaY
      engine.panBy(dx, dy)
    } else {
      engine.wheel(toLocal(e), e.deltaY)
    }
  }

  const dbl = (e: MouseEvent) => {
    const vtx = (e.target as HTMLElement).closest?.(
      '[data-ki-vtx]',
    ) as HTMLElement | null
    if (vtx?.dataset.kiObj) {
      // vertex dblclick = delete the anchor
      engine.deleteShapeVertex(vtx.dataset.kiObj, Number(vtx.dataset.kiVtx))
      e.preventDefault()
      e.stopPropagation()
      return
    }
    // segment dblclick = insert a vertex on the selected curve/polygon
    if (engine.insertShapeVertex(toLocal(e))) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  el.addEventListener('pointerdown', down)
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
  el.addEventListener('dblclick', dbl)
  el.addEventListener('wheel', wheel, { passive: false })

  return () => {
    el.removeEventListener('pointerdown', down)
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
    el.removeEventListener('dblclick', dbl)
    el.removeEventListener('wheel', wheel)
  }
}
