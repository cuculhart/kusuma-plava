import type { Edge, Port, WorldObject } from '@kimetron/core'

/** plesfeda-like WBS task: tree structure + derived numbering + deps. */
export interface Task {
  id: string
  parent: string | null
  name: string
  effort: number
  deps?: string[]
  /** On the critical path — dep edges between two critical tasks are critical. */
  critical?: boolean
}

export interface TaskData {
  wbs: string
  name: string
  effort: number
}

export type Orientation = 'h' | 'v'

const NODE_W = 70
const NODE_H = 15
const MARGIN = 10
// slot steps along the sibling axis; even multiples of 5mm so that
// half-slot parent centers still land on the grid
const ALONG_STEP_H = NODE_H + 15 // = 30
const ALONG_STEP_V = NODE_W + 10 // = 80
const ACROSS_GAP = 15 // between depth levels
const TREE_GAP_SLOTS = 1 // extra slots between root trees

/** Port ids per side, in world-space fractions (origin: top-left → fy 0 = top). */
// plesfeda's edge semantics: quiet gray tree links, brown bezier deps
// with arrows, orange-bold when on the critical path.
const EDGE_TREE = '#a39e93'
const EDGE_DEP = '#b45309'
const EDGE_CRITICAL = '#d97706'

const PORTS: Port[] = [
  { id: 'l', fx: 0, fy: 0.5 },
  { id: 'r', fx: 1, fy: 0.5 },
  { id: 't', fx: 0.5, fy: 0 },
  { id: 'b', fx: 0.5, fy: 1 },
]

type Side = 'l' | 'r' | 't' | 'b'
const OPPOSITE: Record<Side, Side> = { l: 'r', r: 'l', t: 'b', b: 't' }

/** Pick the side of `from` that faces `to`, by dominant axis. */
function facingSide(from: WorldObject, to: WorldObject): Side {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2)
  const dy = to.y + to.h / 2 - (from.y + from.h / 2)
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'r' : 'l') : dy >= 0 ? 'b' : 't'
}

/**
 * Derive canvas objects/edges from the task tree.
 * Layout is a pure function of the tree — positions are NOT stored
 * (same principle as plesfeda's derived layout). All metrics are
 * multiples of the 5mm grid so laid-out nodes stay grid-aligned.
 */
export function layoutTasks(
  tasks: Task[],
  orientation: Orientation = 'h',
): { objects: WorldObject[]; edges: Edge[] } {
  const children = (id: string) => tasks.filter((t) => t.parent === id)
  const taskById = new Map(tasks.map((t) => [t.id, t]))
  const objects: WorldObject[] = []
  const byId = new Map<string, WorldObject>()
  const alongStep = orientation === 'h' ? ALONG_STEP_H : ALONG_STEP_V
  const acrossStep = orientation === 'h' ? NODE_W + ACROSS_GAP : NODE_H + ACROSS_GAP
  const centers = new Map<string, number>()
  let slot = 0

  // tidy tree: leaves take consecutive slots, a parent is centered
  // between its outermost children — that is what reads as a bracket
  const place = (t: Task, wbs: string, depth: number) => {
    const kids = children(t.id)
    kids.forEach((k, i) => place(k, `${wbs}.${i + 1}`, depth + 1))
    const center =
      kids.length === 0
        ? slot++
        : (centers.get(kids[0].id)! + centers.get(kids[kids.length - 1].id)!) / 2
    centers.set(t.id, center)
    const along = MARGIN + center * alongStep
    const across = MARGIN + depth * acrossStep
    const o: WorldObject = {
      id: t.id,
      kind: 'task',
      x: orientation === 'h' ? across : along,
      y: orientation === 'h' ? along : across,
      w: NODE_W,
      h: NODE_H,
      ports: PORTS.map((p) => ({ ...p })),
      ...(t.critical ? { style: { stroke: EDGE_CRITICAL } } : {}),
      data: { wbs, name: t.name, effort: t.effort } satisfies TaskData,
    }
    objects.push(o)
    byId.set(t.id, o)
  }

  tasks
    .filter((t) => t.parent === null)
    .forEach((t, i) => {
      if (i > 0) slot += TREE_GAP_SLOTS
      place(t, `${i + 1}`, 0)
    })

  const edges: Edge[] = []
  // hierarchy: parent → child across the depth axis, quiet smoothstep links
  const out: Side = orientation === 'h' ? 'r' : 'b'
  for (const t of tasks) {
    if (!t.parent || !byId.has(t.parent)) continue
    edges.push({
      id: `hier-${t.parent}-${t.id}`,
      from: { obj: t.parent, port: out },
      to: { obj: t.id, port: OPPOSITE[out] },
      route: 'smoothstep',
      style: { color: EDGE_TREE, width: 1.5 },
    })
  }
  // dependencies: bezier with arrow; ports chosen by the direction the
  // target faces. A dep between two critical tasks is drawn critical.
  for (const t of tasks) {
    for (const d of t.deps ?? []) {
      const from = byId.get(d)
      const to = byId.get(t.id)
      if (!from || !to) continue
      const side = facingSide(from, to)
      const crit = !!(taskById.get(d)?.critical && t.critical)
      edges.push({
        id: `dep-${d}-${t.id}`,
        from: { obj: d, port: side },
        to: { obj: t.id, port: OPPOSITE[side] },
        route: 'bezier',
        style: crit
          ? { color: EDGE_CRITICAL, width: 2.5 }
          : { color: EDGE_DEP, width: 1.8 },
        markerEnd: 'arrow',
      })
    }
  }
  return { objects, edges }
}

export const SAMPLE_TASKS: Task[] = [
  { id: 't1', parent: null, name: '企画', effort: 3 },
  { id: 't11', parent: 't1', name: '要件定義', effort: 5, critical: true },
  { id: 't12', parent: 't1', name: '画面設計', effort: 4, deps: ['t11'], critical: true },
  { id: 't2', parent: null, name: '実装', effort: 8, deps: ['t12'], critical: true },
  { id: 't21', parent: 't2', name: 'core エンジン', effort: 5 },
  { id: 't22', parent: 't2', name: 'dom レンダラ', effort: 3, deps: ['t21'] },
  { id: 't23', parent: 't2', name: 'アダプタ', effort: 2, deps: ['t21'] },
  { id: 't3', parent: null, name: '検証・公開', effort: 3, deps: ['t2'], critical: true },
]
