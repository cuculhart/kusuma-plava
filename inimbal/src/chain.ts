// INIMBAL — 文字送り stratum。Kimetron 非依存の純粋モデル。
//
// モデル:
//   TextChain = TextArea の順序つき連鎖（一方通行・線形のみ）
//   slices は chain text の厳密な分割（join(slices) + overflow === text）
//
// 計測は注入する（DOM/Canvas 依存をここに持ち込まない）

/** エリアの内寸（表示域）+ タイポグラフィ。
    width/height/fontSize の単位は呼び出し側と計測側で
    揃えておく（本アプリでは mm） */
export interface AreaBox {
  id: string;
  width: number;
  height: number;
  /** フォントサイズ（mm）。省略時は計測側の既定 */
  fontSize?: number;
  /** フォントファミリ（CSS 名）。省略時は計測側の既定 */
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  /** 部分装飾マーク（chain.text 基準の座標）— layoutChain が設定 */
  marks?: TextMark[];
  /** 渡した text の chain.text 内開始位置 — layoutChain が設定 */
  textOffset?: number;
}

/** テキスト計測の注入インターフェース */
export interface TextMeasurer {
  /** text を box の内寸へ流し込み、収まった接頭辞の文字数を返す */
  fit(text: string, box: AreaBox): number;
}

export interface Slice {
  areaId: string;
  text: string;
  /** chain.text 内での開始位置（部分装飾マークの交差計算用） */
  offset: number;
}

export interface LayoutResult {
  slices: Slice[];
  /** 連鎖末尾に収まらなかった残り */
  overflow: string;
}

/**
 * 連鎖テキストをエリア列へ貪欲に配分する。
 * boxes の順序 = 連鎖順。残りは overflow に返す。
 * marks を渡すと計測へ textOffset 付きで引き渡される。
 */
export function layoutChain(
  text: string,
  boxes: AreaBox[],
  measure: TextMeasurer,
  marks?: TextMark[],
): LayoutResult {
  const slices: Slice[] = [];
  let rest = text;
  let consumed = 0;
  for (const b of boxes) {
    const n = measure.fit(rest, {
      ...b,
      marks,
      textOffset: consumed,
    });
    slices.push({ areaId: b.id, text: rest.slice(0, n), offset: consumed });
    consumed += n;
    rest = rest.slice(n);
  }
  return { slices, overflow: rest };
}

/** テキストの部分装飾に指定できる属性（未指定はエリア既定へフォールバック） */
export interface TextAttrs {
  fontFamily?: string;
  /** mm */
  fontSize?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** URL リンク（印刷/PDF で <a> 化。編集画面では遷移しない） */
  link?: string;
}

/** chain.text の [start,end) に効く書式マーク。後勝ち（属性単位の上書き） */
export interface TextMark {
  start: number;
  end: number;
  attrs: Partial<TextAttrs>;
}

/** 順序つき連鎖。areas はエリア id の配列、text は連鎖全体の本文 */
export interface Chain {
  id: string;
  areas: string[];
  text: string;
  /** text 上の範囲指定書式 */
  marks?: TextMark[];
}

/** エリア id → 所属連鎖 */
export function chainOf(chains: Chain[], areaId: string): Chain | undefined {
  return chains.find((c) => c.areas.includes(areaId));
}

/** 連鎖内の位置（0-based）。未所属なら -1 */
export function chainPos(chain: Chain, areaId: string): number {
  return chain.areas.indexOf(areaId);
}

// 連結テキスト規則: 両方非空なら改行1つで継ぐ（spike 準拠）
function joinTexts(a: string, b: string): string {
  return a && b ? `${a}\n${b}` : a + b;
}

/**
 * 連結可能か: from が自連鎖の末尾、to が別連鎖の先頭。
 * 線形一方通行のみ — 末尾起点なので 1→複数 は出ず、
 * 先頭宛てなので 複数→1 も循環（同一連鎖への接続）も構造的に禁止。
 */
export function canLink(
  chains: Chain[],
  fromArea: string,
  toArea: string,
): boolean {
  const cf = chainOf(chains, fromArea);
  const ct = chainOf(chains, toArea);
  if (!cf || !ct || cf.id === ct.id) return false;
  return cf.areas[cf.areas.length - 1] === fromArea && ct.areas[0] === toArea;
}

/**
 * 2連鎖を from の末尾 → to の先頭で結合（text も連結）。
 * 不可なら chains をそのまま返す。to 側の連鎖は消える。
 */
export function linkChains(
  chains: Chain[],
  fromArea: string,
  toArea: string,
): Chain[] {
  if (!canLink(chains, fromArea, toArea)) return chains;
  const cf = chainOf(chains, fromArea)!;
  const ct = chainOf(chains, toArea)!;
  // joinTexts と同じ継ぎ目ルールで to 側マークをシフト
  const off = cf.text.length + (cf.text && ct.text ? 1 : 0);
  const marks = [
    ...(cf.marks ?? []),
    ...(ct.marks ?? []).map((m) => ({
      start: m.start + off,
      end: m.end + off,
      attrs: m.attrs,
    })),
  ];
  const merged: Chain = {
    id: cf.id,
    areas: [...cf.areas, ...ct.areas],
    text: joinTexts(cf.text, ct.text),
    ...(marks.length ? { marks } : {}),
  };
  return chains
    .map((c) => (c.id === cf.id ? merged : c))
    .filter((c) => c.id !== ct.id);
}

/**
 * chain の index 番目と index+1 番目の間を切断。
 * テキストは全量 head 側に残る（巻き戻し）。tail は空の新連鎖。
 */
export function unlinkAt(
  chains: Chain[],
  chainId: string,
  index: number,
  tailId: string,
): Chain[] {
  const c = chains.find((c) => c.id === chainId);
  if (!c || index < 0 || index >= c.areas.length - 1) return chains;
  const head: Chain = { ...c, areas: c.areas.slice(0, index + 1) };
  const tail: Chain = {
    id: tailId,
    areas: c.areas.slice(index + 1),
    text: '',
    marks: [],
  };
  return chains.flatMap((x) => (x.id === chainId ? [head, tail] : [x]));
}

// ---- 部分装飾マークの維持 ----

/**
 * 範囲 [s,e) への書式適用。既存マークは残し、後勝ちで上書きされる。
 * 空範囲や非正規化範囲は無視。
 */
export function applyMark(
  marks: TextMark[] | undefined,
  start: number,
  end: number,
  attrs: Partial<TextAttrs>,
): TextMark[] {
  const s = Math.min(start, end);
  const e = Math.max(start, end);
  if (e <= s) return marks ?? [];
  return [...(marks ?? []), { start: s, end: e, attrs }];
}

/**
 * 範囲 [s,e) と交差するマークを除去（跨ぐマークは両側に分割して残す）。
 */
export function clearMarksIn(
  marks: TextMark[] | undefined,
  start: number,
  end: number,
): TextMark[] {
  const s = Math.min(start, end);
  const e = Math.max(start, end);
  const out: TextMark[] = [];
  for (const m of marks ?? []) {
    if (m.end <= s || m.start >= e) {
      out.push(m);
      continue;
    }
    if (m.start < s) out.push({ start: m.start, end: s, attrs: m.attrs });
    if (m.end > e) out.push({ start: e, end: m.end, attrs: m.attrs });
  }
  return out;
}

/**
 * テキスト編集（oldText → newText）に合わせてマーク座標を維持する。
 * 共通接頭辞/接尾辞で差分区間を特定し、交差マークは縮小・削除、
 * 後続マークはシフトする。
 */
export function adjustMarksForEdit(
  marks: TextMark[] | undefined,
  oldText: string,
  newText: string,
): TextMark[] {
  if (!marks?.length || oldText === newText) return marks ?? [];
  let p = 0;
  const min = Math.min(oldText.length, newText.length);
  while (p < min && oldText[p] === newText[p]) p++;
  let so = 0;
  while (
    so < min - p &&
    oldText[oldText.length - 1 - so] === newText[newText.length - 1 - so]
  )
    so++;
  const delEnd = oldText.length - so; // [p, delEnd) が newText の挿入分に置換
  const insLen = newText.length - p - so;
  const delta = insLen - (delEnd - p);
  const out: TextMark[] = [];
  for (const m of marks) {
    const ns = m.start <= p ? m.start : m.start >= delEnd ? m.start + delta : p;
    const ne = m.end <= p ? m.end : m.end >= delEnd ? m.end + delta : p;
    if (ne > ns) out.push({ start: ns, end: ne, attrs: m.attrs });
  }
  return out;
}

/** 解決済みラン: スライス内の連続区間と合成属性 */
export interface TextRun {
  text: string;
  attrs: TextAttrs;
}

/**
 * スライス [0,text.length)（chain 上では offset 始まり）を
 * マークで区切ったラン列へ分解する。
 * 各ランの attrs は base へ後勝ちマージした解決値。
 */
export function sliceRuns(
  text: string,
  marks: TextMark[] | undefined,
  offset: number,
  base: TextAttrs,
): TextRun[] {
  if (!text) return [];
  const hits = (marks ?? []).filter(
    (m) => m.end > offset && m.start < offset + text.length,
  );
  if (!hits.length) return [{ text, attrs: { ...base } }];
  const bounds = new Set<number>([0, text.length]);
  for (const m of hits) {
    bounds.add(Math.max(0, m.start - offset));
    bounds.add(Math.min(text.length, m.end - offset));
  }
  const cuts = [...bounds].sort((a, b) => a - b);
  const runs: TextRun[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const s = cuts[i];
    const e = cuts[i + 1];
    if (e <= s) continue;
    const attrs: TextAttrs = { ...base };
    for (const m of hits) {
      if (m.start - offset <= s && m.end - offset >= e) {
        Object.assign(attrs, m.attrs);
      }
    }
    runs.push({ text: text.slice(s, e), attrs });
  }
  return runs;
}

/** 連鎖途中にエリアを挿入。テキストは不変 → 残りエリアへ再配分される */
export function insertArea(
  chains: Chain[],
  chainId: string,
  index: number,
  areaId: string,
): Chain[] {
  const c = chains.find((c) => c.id === chainId);
  if (!c || index < 0 || index > c.areas.length) return chains;
  const areas = [...c.areas.slice(0, index), areaId, ...c.areas.slice(index)];
  return chains.map((x) => (x.id === chainId ? { ...x, areas } : x));
}

/**
 * エリアを連鎖から外す。テキストは残りエリアへ再配分される。
 * 空になった連鎖は消す。
 */
export function removeArea(chains: Chain[], areaId: string): Chain[] {
  return chains.flatMap((c) => {
    if (!c.areas.includes(areaId)) return [c];
    const areas = c.areas.filter((a) => a !== areaId);
    return areas.length === 0 ? [] : [{ ...c, areas }];
  });
}

/**
 * 存在しないエリアを全連鎖から取り除く（テキストは保持 → 再配分）。
 * オブジェクト削除後の整合化に使う。
 */
export function pruneChains(
  chains: Chain[],
  exists: (areaId: string) => boolean,
): Chain[] {
  return chains.flatMap((c) => {
    const areas = c.areas.filter(exists);
    if (areas.length === c.areas.length) return [c];
    return areas.length === 0 ? [] : [{ ...c, areas }];
  });
}
