// Scratch repro — simulates App.tsx refitWritingAreas exactly for the
// A4 landscape → portrait toggle in write mode (axis 'x').
import { describe, expect, it } from 'vitest';
import {
  paperDims,
  pageRectAt,
  pageRects,
  createPages,
  setPaper,
  type PaperSpec,
  type PageModel,
  type StackAxis,
} from '../src/pages';
import { RUBY_LANE_RATIO } from '../src/tategaki';

// ── copied constants/helpers from app/src/App.tsx + types.ts ──
const TEXT_PAD_MM = 1;
const HANMEN_MARGIN_MM = 20;
const GENKO_GRID = { cells: 20, cols: 20 };
const TEXT_KIND = 'textarea';

interface GenkoGrid {
  cells: number;
  cols: number;
}

function hanmenBox(spec: PaperSpec): { bw: number; bh: number } {
  const { w, h } = paperDims(spec);
  return {
    bw: w - 2 * (HANMEN_MARGIN_MM + TEXT_PAD_MM),
    bh: h - 2 * (HANMEN_MARGIN_MM + TEXT_PAD_MM),
  };
}

function genkoFontSize(spec: PaperSpec, g: GenkoGrid): number | null {
  const { bw, bh } = hanmenBox(spec);
  const fs = Math.min(bh / g.cells, bw / (g.cols * (1 + RUBY_LANE_RATIO)));
  return Number.isFinite(fs) && fs > 0 ? fs : null;
}

function genkoFrame(
  spec: PaperSpec,
  slot: number,
  g: GenkoGrid,
  axis: StackAxis = 'y',
): { x: number; y: number; w: number; h: number; fontSize: number } | null {
  const fs = genkoFontSize(spec, g);
  if (fs == null) return null;
  const p = pageRectAt(spec, slot, axis);
  const w = g.cols * fs * (1 + RUBY_LANE_RATIO) + 2 * TEXT_PAD_MM;
  const h = g.cells * fs + 2 * TEXT_PAD_MM;
  return {
    x: p.x + (p.w - w) / 2,
    y: p.y + (p.h - h) / 2,
    w,
    h,
    fontSize: fs,
  };
}

interface WObj {
  id: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  data?: { fontSize: number; genko?: GenkoGrid; auto?: boolean };
}

function refitWritingAreas(
  objects: WObj[],
  prev: PageModel,
  next: PageModel,
  axis: StackAxis = 'y',
): WObj[] {
  const m = HANMEN_MARGIN_MM;
  const eps = 0.01;
  const prevRects = pageRects(prev.spec, prev.pages, axis);
  return objects.map((o) => {
    if (o.kind !== TEXT_KIND) return o;
    const g = o.data?.genko;
    if (g) {
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      const hit = prevRects.find(
        (r) => cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h,
      );
      if (!hit) return o;
      const pf = genkoFrame(prev.spec, hit.slot, g, axis);
      if (
        !pf ||
        Math.abs(o.x - pf.x) > eps ||
        Math.abs(o.y - pf.y) > eps ||
        Math.abs(o.w - pf.w) > eps ||
        Math.abs(o.h - pf.h) > eps
      )
        return o;
      const f = genkoFrame(next.spec, hit.slot, g, axis);
      if (!f) return o;
      return {
        ...o,
        x: f.x,
        y: f.y,
        w: f.w,
        h: f.h,
        data: { ...o.data!, fontSize: f.fontSize },
      };
    }
    const hit = prevRects.find(
      (r) =>
        Math.abs(o.x - (r.x + m)) <= eps &&
        Math.abs(o.y - (r.y + m)) <= eps &&
        Math.abs(o.w - (r.w - 2 * m)) <= eps &&
        Math.abs(o.h - (r.h - 2 * m)) <= eps,
    );
    if (!hit) return o;
    const p = pageRectAt(next.spec, hit.slot, axis);
    return {
      ...o,
      x: p.x + m,
      y: p.y + m,
      w: p.w - 2 * m,
      h: p.h - 2 * m,
    };
  });
}

describe('refit on landscape→portrait in write mode (axis x)', () => {
  it('genko area refits to the portrait frame', () => {
    const model = createPages({ size: 'A4', landscape: true }, 1);
    // write mode: objects installed in 'x' coords
    const f = genkoFrame(model.spec, 0, GENKO_GRID, 'x')!;
    const obj: WObj = {
      id: 'ta1',
      kind: TEXT_KIND,
      x: f.x,
      y: f.y,
      w: f.w,
      h: f.h,
      data: { fontSize: f.fontSize, genko: { ...GENKO_GRID }, auto: true },
    };
    const next = setPaper(model, { size: 'A4', landscape: false });
    const out = refitWritingAreas([obj], model, next, 'x');
    console.log('landscape frame:', f);
    console.log('refit result   :', out[0]);
    console.log(
      'portrait frame :',
      genkoFrame(next.spec, 0, GENKO_GRID, 'x'),
    );
    expect(out[0].w).not.toBeCloseTo(obj.w, 1);
    expect(out[0].data!.fontSize).not.toBeCloseTo(f.fontSize, 1);
  });
});
