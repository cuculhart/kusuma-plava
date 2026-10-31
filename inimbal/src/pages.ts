// ページモデル — 実寸用紙枠をワールド mm 座標に縦並びで置く。
// Kimetron 非依存の純粋モデル。
//
//   - A4/A3 × 縦/横のみ
//   - 用紙サイズ/向きの変更は枠の差し替えのみ（オブジェクトの mm 座標は不変）
//   - ページ削除 = 枠だけ消す（スロットは空きとして残り、他は動かない）
//   - ページ挿入 = 挿入箇所以下のページ枠・全オブジェクトを1ページ分下へ

export type PaperSize = 'A4' | 'A3';

export interface PaperSpec {
  size: PaperSize;
  landscape: boolean;
}

/** 用紙の実寸（mm、縦置き基準） */
export const PAPER_DIMS_MM: Record<PaperSize, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  A3: { w: 297, h: 420 },
};

export function paperDims(spec: PaperSpec): { w: number; h: number } {
  const d = PAPER_DIMS_MM[spec.size];
  return spec.landscape ? { w: d.h, h: d.w } : { w: d.w, h: d.h };
}

// 方眼紙上のページ起点・段間（spike 準拠）
export const PAGE_ORIGIN_X = 20;
export const PAGE_ORIGIN_Y = 20;
export const PAGE_GAP_MM = 12;

/** 縦ピッチ = 用紙高さ + 段間 */
export function pagePitch(spec: PaperSpec): number {
  return paperDims(spec).h + PAGE_GAP_MM;
}

/**
 * ページ枠はスロット番号で位置が決まる。
 * slot → 矩形 は現在の PaperSpec から常に再計算されるので、
 * 用紙差し替えで枠だけが新ピッチへ追従する。
 * 削除は slot を抜くだけ — 位置は詰めず、空き（gap）として残る。
 */
export interface Page {
  id: string;
  slot: number;
}

export interface PageRect {
  id: string;
  slot: number;
  /** 表示順（0-based。ページ番号・フッターの n/total に使う） */
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function pageRectAt(
  spec: PaperSpec,
  slot: number,
): { x: number; y: number; w: number; h: number } {
  const { w, h } = paperDims(spec);
  return {
    x: PAGE_ORIGIN_X,
    y: PAGE_ORIGIN_Y + slot * pagePitch(spec),
    w,
    h,
  };
}

/** slot 昇順に実寸矩形を展開。index は表示順の振り直し番号 */
export function pageRects(spec: PaperSpec, pages: Page[]): PageRect[] {
  return [...pages]
    .sort((a, b) => a.slot - b.slot)
    .map((p, i) => ({ id: p.id, slot: p.slot, index: i, ...pageRectAt(spec, p.slot) }));
}

export interface PageModel {
  spec: PaperSpec;
  pages: Page[];
}

export function createPages(spec: PaperSpec, count = 3): PageModel {
  return {
    spec,
    pages: Array.from({ length: count }, (_, i) => ({ id: `p${i + 1}`, slot: i })),
  };
}

export function nextPageId(pages: Page[]): string {
  let n = 0;
  for (const p of pages) {
    const m = /^p(\d+)$/.exec(p.id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `p${n + 1}`;
}

/** 末尾に追加（最大スロットの次 — 途中の空きは詰めない） */
export function addPage(model: PageModel, id?: string): PageModel {
  const slot = model.pages.reduce((m, p) => Math.max(m, p.slot), -1) + 1;
  return { ...model, pages: [...model.pages, { id: id ?? nextPageId(model.pages), slot }] };
}

/**
 * ページ削除 = 枠だけ消す。スロットは空きとして残り、
 * オブジェクトも他のページ枠も動かない（はみ出し放置と同じ扱い）。
 */
export function deletePage(model: PageModel, pageId: string): PageModel {
  return { ...model, pages: model.pages.filter((p) => p.id !== pageId) };
}

/**
 * 用紙サイズ・向きの差し替え。spec を変えるだけで、
 * 枠は slot → rect の再計算で新寸法・新ピッチへ追従する。
 * オブジェクトの mm 座標には一切触れない。
 */
export function setPaper(model: PageModel, spec: PaperSpec): PageModel {
  return { ...model, spec };
}

export interface InsertResult {
  pages: Page[];
  page: Page;
  /** この y 以上に始まるオブジェクトを dy だけ下へずらす */
  thresholdY: number;
  /** ずらし量 = 1ページ分の縦ピッチ（mm） */
  dy: number;
}

/**
 * 表示順 index 番目のページの手前に新ページを挿入する計画を返す。
 * 挿入位置以降のスロットを +1（= 以下のページ枠が1枚分下へ）。
 * オブジェクト側のずらしは呼び出し側が applyVerticalShift で適用する
 * （リンク関係は id 参照なので、ずらしても壊れない）。
 */
export function insertPage(
  model: PageModel,
  index: number,
  id?: string,
): InsertResult {
  const sorted = [...model.pages].sort((a, b) => a.slot - b.slot);
  if (index < 0 || index >= sorted.length) {
    // 末尾追加と同じ — ずらし不要
    const slot = (sorted[sorted.length - 1]?.slot ?? -1) + 1;
    const page = { id: id ?? nextPageId(model.pages), slot };
    return { pages: [...model.pages, page], page, thresholdY: Infinity, dy: 0 };
  }
  const slot = sorted[index].slot;
  const page = { id: id ?? nextPageId(model.pages), slot };
  return {
    pages: model.pages
      .map((p) => (p.slot >= slot ? { ...p, slot: p.slot + 1 } : p))
      .concat(page),
    page,
    thresholdY: pageRectAt(model.spec, slot).y,
    dy: pagePitch(model.spec),
  };
}

/** 縦ずらしを適用する（y >= thresholdY のオブジェクトのみ）。 */
export function applyVerticalShift<T extends { y: number }>(
  items: T[],
  thresholdY: number,
  dy: number,
): T[] {
  return items.map((o) => (o.y >= thresholdY ? { ...o, y: o.y + dy } : o));
}

/** ワールド y が属するページの表示順 index（枠外・gap 内は -1） */
export function pageIndexAtY(model: PageModel, y: number): number {
  return (
    pageRects(model.spec, model.pages).find((r) => y >= r.y && y < r.y + r.h)
      ?.index ?? -1
  );
}
