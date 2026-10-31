// ページモデル — 実寸用紙枠をワールド mm 座標に並べる。
// Kimetron 非依存の純粋モデル。
//
//   - A4/A3 + 日本の書物サイズ（B5/B6/A5）× 縦/横
//   - 用紙サイズ/向きの変更は枠の差し替えのみ（オブジェクトの mm 座標は不変）
//   - ページ削除 = 枠だけ消す（スロットは空きとして残り、他は動かない）
//   - ページ挿入 = 挿入箇所以降のページ枠・全オブジェクトを1ページ分ずらす
//
// 積み方向（StackAxis）:
//   - 'y' 縦積み（組版モード）— ページを Y 方向へ並べ縦スクロール
//   - 'x' 横積み（執筆モード）— ページを右→左へ並べ横スクロール。
//     page0 が最右（slot0 は 'y' と同じ [OX, OX+W] 帯）、以降は X 負方向へ。
//   同じ PageModel が2つの世界座標系を持ち、remapRectAxis で往復変換する
//   （書庫・履歴は常に正準系 'y' で保持する規約 — app 側で変換）。

export type PaperSize = 'A4' | 'A3' | 'B5' | 'B6' | 'A5';

/** ページの積み方向。'y'=縦積み（下へ）、'x'=横積み（右→左、page0 が最右） */
export type StackAxis = 'y' | 'x';

export interface PaperSpec {
  size: PaperSize;
  landscape: boolean;
}

/** 用紙の実寸（mm、縦置き基準） */
export const PAPER_DIMS_MM: Record<PaperSize, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  A3: { w: 297, h: 420 },
  B5: { w: 182, h: 257 },
  B6: { w: 128, h: 182 },
  A5: { w: 148, h: 210 },
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

/** 積み方向ごとのページピッチ（mm）。
    'y' = 用紙高さ+段間（下へ）、'x' = 用紙幅+段間（左へ）。 */
export function pagePitchAlong(spec: PaperSpec, axis: StackAxis): number {
  const d = paperDims(spec);
  return (axis === 'y' ? d.h : d.w) + PAGE_GAP_MM;
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
  axis: StackAxis = 'y',
): { x: number; y: number; w: number; h: number } {
  const { w, h } = paperDims(spec);
  if (axis === 'x') {
    // 横積み — page0 は縦積みと同じ最右帯、以降のスロットは左へ延びる
    // （縦書き書物のページ送り方向と一致: 先→後 = 右→左）
    return {
      x: PAGE_ORIGIN_X - slot * pagePitchAlong(spec, 'x'),
      y: PAGE_ORIGIN_Y,
      w,
      h,
    };
  }
  return {
    x: PAGE_ORIGIN_X,
    y: PAGE_ORIGIN_Y + slot * pagePitchAlong(spec, 'y'),
    w,
    h,
  };
}

/** slot 昇順に実寸矩形を展開。index は表示順の振り直し番号 */
export function pageRects(
  spec: PaperSpec,
  pages: Page[],
  axis: StackAxis = 'y',
): PageRect[] {
  return [...pages]
    .sort((a, b) => a.slot - b.slot)
    .map((p, i) => ({
      id: p.id,
      slot: p.slot,
      index: i,
      ...pageRectAt(spec, p.slot, axis),
    }));
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
  /** ずらし判定の境界座標（積み軸上の値）。
      'y' = 挿入位置の枠上辺 y、'x' = 挿入位置の枠右辺 x+w
      （横積みでは「後のページ」= より小さい x 側なので
      applyStackShift の比較向きも軸依存になる） */
  threshold: number;
  /** ずらし量 = 1ページ分のピッチ（符号付き。'y' は +、'x' は −） */
  delta: number;
  /** この InsertResult が計算された積み軸 */
  axis: StackAxis;
}

/**
 * 表示順 index 番目のページの手前に新ページを挿入する計画を返す。
 * 挿入位置以降のスロットを +1（= 以降のページ枠が1枚分ずれる）。
 * オブジェクト側のずらしは呼び出し側が applyStackShift で適用する
 * （リンク関係は id 参照なので、ずらしても壊れない）。
 */
export function insertPage(
  model: PageModel,
  index: number,
  id?: string,
  axis: StackAxis = 'y',
): InsertResult {
  const sorted = [...model.pages].sort((a, b) => a.slot - b.slot);
  if (index < 0 || index >= sorted.length) {
    // 末尾追加と同じ — ずらし不要
    const slot = (sorted[sorted.length - 1]?.slot ?? -1) + 1;
    const page = { id: id ?? nextPageId(model.pages), slot };
    return {
      pages: [...model.pages, page],
      page,
      threshold: axis === 'y' ? Infinity : -Infinity,
      delta: 0,
      axis,
    };
  }
  const slot = sorted[index].slot;
  const page = { id: id ?? nextPageId(model.pages), slot };
  const r = pageRectAt(model.spec, slot, axis);
  return {
    pages: model.pages
      .map((p) => (p.slot >= slot ? { ...p, slot: p.slot + 1 } : p))
      .concat(page),
    page,
    // 'y': 枠の上辺より下のオブジェクトを下へ。
    // 'x': 枠の右辺（= ページ列方向の手前端）より左のオブジェクトを左へ。
    threshold: axis === 'y' ? r.y : r.x + r.w,
    delta: axis === 'y' ? pagePitchAlong(model.spec, 'y') : -pagePitchAlong(model.spec, 'x'),
    axis,
  };
}

/**
 * 挿入に伴うオブジェクトのずらしを適用する。
 *   - 'y': y >= threshold のオブジェクトを y += delta（下へ）
 *   - 'x': x <= threshold のオブジェクトを x += delta（左へ。delta は負）
 * threshold が非有限または delta が 0 のときは何もしない。
 */
export function applyStackShift<T extends { x: number; y: number }>(
  items: T[],
  axis: StackAxis,
  threshold: number,
  delta: number,
): T[] {
  if (!Number.isFinite(threshold) || delta === 0) return items;
  if (axis === 'y') {
    return items.map((o) => (o.y >= threshold ? { ...o, y: o.y + delta } : o));
  }
  return items.map((o) => (o.x <= threshold ? { ...o, x: o.x + delta } : o));
}

/** 縦ずらしを適用する（y >= thresholdY のオブジェクトのみ）。 */
export function applyVerticalShift<T extends { x: number; y: number }>(
  items: T[],
  thresholdY: number,
  dy: number,
): T[] {
  return applyStackShift(items, 'y', thresholdY, dy);
}

/**
 * 積み軸間のオブジェクト矩形変換（'y' ⇄ 'x'）。
 * オブジェクト中心が属するスロット帯を from 側で求め、ページローカルの
 * 中心オフセット (lx, ly) を保ったまま to 側の同スロット帯へ再配置する。
 *
 * スロット帯の規約（両軸で一致）:
 *   - 'y': 帯 s = [OY + s·Pv, OY + (s+1)·Pv) — ページ + その下の gap。
 *     中心の y から floor で帯を引く（x は任意 — lx として保持）。
 *   - 'x': 帯 s = (a_s − GAP, a_s + W] = 次ページ側の gap + ページ。
 *     横積みでは x が小さいほど後のページなので、帯は
 *     floor((OX + W − cx)/Ph) で引く。
 * 紙面上（lx∈[0,W]・ly∈[0,H]）のオブジェクトは往復変換で厳密に元へ戻る。
 * 余白・gap 内の中心も決定的に写るが、帯の端を跨ぐ極端な位置は
 * 隣の帯へ寄ることがある（中心基準なので跨ぎオブジェクトも破綻しない）。
 */
export function remapRectAxis(
  spec: PaperSpec,
  r: { x: number; y: number; w: number; h: number },
  from: StackAxis,
  to: StackAxis,
): { x: number; y: number; w: number; h: number } {
  if (from === to) return r;
  const { w: W } = paperDims(spec);
  const pv = pagePitchAlong(spec, 'y');
  const ph = pagePitchAlong(spec, 'x');
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  if (from === 'y') {
    const s = Math.floor((cy - PAGE_ORIGIN_Y) / pv);
    const lx = cx - PAGE_ORIGIN_X;
    const ly = cy - PAGE_ORIGIN_Y - s * pv;
    return {
      x: PAGE_ORIGIN_X - s * ph + lx - r.w / 2,
      y: PAGE_ORIGIN_Y + ly - r.h / 2,
      w: r.w,
      h: r.h,
    };
  }
  const s = Math.floor((PAGE_ORIGIN_X + W - cx) / ph);
  const lx = cx - (PAGE_ORIGIN_X - s * ph);
  const ly = cy - PAGE_ORIGIN_Y;
  return {
    x: PAGE_ORIGIN_X + lx - r.w / 2,
    y: PAGE_ORIGIN_Y + s * pv + ly - r.h / 2,
    w: r.w,
    h: r.h,
  };
}

/** ワールド y が属するページの表示順 index（枠外・gap 内は -1） */
export function pageIndexAtY(model: PageModel, y: number): number {
  return (
    pageRects(model.spec, model.pages).find((r) => y >= r.y && y < r.y + r.h)
      ?.index ?? -1
  );
}
