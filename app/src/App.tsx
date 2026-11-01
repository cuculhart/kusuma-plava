import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { IsleCanvas, useEngine, useEngineVersion } from '@kimetron/react';
import { formatLength, type Engine, type WorldObject } from '@kimetron/core';
import {
  addPage,
  adjustMarksForEdit,
  applyMark,
  applyStackShift,
  canLink,
  chainOf,
  clearMarksIn,
  createPages,
  deletePage,
  insertArea,
  insertPage,
  layoutChain,
  layoutVertical,
  linkChains,
  normalizeRuby,
  paperDims,
  pageRectAt,
  pageRects,
  pruneChains,
  remapRectAxis,
  RUBY_LANE_RATIO,
  setPaper,
  sliceRuns,
  tokenizeVertical,
  unlinkAt,
  type AreaBox,
  type Chain,
  type LayoutResult,
  type PageModel,
  type PaperSize,
  type PaperSpec,
  type StackAxis,
  type TextAttrs,
  type VFlow,
} from 'inimbal';
import { RightDock } from './Inspector';
import { LinkWires, type LinkSel } from './LinkWires';
import { MenuPane, type ShapeTool, type Theme } from './MenuPane';
import { PageNav } from './PageNav';
import { Printout } from './Printout';
import { Rulers } from './Rulers';
import { makeT, tf, type Lang } from './i18n';
import { packArchive, unpackArchive } from './docio';
import { loadDraft, saveDraft } from './autosave';
import { createCanvasMeasurer } from './measure';
import { vunitSpans, type VStyle } from './vtrender';
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_GRID_BG,
  DEFAULT_GRID_COLOR,
  DEFAULT_TEXT_DATA,
  GRID_CELL_ALPHA,
  GRID_LANE_ALPHA,
  gridLineCss,
  IMG_KIND,
  LINE_HEIGHT,
  liveRect,
  MM_PX,
  PAGE_KIND,
  TEXT_KIND,
  TEXT_PAD_MM,
  type GenkoGrid,
  type ImageData,
  type PageMargins,
  type TextAreaData,
} from './types';
import './styles.css';

/** ページ枠を kimetron オブジェクトとして展開する。
    locked + layer -1 で最背面・操作対象外（hitFilter でも除外）。
    axis = ページの積み方向（'y'=組版の縦積み / 'x'=執筆の右→左横積み） */
function pageObjects(
  model: PageModel,
  opacity = 1,
  axis: StackAxis = 'y',
  color = '#ffffff',
): WorldObject[] {
  return pageRects(model.spec, model.pages, axis).map((r) => ({
    id: r.id,
    kind: PAGE_KIND,
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    locked: true,
    layer: -1,
    style: { fill: gridLineCss(color, opacity) },
    data: { index: r.index },
  }));
}

/** 回しこみ対象のオブジェクト kind — 重なる rect/ellipse/image は
    外接矩形として障害になる（輪郭追従はしない。v0.4 の割り切り）。
    他のテキストエリア・線/曲線・ページ枠は障害に含めない */
const OBSTACLE_KINDS = new Set(['rect', 'ellipse', IMG_KIND]);

/** テキストエリアと重なる障害矩形を、エリア内寸ローカル mm で返す。
    内寸 = オブジェクト矩形 − 四方 TEXT_PAD_MM（fitVertical に渡る箱と
    同じ座標系）。liveRect 経由なのでドラッグ/リサイズ中も追従し、
    移動のたびに回しこみが再配分される。 */
function areaObstacles(
  engine: Engine,
  self: WorldObject,
): { x: number; y: number; w: number; h: number }[] | undefined {
  const r = liveRect(engine, self);
  const ix = r.x + TEXT_PAD_MM;
  const iy = r.y + TEXT_PAD_MM;
  const iw = Math.max(0, r.w - 2 * TEXT_PAD_MM);
  const ih = Math.max(0, r.h - 2 * TEXT_PAD_MM);
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (const o of engine.doc.objects) {
    if (o.id === self.id || !OBSTACLE_KINDS.has(o.kind)) continue;
    const q = liveRect(engine, o);
    if (q.x >= ix + iw || q.x + q.w <= ix || q.y >= iy + ih || q.y + q.h <= iy)
      continue;
    out.push({ x: q.x - ix, y: q.y - iy, w: q.w, h: q.h });
  }
  return out.length ? out : undefined;
}

/** ページの辺・中心をドラッグ/リサイズのスナップ対象へ登録する */
function syncSnapExtra(
  engine: Engine,
  model: PageModel,
  axis: StackAxis,
): void {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of pageRects(model.spec, model.pages, axis)) {
    xs.push(r.x, r.x + r.w / 2, r.x + r.w);
    ys.push(r.y, r.y + r.h / 2, r.y + r.h);
  }
  engine.snapExtra = { xs, ys };
}

/** 版面マージン（mm）— buildWritingDoc の簡易版面と
    用紙変更時の追従計算（refitWritingAreas）で共用する規約。
    天/地/小口/ノド一律 */
const HANMEN_MARGIN_MM = 20;

// v0.9: 版面マージン — PageMargins（types.ts 参照）。左右の指定では
// なく製本上の役割（ノド・小口）で管理するのが書籍組版の作法
const DEFAULT_MARGINS: PageMargins = {
  top: HANMEN_MARGIN_MM,
  bottom: HANMEN_MARGIN_MM,
  inside: HANMEN_MARGIN_MM,
  outside: HANMEN_MARGIN_MM,
};

/** slot ページの左右マージンを parity で展開 — 右綴じでは
    奇数ページ（slot0,2,4…=右ページ）のノド=左、偶数ページの
    ノド=右。ノド（inside）の方が小口より広いのが製本の作法。 */
function marginInsets(m: PageMargins, slot: number): {
  l: number;
  r: number;
  t: number;
  b: number;
} {
  const oddPage = slot % 2 === 0;
  return {
    l: oddPage ? m.inside : m.outside,
    r: oddPage ? m.outside : m.inside,
    t: m.top,
    b: m.bottom,
  };
}

/** 版面の実効内寸（mm）= 用紙 − マージン − エリア内側余白
    TEXT_PAD_MM。升目数（hanmenCells 表示）と升目枠計算で
    同じ箱を共有するためのヘルパ。 */
function hanmenBox(
  spec: PaperSpec,
  margins: PageMargins = DEFAULT_MARGINS,
): { bw: number; bh: number } {
  const { w, h } = paperDims(spec);
  return {
    bw: w - (margins.inside + margins.outside) - 2 * TEXT_PAD_MM,
    bh: h - (margins.top + margins.bottom) - 2 * TEXT_PAD_MM,
  };
}

/** 升目グリッド枠の既定 — 原稿用紙 縦20字×横20段（=400字詰） */
const GENKO_GRID: GenkoGrid = { cells: 20, cols: 20 };

/** v0.7: 柱 — 天余白の上端と字サイズ（mm）。升目枠の右辺に欄の右端を
    揃え、枠の上辺までを高さとする縦書き1段（hashiraRect 参照） */
const HASHIRA_TOP_MM = 5;
const HASHIRA_FONT_MM = 3;

/** 用紙 spec に対する升目枠の字サイズ（mm）—
    fs = min(版面高/cells, 版面幅/(cols × 段ピッチ係数))。
    段ピッチ = fontSize × (1 + RUBY_LANE_RATIO)。A4縦なら段ピッチが
    拘束して fs≈5.25mm（升目内寸 105×168mm）。非有限・0以下は null。 */
function genkoFontSize(
  spec: PaperSpec,
  g: GenkoGrid,
  margins: PageMargins = DEFAULT_MARGINS,
): number | null {
  const { bw, bh } = hanmenBox(spec, margins);
  const n = g.columns ?? 1;
  const gap = g.gapMm ?? 7;
  const colW = (bw - (n - 1) * gap) / n;
  const fs = Math.min(bh / g.cells, colW / (g.cols * (1 + RUBY_LANE_RATIO)));
  return Number.isFinite(fs) && fs > 0 ? fs : null;
}

/** slot ページの升目枠を段数分すべて返す（右→左の順 = col 0..n-1）。
    版面箱を段間 gap で等分し、各段箱の中央に升目枠を寄せる */
function genkoFrames(
  spec: PaperSpec,
  slot: number,
  g: GenkoGrid,
  axis: StackAxis = 'y',
  margins: PageMargins = DEFAULT_MARGINS,
): { x: number; y: number; w: number; h: number; fontSize: number; col: number }[] {
  const fs = genkoFontSize(spec, g, margins);
  if (fs == null) return [];
  const p = pageRectAt(spec, slot, axis);
  const n = Math.max(1, Math.min(3, Math.round(g.columns ?? 1)));
  const gap = g.gapMm ?? 7;
  const i = marginInsets(margins, slot);
  const bw = p.w - i.l - i.r;
  const bh = p.h - i.t - i.b;
  const w = g.cols * fs * (1 + RUBY_LANE_RATIO) + 2 * TEXT_PAD_MM;
  const h = g.cells * fs + 2 * TEXT_PAD_MM;
  const colW = (bw - (n - 1) * gap) / n;
  return Array.from({ length: n }, (_, col) => {
    // col 0 = 右端の段 — 版面箱の右から積む（縦書きの段順）
    const cx = p.x + i.l + bw - (col + 1) * colW - col * gap;
    return {
      x: cx + (colW - w) / 2,
      y: p.y + i.t + (bh - h) / 2,
      w,
      h,
      fontSize: fs,
      col,
    };
  });
}

/** slot ページ上の升目枠矩形 — エリア内寸をちょうど cells×cols 升にし、
    矩形は内寸 + 四方 TEXT_PAD_MM（fit() へ渡る箱が p-2×PAD なので
    升目割りが端数なく一致する）。ページ内で両軸中央寄せ。 */
function genkoFrame(
  spec: PaperSpec,
  slot: number,
  g: GenkoGrid,
  axis: StackAxis = 'y',
  margins: PageMargins = DEFAULT_MARGINS,
  col = 0,
): { x: number; y: number; w: number; h: number; fontSize: number } | null {
  const f = genkoFrames(spec, slot, g, axis, margins)[col];
  return f ? { x: f.x, y: f.y, w: f.w, h: f.h, fontSize: f.fontSize } : null;
}

/** 執筆モード既定ドキュメント（v0.2）— 第1ページに縦書き
    テキストエリア1枚 + それに繋がる連鎖1本。
    v0.4: エリアは版面一杯ではなく 縦20字×横20段 の升目グリッド枠
    （data.genko）— 枠はページ両軸中央寄せ、字サイズは枠がちょうど
    20×20 になる値。新規作成・初期起動で「原稿用紙 + 執筆ペイン」の
    形に開く。 */
function buildWritingDoc(font: string): {
  model: PageModel;
  objects: WorldObject[];
  chains: Chain[];
} {
  const model = createPages({ size: 'A4', landscape: true }, 1);
  // 生成するオブジェクトは常に正準系 'y' 座標 — インストール時に
  // 現在のモード軸へ remapAxis で載せ替える（書庫・下書き比較の基準形）
  const p = pageRectAt(model.spec, 0, 'y');
  const m = HANMEN_MARGIN_MM;
  // v0.6: 段数分の枠を右→左で生成（単段なら従来どおり1枚）。
  // 升目枠が組めない極端な用紙では旧来の版面ぴったりエリアへ退く
  const frames = genkoFrames(model.spec, 0, GENKO_GRID, 'y');
  const rects = frames.length
    ? frames
    : [{ x: p.x + m, y: p.y + m, w: p.w - 2 * m, h: p.h - 2 * m, fontSize: undefined as number | undefined, col: 0 }];
  const areaIds = rects.map((_, i) => `ta${i + 1}`);
  return {
    model,
    objects: rects.map((rect, i) => ({
      id: areaIds[i],
      kind: TEXT_KIND,
      ...rect,
      style: { stroke: 'rgba(90,110,140,0.4)' },
      // 既定は縦書き（v0.1 の新規エリア既定と同じ）
      data: {
        ...DEFAULT_TEXT_DATA,
        fontFamily: font,
        fontSize: rect.fontSize ?? DEFAULT_TEXT_DATA.fontSize,
        writing: 'vertical-rl',
        // 自動生成の印 — 用紙変更時の版面追従の判別材料
        // （判定自体は版面矩形との一致で行う。refitWritingAreas 参照）
        auto: true,
        // 升目枠の印 — 用紙変更時は枠ごと再計算して追従する
        ...(frames.length
          ? { genko: { ...GENKO_GRID }, col: rects[i].col }
          : {}),
      },
    })),
    chains: [{ id: 'c1', areas: areaIds, text: '' }],
  };
}

/** 用紙 spec 変更に伴い、自動生成のテキストエリアを新しい用紙へ追従させる。
    対象は2系統:
      - data.genko 付きの升目グリッド枠 — 旧 spec で枠の中央寄せ矩形と
        一致しているものだけ新 spec の升目枠（字サイズ・位置を再計算）
        へ追従。枠から外れている = ユーザーが動かした/整形したものは
        触らない。
      - genko の無い旧来エリア — 旧 spec のいずれかのページ版面
        （HANMEN_MARGIN_MM 内側）をちょうど覆うものは新版面矩形へ追従。
        判定を data.auto の印ではなく版面矩形との一致で行うのは、
        印のない旧 .slm 書庫・旧下書きの自動生成エリアも救済するため。
    いずれの系統でも、版面/枠から外れているエリア、画像・その他の
    オブジェクトは一切触れない。追従先は同じページスロットの新 spec での
    矩形（属するページは升目枠は中心点、旧来は矩形一致で判定）。 */
function refitWritingAreas(
  objects: WorldObject[],
  prev: PageModel,
  next: PageModel,
  axis: StackAxis = 'y',
  margins: PageMargins = DEFAULT_MARGINS,
): WorldObject[] {
  const eps = 0.01; // mm — 浮動小数の計算誤差を許容
  const prevRects = pageRects(prev.spec, prev.pages, axis);
  return objects.map((o) => {
    if (o.kind !== TEXT_KIND) return o;
    const d = o.data as TextAreaData | undefined;
    const g = d?.genko;
    if (g) {
      // 升目枠 — 属するページを中心点で判定し、旧 spec での枠矩形と
      // 一致しているものだけ新枠へ追従（手動で動かした枠はそのまま）
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      const hit = prevRects.find(
        (r) => cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h,
      );
      if (!hit) return o;
      const pf = genkoFrame(
        prev.spec,
        hit.slot,
        g,
        axis,
        margins,
        d?.col ?? 0,
      );
      if (
        !pf ||
        Math.abs(o.x - pf.x) > eps ||
        Math.abs(o.y - pf.y) > eps ||
        Math.abs(o.w - pf.w) > eps ||
        Math.abs(o.h - pf.h) > eps
      )
        return o;
      const f = genkoFrame(
        next.spec,
        hit.slot,
        g,
        axis,
        margins,
        d?.col ?? 0,
      );
      if (!f) return o;
      return {
        ...o,
        x: f.x,
        y: f.y,
        w: f.w,
        h: f.h,
        data: { ...(o.data as TextAreaData), fontSize: f.fontSize },
      };
    }
    const hit = prevRects.find((r) => {
      const i = marginInsets(margins, r.slot);
      return (
        Math.abs(o.x - (r.x + i.l)) <= eps &&
        Math.abs(o.y - (r.y + i.t)) <= eps &&
        Math.abs(o.w - (r.w - i.l - i.r)) <= eps &&
        Math.abs(o.h - (r.h - i.t - i.b)) <= eps
      );
    });
    if (!hit) return o;
    const p = pageRectAt(next.spec, hit.slot, axis);
    const ni = marginInsets(margins, hit.slot);
    return {
      ...o,
      x: p.x + ni.l,
      y: p.y + ni.t,
      w: p.w - ni.l - ni.r,
      h: p.h - ni.t - ni.b,
    };
  });
}

/** 画像取り込みダイアログの状態 */
interface ImgDlg {
  url: string;
  natW: number;
  natH: number;
  w: number;
  h: number;
  lock: boolean;
}

export function App() {
  const engine = useEngine({
    units: 'mm',
    origin: 'top-left',
    grid: { size: 5, snap: true, major: 2 }, // 5mm 副線 / 10mm 主線
  });
  useEngineVersion(engine);

  // 空ドキュメントは執筆レイアウト（版面エリア+連鎖）で開く
  const [initDoc] = useState(() => buildWritingDoc(DEFAULT_FONT_FAMILY));
  const [model, setModel] = useState<PageModel>(() => initDoc.model);
  const [chains, setChains] = useState<Chain[]>(() => initDoc.chains);
  const [linkMode, setLinkMode] = useState(false);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [selLink, setSelLink] = useState<LinkSel | null>(null);
  const [hint, setHint] = useState('');
  const [imgDlg, setImgDlg] = useState<ImgDlg | null>(null);
  const [placing, setPlacing] = useState<{
    url: string;
    w: number;
    h: number;
    aspect: number;
    lock: boolean;
  } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    wire?: LinkSel;
  } | null>(null);
  const [printing, setPrinting] = useState(false);
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('kusuma-theme') as Theme) || 'standard',
  );
  const [collapsed, setCollapsed] = useState(false);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [lang, setLang] = useState<Lang>(
    () => (localStorage.getItem('kusuma-lang') as Lang) || 'ja',
  );
  const t = makeT(lang);
  // 用紙の透過 — 既定 75%（新規文書・初期起動）。書庫・下書き・
  // 履歴スナップには値ごと保存されるため復元時は保存値が優先される
  const [pageOpacity, setPageOpacity] = useState(75);
  // v0.9: 用紙色 — 文書設定。白固定から任意色+透過へ
  // （ダークテーマでは暗い紙＋明るい文字の組合せにする）
  const [paperColor, setPaperColor] = useState('#ffffff');
  const [footer, setFooter] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [activePage, setActivePage] = useState(0);
  const [shapeTool, setShapeTool] = useState<ShapeTool | null>(null);
  const [shapeDrag, setShapeDrag] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const [docTitle, setDocTitle] = useState('');
  const [saveDlg, setSaveDlg] = useState<string | null>(null);
  const [rulerOn, setRulerOn] = useState(true);
  const [histTick, setHistTick] = useState(0);
  const createdAtRef = useRef(new Date().toISOString());
  const dirtyRef = useRef(false);
  const applyingRef = useRef(false);
  const [docFont, setDocFont] = useState(DEFAULT_FONT_FAMILY);
  // v0.9: 文書既定の文字色 — 文書設定。既定フォントと同じく
  // 本文全体へ伝播する（ダークテーマで白系へ一括変更する用途）
  const [docColor, setDocColor] = useState('#222222');
  // v0.2: 執筆/組版モード — 既定は執筆（レイアウト編集は組版で開放）。
  // localStorage 'kusuma-mode' に永続化
  const [writeMode, setWriteMode] = useState(
    () => localStorage.getItem('kusuma-mode') !== 'layout',
  );
  // 執筆モードでの連鎖選択（キャンバス選択とは独立）
  const [writeChainId, setWriteChainId] = useState<string | null>(null);
  // 字下げ — Enter 入力時に段落頭の全角スペースを自動挿入（既定ON）
  const [indent, setIndent] = useState(
    () => localStorage.getItem('kusuma-indent') !== '0',
  );
  // v0.3: ページ番号（ノンブル）— 文書設定。.slm の doc.json へ保存。
  // 新規文書は既定 ON（書庫・下書きは保存値をそのまま使う）
  const [pageNum, setPageNum] = useState(true);
  // v0.3: 升目の印刷出し分け — 文書設定。既定 ON（WYSIWYG 整合:
  // キャンバスに見える升目はそのまま印刷に出る）
  const [gridPrint, setGridPrint] = useState(true);
  // v0.5: 1ページあたりの升目数 — 文書設定（doc.json の genko）。
  // data.genko を持つ升目枠エリアはこの仕様へ枠ごと追従する。
  // 欠落の旧書庫・新規文書は 20×20
  const [genko, setGenko] = useState<GenkoGrid>(() => ({ ...GENKO_GRID }));
  // v0.6: 升目線の色+濃さ — 文書設定（doc.json の gridColor/gridAlpha）。
  // 透過 100% は従来の薄いグレー（0.45/0.18）と同じ見た目
  const [gridColor, setGridColor] = useState(DEFAULT_GRID_COLOR);
  const [gridAlpha, setGridAlpha] = useState(1);
  // v0.9: 升目マスの背景色+濃さ — 文書設定。枠オブジェクトの
  // style.fill へ入りキャンバス・印刷ともに背景として出る
  const [gridBg, setGridBg] = useState(DEFAULT_GRID_BG);
  const [gridBgAlpha, setGridBgAlpha] = useState(0);
  // v0.7: 柱（タイトル等の走り書き）— 文書設定。天余白・升目枠の右辺
  // 揃えで縦書きに出す。空=出さない。doc.json の hashira へ保存
  const [hashira, setHashira] = useState('');
  // v0.9: 版面マージン（mm・四方共通）— 文書設定。升目枠の字サイズと
  // 版面内寸の計算に使う（文庫など小口マージンの判型用）
  const [margins, setMargins] = useState<PageMargins>(() => ({
    ...DEFAULT_MARGINS,
  }));
  // v0.3: 目標字数 — アプリ設定（文書ではなく環境の好み）として
  // localStorage へ。正準値は字数（枚数入力は ×400 で畳み込む）
  const [goal, setGoal] = useState(
    () => +(localStorage.getItem('kusuma-goal') ?? 0) || 0,
  );
  // v0.3: 自動保存した下書きの時刻（「下書き HH:MM」表示用）
  const [draftAt, setDraftAt] = useState<string | null>(null);
  // 起動時の下書き確認が済むまで自動保存を走らせない
  // （確認前に空ドキュメントを保存して下書きを上書きするのを防ぐ）
  const draftReadyRef = useRef(false);
  type Snap = {
    objects: WorldObject[];
    chains: Chain[];
    model: PageModel;
    footer: boolean;
    title: string;
    pageOpacity: number;
    paperColor: string;
    docFont: string;
    docColor: string;
    pageNum: boolean;
    gridPrint: boolean;
    genko: GenkoGrid;
    gridColor: string;
    gridBg: string;
    gridBgAlpha: number;
    gridAlpha: number;
    hashira: string;
    margins: PageMargins;
  };
  const histRef = useRef<{ past: Snap[]; future: Snap[]; last: number }>({
    past: [],
    future: [],
    last: 0,
  });
  const snapRef = useRef<Snap | null>(null);

  const seqRef = useRef(1);
  /** 既存オブジェクト・連鎖と衝突しない id を採番する
      （デモ/書庫読込の固定 id とぶつからないよう走査） */
  const nextId = (prefix: 'ta' | 'im' | 'sh' | 'c'): string => {
    const taken = new Set([
      ...engine.doc.objects.map((o) => o.id),
      ...chainsRef.current.map((c) => c.id),
    ]);
    let n = seqRef.current;
    while (taken.has(`${prefix}${n}`)) n++;
    seqRef.current = n + 1;
    return `${prefix}${n}`;
  };
  const canvasRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const openFileRef = useRef<HTMLInputElement>(null);
  const chainsRef = useRef(chains);
  chainsRef.current = chains;
  const linkModeRef = useRef(linkMode);
  linkModeRef.current = linkMode;
  const writeModeRef = useRef(writeMode);
  writeModeRef.current = writeMode;
  const placingRef = useRef(placing);
  placingRef.current = placing;
  const measurerRef = useRef(createCanvasMeasurer());

  // ── 積み軸（v0.4）— ページは同じ PageModel を2つの世界座標系で解釈する:
  //   'y' = 組版モードの縦積み（従来）、'x' = 執筆モードの右→左横積み。
  // エンジンの doc オブジェクトは常に「現在のモード軸」の座標で保持し、
  // モード切替時に remapAxis で全オブジェクトを載せ替える。
  // 書庫・履歴スナップ・下書き・印刷展開は常に正準系 'y' — 境界で
  // canon/uncanon が変換する（往復変換は紙面上のオブジェクトで厳密）。
  const curAxis = (): StackAxis => (writeModeRef.current ? 'x' : 'y');
  const remapAxis = (
    objects: WorldObject[],
    from: StackAxis,
    to: StackAxis,
    spec: PaperSpec,
  ): WorldObject[] =>
    from === to
      ? objects
      : objects.map((o) => {
          const r = remapRectAxis(spec, o, from, to);
          return { ...o, x: r.x, y: r.y };
        });
  /** 現在モード座標のオブジェクト列 → 正準系 'y' */
  const canon = (objects: WorldObject[], spec = model.spec) =>
    remapAxis(objects, curAxis(), 'y', spec);
  /** 正準系 'y' のオブジェクト列 → 現在モード座標 */
  const uncanon = (objects: WorldObject[], spec = model.spec) =>
    remapAxis(objects, 'y', curAxis(), spec);

  const flash = (msg: string) => {
    setHint(msg);
    window.setTimeout(() => setHint((h) => (h === msg ? '' : h)), 2500);
  };

  // ── 初期化: ページ枠 + デモの連鎖エリア ──
  useEffect(() => {
    // 執筆モードではキャンバス上のオブジェクト選択・ドラッグを抑止する
    // （レイアウト編集は組版モード側の仕事 — 執筆ペインは別駆動）
    engine.hitFilter = (o) =>
      o.kind !== PAGE_KIND &&
      !linkModeRef.current &&
      !writeModeRef.current;
    engine.marqueeFilter = (o) =>
      o.kind !== PAGE_KIND &&
      !linkModeRef.current &&
      !writeModeRef.current;
    // kimetron 1.6.0: アスペクト比ロック画像は角リサイズで比率を保持
    engine.resizeAspect = (o) =>
      o.kind === IMG_KIND && (o.data as ImageData)?.lock
        ? (o.data as ImageData).aspect
        : null;
    engine.setDoc({
      ...engine.doc,
      objects: [
        ...pageObjects(model, 1, curAxis()),
        ...uncanon(initDoc.objects),
      ],
    });
    syncSnapExtra(engine, model, curAxis());
    focusPage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  // F27: 曲線ツール → kimetron P49 の多点入力モード
  useEffect(() => {
    if (shapeTool === 'curve') engine.startShapeDraw('curve');
    else if (engine.mode === 'shape') engine.cancelShapeDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapeTool, engine]);

  // ── doc 変更 → 消えたエリアを連鎖から取り除く（テキストは保持→再配分） ──
  useEffect(
    () =>
      engine.onDocChange((doc) => {
        const alive = new Set(
          doc.objects.filter((o) => o.kind === TEXT_KIND).map((o) => o.id),
        );
        setChains((cs) => pruneChains(cs, (id) => alive.has(id)));
        setSelLink((sl) => {
          if (!sl) return sl;
          const c = chainsRef.current.find((x) => x.id === sl.chainId);
          return c && sl.index < c.areas.length - 1 ? sl : null;
        });
      }),
    [engine],
  );

  // ── Del: リンク線選択時は巻き戻し切断、オブジェクト選択時は削除 ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = document.activeElement as HTMLElement | null;
      if (t && ['TEXTAREA', 'INPUT', 'SELECT'].includes(t.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        setSaveDlg(docTitle || 'document');
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (!writeModeRef.current) duplicateSel();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        // preventDefault しない — copy イベント側で同期的に
        // マーカーを clipboardData.setData する（N-18 画像ペースト対策）
        copySel();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        // ペースト処理はすべて paste イベント側で行う —
        // clipboardData の中身（内部コピーのマーカーか、外部の
        // 画像か）を見て振り分ける必要があるため
        return;
      }
      if (e.key === 'Enter' && engine.mode === 'shape') {
        e.preventDefault();
        commitCurve();
        return;
      }
      if (e.key === 'Escape') {
        setLinkMode(false);
        setLinkFrom(null);
        setSelLink(null);
        setCtxMenu(null);
        setShapeTool(null);
        setShapeDrag(null);
        if (engine.mode === 'shape') engine.cancelShapeDraw();
        if (placingRef.current) {
          setPlacing(null);
          setGhost(null);
        }
        return;
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      // 執筆モードではオブジェクト削除・ワイヤー切断を抑止
      if (writeModeRef.current) return;
      if (selLink) {
        setChains((cs) =>
          unlinkAt(cs, selLink.chainId, selLink.index, nextId('c')),
        );
        setSelLink(null);
      } else {
        engine.removeSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    // N-18: クリップボード画像 → 新規 image オブジェクト
    const onPaste = (e: ClipboardEvent) => {
      const t = document.activeElement as HTMLElement | null;
      const editable =
        t && ['TEXTAREA', 'INPUT', 'SELECT'].includes(t.tagName);
      const isMark =
        e.clipboardData?.getData('text/plain') === CLIP_MARK;
      if (isMark) {
        // 内部コピー = 最新 — 入力欄ではマーカー文字列が挿入されない
        // よう抑止し、キャンバスでは内部バッファを貼る
        e.preventDefault();
        if (!editable) pasteSel();
        return;
      }
      if (editable) return; // 外部テキストのネイティブ貼り付けを通す
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (!it.type.startsWith('image/')) continue;
        const file = it.getAsFile();
        if (!file) continue;
        e.preventDefault();
        const rd = new FileReader();
        rd.onload = () => {
          const url = rd.result as string;
          const img = new Image();
          img.onload = () => {
            const aspect = img.naturalHeight / img.naturalWidth;
            const w = Math.min(100, img.naturalWidth / MM_PX);
            const p = lastClickRef.current ?? { x: 30, y: 30 };
            const id = nextId('im');
            engine.addObject({
              id,
              kind: IMG_KIND,
              x: p.x,
              y: p.y,
              w,
              h: w * aspect,
              data: { url, aspect, lock: true } satisfies ImageData,
            });
            engine.setSelection([id]);
          };
          img.src = url;
        };
        rd.readAsDataURL(file);
        return;
      }
    };
    // アプリ内コピー時は OS クリップボードへマーカーを書き込み、
    // 残り物（画像等）が Ctrl+V で紛れ込まないようにする。
    // copy イベントの setData は同期的なので確実に上書きされる
    const onCopy = (e: ClipboardEvent) => {
      const t = document.activeElement as HTMLElement | null;
      if (t && ['TEXTAREA', 'INPUT', 'SELECT'].includes(t.tagName)) return;
      if (!copyBuf.current.length) return;
      e.clipboardData?.setData('text/plain', CLIP_MARK);
      e.preventDefault();
    };
    window.addEventListener('copy', onCopy);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('paste', onPaste);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, selLink, docTitle]);

  // ── Ctrl+P / ブラウザの印刷メニューでも印刷用 DOM を組み立てる ──
  useEffect(() => {
    const onBefore = () => flushSync(() => setPrinting(true));
    window.addEventListener('beforeprint', onBefore);
    return () => window.removeEventListener('beforeprint', onBefore);
  }, []);

  // ── ページ操作（F3） ──
  const commitPages = (next: PageModel, objects?: WorldObject[]) => {
    setModel(next);
    const content =
      objects ?? engine.doc.objects.filter((o) => o.kind !== PAGE_KIND);
    engine.setDoc({
      ...engine.doc,
      ...next, // v0.9: spec/pages も engine.doc へ載せ替える —
      // 残すと旧ページ情報が残影（ghost page）として出る
      objects: [
        ...pageObjects(next, pageOpacity / 100, curAxis(), paperColor),
        ...content,
      ],
    });
    syncSnapExtra(engine, next, curAxis());
  };
  // v0.6: slot ページの段組升目枠を右→左（col 0..n-1）で生成
  const genkoAreaObjs = (
    spec: PaperSpec,
    slot: number,
    g: GenkoGrid,
    ax: StackAxis,
    m: PageMargins,
  ): WorldObject[] =>
    genkoFrames(spec, slot, g, ax, m).map((f) => ({
      id: nextId('ta'),
      kind: TEXT_KIND,
      x: f.x,
      y: f.y,
      w: f.w,
      h: f.h,
      style: {
        stroke: 'rgba(90,110,140,0.4)',
        fill: gridLineCss(gridBg, gridBgAlpha),
      },
      data: {
        ...DEFAULT_TEXT_DATA,
        fontFamily: docFont,
        fontSize: f.fontSize,
        writing: 'vertical-rl',
        auto: true,
        genko: { ...g },
        col: f.col,
      } satisfies TextAreaData,
    }));
  // 用紙サイズ・向きの変更 — 版面を覆う自動生成エリアは
  // 新しい版面へ追従させる（手置きエリアは触らない。refitWritingAreas 参照）
  const applySpec = (spec: PageModel['spec']) => {
    const next = setPaper(model, spec);
    commitPages(
      next,
      refitWritingAreas(contentObjects(), model, next, curAxis(), margins),
    );
    focusPage(curPage, next);
  };
  const setSize = (size: PaperSize) => applySpec({ ...model.spec, size });
  const toggleLandscape = () =>
    applySpec({ ...model.spec, landscape: !model.spec.landscape });
  const appendPage = () => {
    const next = addPage(model);
    const content = contentObjects();
    // 執筆モードでは新ページにも升目グリッド枠を自動生成し、
    // 執筆中の連鎖（未選択なら先頭連鎖 = dockChain と同じ選び方）の
    // 末尾へ繋ぐ — あふれが次ページへそのまま流れる
    if (writeModeRef.current) {
      const slot = next.pages[next.pages.length - 1].slot;
      const areas = genkoAreaObjs(
        next.spec,
        slot,
        genko,
        curAxis(),
        margins,
      );
      if (areas.length) {
        content.push(...areas);
        const target =
          chainsRef.current.find((c) => c.id === writeChainId) ??
          chainsRef.current[0];
        if (target) {
          const ids = areas.map((a) => a.id);
          setChains((cs) =>
            cs.map((c) =>
              c.id === target.id
                ? { ...c, areas: [...c.areas, ...ids] }
                : c,
            ),
          );
        }
      }
    }
    commitPages(next, content);
  };
  const removePage = (id: string) => {
    // v0.9: ページ上のコンテンツオブジェクトも一緒に消し、
    // 連鎖からも外す — 残ると消えたページのエリアが連鎖に
    // 残ってテキストが末尾へ「あふれ」扱いになる
    const ax = curAxis();
    const pr = pageRects(model.spec, model.pages, ax).find(
      (r) => r.id === id,
    );
    const inside = new Set<string>();
    const objs = engine.doc.objects.filter((o) => {
      if (!pr) return true;
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      const hit =
        cx >= pr.x &&
        cx < pr.x + pr.w &&
        cy >= pr.y &&
        cy < pr.y + pr.h;
      if (!hit) return true;
      // 消すページの枠自身も除去 — 残すと空の紙だけの残影が出る
      if (o.kind !== PAGE_KIND) inside.add(o.id);
      return false;
    });
    if (inside.size)
      setChains((cs) =>
        cs.map((c) => ({
          ...c,
          areas: c.areas.filter((a) => !inside.has(a)),
        })),
      );
    commitPages(deletePage(model, id), objs);
  };
  const insertAt = (index: number) => {
    const ax = curAxis();
    const res = insertPage(model, index, undefined, ax);
    const content = applyStackShift(
      engine.doc.objects.filter((o) => o.kind !== PAGE_KIND),
      res.axis,
      res.threshold,
      res.delta,
    );
    const next = { ...model, pages: res.pages };
    // 執筆モードでは挿入ページにも升目グリッド枠を自動生成する
    // （ページ追加 appendPage と同じ規約 — 枠が無いと升目が描かれず
    // 執筆もできない）。連鎖への接続はページ順に合わせて、
    // 以降のページ上にある最初のエリアの直前へ挿入する。
    if (writeModeRef.current) {
      const areas = genkoAreaObjs(
        next.spec,
        res.page.slot,
        genko,
        ax,
        margins,
      );
      if (areas.length) {
        content.push(...areas);
        const target =
          chainsRef.current.find((c) => c.id === writeChainId) ??
          chainsRef.current[0];
        if (target) {
          const rects = pageRects(next.spec, res.pages, ax);
          const pageIndexOf = (areaId: string): number => {
            const o = content.find((x) => x.id === areaId);
            if (!o) return -1;
            const cx = o.x + o.w / 2;
            const cy = o.y + o.h / 2;
            const r = rects.find(
              (p) =>
                cx >= p.x && cx < p.x + p.w && cy >= p.y && cy < p.y + p.h,
            );
            return r ? r.index : -1;
          };
          // 表示順 index 以上のページに乗る最初のエリアの直前へ挿入
          const at = target.areas.findIndex(
            (a) => pageIndexOf(a) >= index,
          );
          const at2 = at === -1 ? target.areas.length : at;
          const ids = areas.map((a) => a.id);
          setChains((cs) =>
            cs.map((c) =>
              c.id === target.id
                ? { ...c, areas: [...c.areas.slice(0, at2), ...ids, ...c.areas.slice(at2)] }
                : c,
            ),
          );
        }
      }
    }
    commitPages(next, content);
  };
  const insertBelow = (index: number) => insertAt(index + 1);
  const removeCurrentPage = () => {
    const r = pageRects(model.spec, model.pages, curAxis())[curPage];
    if (r) removePage(r.id);
  };

  // ── ファイル操作（.slm 書庫） ──
  const contentObjects = () =>
    engine.doc.objects.filter((o) => o.kind !== PAGE_KIND);

  // ── Undo/Redo（doc＋連鎖＋ページ＋設定の統合スナップショット） ──
  // オブジェクト座標は常に正準系 'y' で保存 — モードを跨いだ
  // undo/redo でも正しい世界へ復元される
  const makeSnap = (): Snap => ({
    objects: canon(contentObjects()),
    chains,
    model,
    footer,
    title: docTitle,
    pageOpacity,
    paperColor,
    docFont,
    docColor,
    pageNum,
    gridPrint,
    genko,
    gridColor,
    gridAlpha,
    gridBg,
    gridBgAlpha,
    hashira,
    margins,
  });
  const applySnap = (s: Snap) => {
    applyingRef.current = true;
    setModel(s.model);
    engine.setDoc({
      ...engine.doc,
      objects: [
        ...pageObjects(
          s.model,
          s.pageOpacity / 100,
          curAxis(),
          s.paperColor,
        ),
        ...uncanon(s.objects, s.model.spec).map((o) => {
          // v0.9: 復元オブジェクトの塗りを現在の設定へ正規化
          // （旧書庫の枠と新版の枠で背景色がずれるのを防ぐ）
          const d = o.data as TextAreaData | undefined;
          return d?.genko || d?.auto
            ? {
                ...o,
                style: {
                  ...(o.style ?? {}),
                  fill: gridLineCss(
                    s.gridBg ?? DEFAULT_GRID_BG,
                    (s.gridBgAlpha ?? 0) / 100,
                  ),
                },
              }
            : o;
        }),
      ],
    });
    syncSnapExtra(engine, s.model, curAxis());
    setChains(s.chains);
    setFooter(s.footer);
    setDocTitle(s.title);
    setPageOpacity(s.pageOpacity);
    setPaperColor(s.paperColor);
    setDocFont(s.docFont);
    setDocColor(s.docColor);
    setPageNum(s.pageNum);
    setGridPrint(s.gridPrint);
    setGenko(s.genko);
    setGridColor(s.gridColor);
    setGridBg(s.gridBg);
    setGridBgAlpha(s.gridBgAlpha);
    setGridAlpha(s.gridAlpha);
    setHashira(s.hashira);
    setMargins(s.margins);
    snapRef.current = s;
    applyingRef.current = false;
  };
  const undo = () => {
    const h = histRef.current;
    const s = h.past.pop();
    if (!s || !snapRef.current) return;
    h.future.push(snapRef.current);
    applySnap(s);
    setHistTick((t) => t + 1);
  };
  const redo = () => {
    const h = histRef.current;
    const s = h.future.pop();
    if (!s || !snapRef.current) return;
    h.past.push(snapRef.current);
    applySnap(s);
    setHistTick((t) => t + 1);
  };

  // 変更検知 → 500ms の連続編集を1エントリに畳んで履歴へ
  useEffect(() => {
    if (!snapRef.current) {
      snapRef.current = makeSnap();
      return;
    }
    dirtyRef.current = true;
    if (applyingRef.current) return;
    const now = Date.now();
    if (now - histRef.current.last > 500) {
      const h = histRef.current;
      h.past.push(snapRef.current);
      if (h.past.length > 100) h.past.shift();
      h.future = [];
      h.last = now;
      setHistTick((t) => t + 1);
    }
    snapRef.current = makeSnap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.doc.objects, chains, model, footer, docTitle, pageOpacity, docFont, docColor, pageNum, gridPrint, genko, gridColor, gridAlpha, hashira, margins, gridBg, gridBgAlpha, paperColor]);

  // 未保存変更があるときの離脱警告
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // ── v0.3: 起動時の下書き復元 — IndexedDB に自動保存があり、
  // 既定ドキュメントと異なる場合のみ復元する（同一なら何もしない。
  // 確認が済むまで draftReadyRef で自動保存の書込みを止めておく） ──
  useEffect(() => {
    let alive = true;
    void loadDraft().then((rec) => {
      draftReadyRef.current = true;
      if (!alive || !rec) return;
      try {
        const r = unpackArchive(rec.slm);
        const blank = {
          spec: initDoc.model.spec,
          pages: initDoc.model.pages,
          objects: initDoc.objects,
          chains: initDoc.chains,
          footer: false,
          title: '',
          pageOpacity: 75,
          paperColor: '#ffffff',
          docFont: DEFAULT_FONT_FAMILY,
          docColor: '#222222',
          pageNum: true,
          gridPrint: true,
          genko: { ...GENKO_GRID },
          gridColor: DEFAULT_GRID_COLOR,
          gridAlpha: 1,
          gridBg: DEFAULT_GRID_BG,
          gridBgAlpha: 0,
          hashira: '',
          margins: { ...DEFAULT_MARGINS },
        };
        const cur = {
          spec: r.model.spec,
          pages: r.model.pages,
          objects: r.objects,
          chains: r.chains,
          footer: r.footer,
          title: r.title,
          pageOpacity: r.pageOpacity,
          paperColor: r.paperColor,
          docFont: r.docFont ?? DEFAULT_FONT_FAMILY,
          docColor: r.docColor ?? '#222222',
          pageNum: r.pageNum,
          gridPrint: r.gridPrint,
          genko: r.genko ?? { ...GENKO_GRID },
          gridColor: r.gridColor,
          gridAlpha: r.gridAlpha,
          gridBg: r.gridBg,
          gridBgAlpha: r.gridBgAlpha,
          margins: r.margins,
          hashira: r.hashira,
        };
        if (JSON.stringify(blank) === JSON.stringify(cur)) return;
        applyArchive(r);
        setDraftAt(rec.at);
        flash(t('hint.draftRestored'));
      } catch {
        // 壊れた下書きは無視する（復元も削除もしない）
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  // ── v0.3: 自動保存 — 変更のたびに 1.5s デバウンスで .slm と同じ
  // 直列化（画像込みの完全な文書状態）を IndexedDB へ下書き保存する ──
  useEffect(() => {
    if (!draftReadyRef.current) return;
    const id = window.setTimeout(() => {
      try {
        const u8 = packArchive({
          spec: model.spec,
          pages: model.pages,
          objects: canon(contentObjects()),
          chains,
          footer,
          title: docTitle,
          createdAt: createdAtRef.current,
          pageOpacity,
          paperColor,
          docFont,
          docColor,
          pageNum,
          gridPrint,
          genko,
          gridColor,
          gridAlpha,
          gridBg,
          gridBgAlpha,
          hashira,
          margins,
        });
        void saveDraft(u8).then((at) => {
          if (at) setDraftAt(at);
        });
      } catch {
        // 直列化・保存の失敗は静かに諦める（次の変更で再試行される）
      }
    }, 1500);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.doc.objects, chains, model, footer, docTitle, pageOpacity, docFont, docColor, pageNum, gridPrint, genko, gridColor, gridAlpha, hashira, margins, gridBg, gridBgAlpha, paperColor]);

  // v0.4: 執筆モードのホイール横送り — ページは右→左に並ぶので
  // ホイール（deltaY やトラックパッド deltaX）は横パンへ向ける。
  // canvas-wrap の capture で kimetron 側のホイール（ズーム）を
  // 抑止してから処理する。Ctrl/Cmd+ホイールはピンチズームとして通す。
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!writeModeRef.current || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      // 送り方向 = 読み進め方向（wheel 下/トラックパッド左 = 次のページへ
      // = ワールド x 負側が見えるよう content を右へ → viewport.x 増加）
      engine.viewport.x += e.deltaX + e.deltaY;
      engine.panBy(0, 0); // viewport 反映のため emit
    };
    el.addEventListener('wheel', onWheel, {
      capture: true,
      passive: false,
    });
    return () =>
      el.removeEventListener('wheel', onWheel, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  // F24: Alt 押下でスナップ（グリッド＋オブジェクト吸着）を一時解除
  useEffect(() => {
    const set = (off: boolean) => {
      engine.snapObjects = !off;
      engine.doc.grid.snap = !off;
    };
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt') set(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt') set(false);
    };
    const blur = () => set(false); // フォーカス喪失で取り残さない
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // v0.9: 升目マスの背景色 → 升目枠オブジェクトの fill を即時反映
  // （data.genko を持つ枠のみ。手動で色を変えた枠も文書設定へ戻る）
  useEffect(() => {
    const fill = gridLineCss(gridBg, gridBgAlpha);
    engine.setDoc({
      ...engine.doc,
      objects: engine.doc.objects.map((o) => {
        const d = o.data as TextAreaData | undefined;
        return d?.genko || d?.auto
          ? { ...o, style: { ...(o.style ?? {}), fill } }
          : o;
      }),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridBg, gridBgAlpha]);

  // G3: 用紙の透過 → ページ枠オブジェクトの fill を即時反映
  useEffect(() => {
    engine.setDoc({
      ...engine.doc,
      objects: engine.doc.objects.map((o) =>
        o.kind === PAGE_KIND
          ? {
              ...o,
              style: {
                ...(o.style ?? {}),
                fill: gridLineCss(paperColor, pageOpacity / 100),
              },
            }
          : o,
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageOpacity, paperColor]);

  const newDoc = () => {
    if (!window.confirm(t('confirm.new'))) return;
    const d = buildWritingDoc(docFont);
    commitPages(d.model, uncanon(d.objects, d.model.spec));
    setChains(d.chains);
    setWriteChainId(null);
    setFooter(false);
    setDocTitle('');
    setPageOpacity(75);
    setPaperColor('#ffffff');
    setDocFont(DEFAULT_FONT_FAMILY);
    setDocColor('#222222');
    setPageNum(true);
    setGridPrint(true);
    setGenko({ ...GENKO_GRID });
    setGridColor(DEFAULT_GRID_COLOR);
    setGridBg(DEFAULT_GRID_BG);
    setGridBgAlpha(0);
    setGridAlpha(1);
    setHashira('');
    setMargins({ ...DEFAULT_MARGINS });
    createdAtRef.current = new Date().toISOString();
    dirtyRef.current = false;
    engine.setSelection([]);
    focusPage(0, d.model);
  };
  const confirmSave = (name: string) => {
    const u8 = packArchive({
      spec: model.spec,
      pages: model.pages,
      objects: canon(contentObjects()),
      chains,
      footer,
      title: docTitle,
      createdAt: createdAtRef.current,
      pageOpacity,
      paperColor,
      docFont,
      docColor,
      pageNum,
      gridPrint,
      genko,
      gridColor,
      gridAlpha,
      gridBg,
      gridBgAlpha,
      hashira,
      margins,
    });
    const a = document.createElement('a');
    const url = URL.createObjectURL(
      new Blob([u8.buffer as ArrayBuffer], {
        type: 'application/octet-stream',
      }),
    );
    a.href = url;
    a.download = name.endsWith('.slm') ? name : `${name}.slm`;
    a.click();
    URL.revokeObjectURL(url);
    dirtyRef.current = false;
    setSaveDlg(null);
  };
  // 書庫の展開結果をアプリ状態へ反映する（.slm 読込と下書き復元で共用）
  const applyArchive = (r: ReturnType<typeof unpackArchive>) => {
    // 過去バージョンで別グループへ同じ gN が振られて保存された
    // 汚染を修復する — 同名グループをページ単位で分割し連番化
    const prects = pageRects(r.model.spec, r.model.pages);
    const gmap = new Map<string, string>();
    let gn = 0;
    const objects = r.objects.map((o) => {
      if (!o.group) return o;
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      const pi = prects.findIndex(
        (p) =>
          cx >= p.x && cx < p.x + p.w && cy >= p.y && cy < p.y + p.h,
      );
      const key = `${o.group}@${pi}`;
      let g = gmap.get(key);
      if (!g) gmap.set(key, (g = `g${++gn}`));
      return { ...o, group: g };
    });
    groupSeqRef.current = gn + 1;
    // 書庫のオブジェクトは正準系 'y' — 現在のモード軸へ載せ替え、
    // 塗りは復元した設定値で正規化する（v0.9）
    commitPages(
      r.model,
      uncanon(objects, r.model.spec).map((o) => {
        if (o.kind === PAGE_KIND)
          return {
            ...o,
            style: {
              ...(o.style ?? {}),
              fill: gridLineCss(
                r.paperColor ?? '#ffffff',
                (r.pageOpacity ?? 75) / 100,
              ),
            },
          };
        const d = o.data as TextAreaData | undefined;
        return d?.genko || d?.auto
          ? {
              ...o,
              style: {
                ...(o.style ?? {}),
                fill: gridLineCss(
                  r.gridBg ?? DEFAULT_GRID_BG,
                  (r.gridBgAlpha ?? 0) / 100,
                ),
              },
            }
          : o;
      }),
    );
    setChains(r.chains);
    setWriteChainId(null);
    setFooter(r.footer);
    setDocTitle(r.title);
    setPageOpacity(r.pageOpacity);
    setPaperColor(r.paperColor ?? '#ffffff');
    setDocFont(r.docFont ?? DEFAULT_FONT_FAMILY);
    setDocColor(r.docColor ?? '#222222');
    setPageNum(r.pageNum);
    setGridPrint(r.gridPrint);
    // v0.5: 升目仕様 — 旧書庫・不正値は 20×20 既定へ
    setGenko(r.genko ?? { ...GENKO_GRID });
    // v0.6: 升目線の色+濃さ — unpack 側で欠落・不正値は既定へ畳み済み
    setGridColor(r.gridColor);
    setGridAlpha(r.gridAlpha);
    setGridBg(r.gridBg ?? DEFAULT_GRID_BG);
    setGridBgAlpha(r.gridBgAlpha ?? 0);
    // v0.7: 柱 — unpack 側で欠落は空へ畳み済み（空=出さない）
    setHashira(r.hashira);
    setMargins(r.margins ?? { ...DEFAULT_MARGINS });
    createdAtRef.current = r.createdAt || new Date().toISOString();
    dirtyRef.current = false;
    engine.setSelection([]);
    focusPage(0, r.model);
  };
  const onOpenFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!f) return;
    f.arrayBuffer()
      .then((buf) => applyArchive(unpackArchive(new Uint8Array(buf))))
      .catch((err: Error) => flash(tf(t, 'hint.cantOpen', err.message)));
  };

  // 投稿用テキスト出力（v0.3）— 連鎖テキストを .txt で書き出す。
  // ルビは正規形 ｜親字《ヨミ》 のみに揃えるため (- -) 糖衣は正規化する
  // （なろう/カクヨム貼り付け互換 — 糖衣はあくまで入力補助で
  // 提出形は正規形。複数連鎖は空行1行で接続する）
  const exportText = () => {
    const body = chains.map((c) => normalizeRuby(c.text)).join('\n\n');
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const a = document.createElement('a');
    const url = URL.createObjectURL(
      // BOM 付き UTF-8 — Windows のメモ帳等で文字化けしないようにする
      new Blob(['\uFEFF' + body], { type: 'text/plain;charset=utf-8' }),
    );
    a.href = url;
    a.download = `${docTitle || 'document'}-${ymd}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    flash(t('hint.exported'));
  };

  // ── テキストエリア生成（用紙上ダブルクリック） ──
  // B-1: ナビクリック→スクロールでカーソル下にページが来て
  // 2クリック目+ダブルクリック判定がキャンバスへ着弾するのを抑止。
  // ページ切替後の短い間はエリア生成ダブルクリックを無効化する。
  const suppressDblUntil = useRef(0);

  const onDblClick = (e: React.MouseEvent) => {
    // 執筆モードではエリア生成を抑止（レイアウト編集は組版モードで）
    if (writeModeRef.current) return;
    if (performance.now() < suppressDblUntil.current) return;
    if (linkModeRef.current || placingRef.current) return;
    if (engine.mode === 'shape') {
      commitCurve();
      return;
    }
    // ページ枠上のダブルクリックはエリア生成を許可する
    // （ページも data-ki-obj を持つため、コンテンツオブジェクト上のみ除外）
    const hitEl = (e.target as HTMLElement).closest?.(
      '[data-ki-obj],[data-id]',
    ) as HTMLElement | null;
    const hitId = hitEl?.dataset.kiObj ?? hitEl?.dataset.id;
    const r = canvasRef.current!.getBoundingClientRect();
    const domH = hitId
      ? engine.doc.objects.find((x) => x.id === hitId)
      : undefined;
    // .ki-shape は pointer-events:none — ページ着地を避けつつ幾何ヒットへ
    const hitObj =
      (domH && domH.kind !== PAGE_KIND ? domH : undefined) ??
      engine.objectAt({ x: e.clientX - r.left, y: e.clientY - r.top });
    if (hitObj && hitObj.kind !== PAGE_KIND) return;
    const w = engine.screenToWorld({
      x: e.clientX - r.left,
      y: e.clientY - r.top,
    });
    const onPaper = pageRects(model.spec, model.pages, curAxis()).some(
      (p) => w.x >= p.x && w.x < p.x + p.w && w.y >= p.y && w.y < p.y + p.h,
    );
    if (!onPaper) {
      flash(t('hint.onPaper'));
      return;
    }
    const gs = engine.doc.grid.size || 5;
    const id = nextId('ta');
    engine.addObject({
      id,
      kind: TEXT_KIND,
      x: Math.round(w.x / gs) * gs,
      y: Math.round(w.y / gs) * gs,
      w: 60,
      h: 45,
      style: { stroke: 'rgba(90,110,140,0.4)' },
      // 新規エリアの既定は縦書き（旧データの writing 欠落は横扱いのまま）
      data: { ...DEFAULT_TEXT_DATA, fontFamily: docFont, writing: 'vertical-rl' },
    });
    setChains((cs) => [
      ...cs,
      { id: nextId('c'), areas: [id], text: '' },
    ]);
    engine.setSelection([id]);
  };

  // ── リンクモード: 末尾 → 別連鎖の先頭 のみ接続可（線形一方通行） ──
  const pickLink = (areaId: string) => {
    const cs = chainsRef.current;
    const c = chainOf(cs, areaId);
    if (!c) return;
    if (!linkFrom) {
      if (c.areas[c.areas.length - 1] !== areaId) {
        flash(t('hint.linkFrom'));
        return;
      }
      setLinkFrom(areaId);
      return;
    }
    if (linkFrom === areaId) {
      setLinkFrom(null);
      return;
    }
    if (canLink(cs, linkFrom, areaId)) {
      setChains(linkChains(cs, linkFrom, areaId));
      setLinkFrom(null);
      setLinkMode(false);
    } else {
      flash(t('hint.linkTo'));
      if (c.areas[c.areas.length - 1] === areaId) setLinkFrom(areaId);
    }
  };

  const onCanvasClick = (e: React.MouseEvent) => {
    // 画像配置: ゴースト位置にクリック確定
    if (placingRef.current && ghost) {
      const p = placingRef.current;
      const id = nextId('im');
      engine.addObject({
        id,
        kind: IMG_KIND,
        x: ghost.x,
        y: ghost.y,
        w: p.w,
        h: p.h,
        data: { url: p.url, aspect: p.aspect, lock: p.lock } satisfies ImageData,
      });
      setPlacing(null);
      setGhost(null);
      engine.setSelection([id]);
      return;
    }
    const objEl = (e.target as HTMLElement).closest?.(
      '[data-ki-obj],[data-id]',
    ) as HTMLElement | null;
    const objId = objEl?.dataset.kiObj ?? objEl?.dataset.id;
    const cr = canvasRef.current!.getBoundingClientRect();
    const cpt = { x: e.clientX - cr.left, y: e.clientY - cr.top };
    const domO = objId
      ? engine.doc.objects.find((x) => x.id === objId)
      : undefined;
    // .ki-shape は pointer-events:none で DOM を抜け、着地したページ枠が
    // 拾われることがある — ページ以外の DOM 解決 → 幾何ヒット → ページ枠
    const o =
      (domO && domO.kind !== PAGE_KIND ? domO : undefined) ??
      engine.objectAt(cpt) ??
      engine.doc.objects.find((x) => {
        if (x.kind !== PAGE_KIND) return false;
        const w = engine.screenToWorld(cpt);
        return (
          w.x >= x.x && w.x <= x.x + x.w && w.y >= x.y && w.y <= x.y + x.h
        );
      });
    if (linkModeRef.current) {
      if (o?.kind === TEXT_KIND) pickLink(o.id);
      return;
    }
    // F26: グループ — エンジンがクリックで全体選択へ拡張するため、
    // 同一メンバーの連続クリックのみ個別へ潜る（クリックスルー）
    if (!e.shiftKey && o && o.kind !== PAGE_KIND && o.group) {
      const members = engine.doc.objects
        .filter((x) => x.group === o.group)
        .map((x) => x.id);
      const all = members.every((id) => engine.selectedIds.has(id));
      if (
        all &&
        members.length > 1 &&
        lastGroupClickRef.current === o.id
      ) {
        engine.setSelection([o.id]);
      } else {
        engine.setSelection(members);
      }
      lastGroupClickRef.current = o.id;
    } else {
      lastGroupClickRef.current = null;
    }
    // ページ枠クリック → アクティブページを切り替える
    if (o?.kind === PAGE_KIND) {
      const idx = pageRects(model.spec, model.pages, curAxis()).findIndex(
        (p) => p.id === o.id,
      );
      if (idx >= 0) setActivePage(idx);
    }
    setSelLink(null);
  };

  // ── 画像取り込みフロー ──
  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const probe = new Image();
      probe.onload = () => {
        setImgDlg({
          url,
          natW: probe.naturalWidth,
          natH: probe.naturalHeight,
          w: +(probe.naturalWidth / MM_PX).toFixed(1),
          h: +(probe.naturalHeight / MM_PX).toFixed(1),
          lock: true,
        });
      };
      probe.src = url;
    };
    reader.readAsDataURL(f);
  };

  const dlgPatch = (patch: Partial<ImgDlg>) =>
    setImgDlg((d) => {
      if (!d) return d;
      const n = { ...d, ...patch };
      const ratio = d.natH / d.natW;
      if (n.lock && 'w' in patch) n.h = +(n.w * ratio).toFixed(1);
      if (n.lock && 'h' in patch) n.w = +(n.h / ratio).toFixed(1);
      if (n.lock && 'lock' in patch) n.h = +(n.w * ratio).toFixed(1);
      return n;
    });

  // ── オブジェクト属性パッチ ──
  const patchObject = (id: string, patch: Partial<WorldObject>) => {
    engine.setDoc({
      ...engine.doc,
      objects: engine.doc.objects.map((o) =>
        o.id === id ? { ...o, ...patch } : o,
      ),
    });
  };
  const patchAreaData = (id: string, patch: Partial<TextAreaData>) => {
    const o = engine.doc.objects.find((x) => x.id === id);
    if (!o) return;
    patchObject(id, {
      data: { ...DEFAULT_TEXT_DATA, ...(o.data as TextAreaData), ...patch },
    });
  };
  const patchImageData = (id: string, patch: Partial<ImageData>) => {
    const o = engine.doc.objects.find((x) => x.id === id);
    if (!o) return;
    patchObject(id, { data: { ...(o.data as ImageData), ...patch } });
  };

  // ── 文書既定フォントの変更（v0.8）──
  // 「既定フォント」は本文書体の文書レベル設定 — 変更は既存の
  // 執筆テキストへ即時反映し、以後の新規エリア・新ページ枠の
  // 初期値にもなる（docFont 参照）。適用対象の規則:
  //   - data.auto / data.genko を持つ自動生成の執筆枠 — モードを
  //     問わず追従（升目枠は常に本文用の枠）
  //   - 執筆モードでは全テキストエリア — 文書全体が本文。auto 印の
  //     無い旧書庫・下書きのエリアや、組版で手配置したエリアも
  //     執筆モードでは本文の一部として揃える
  // 組版モードで手配置したエリア（auto/genko 印なし）は触らない —
  // エリア単位の書体指定は組版の仕事として残す
  const applyDocFont = (font: string) => {
    setDocFont(font);
    engine.setDoc({
      ...engine.doc,
      objects: engine.doc.objects.map((o) => {
        if (o.kind !== TEXT_KIND) return o;
        const d = o.data as TextAreaData | undefined;
        if (!(d?.auto || d?.genko || writeMode)) return o;
        return {
          ...o,
          data: { ...DEFAULT_TEXT_DATA, ...d, fontFamily: font },
        };
      }),
    });
  };

  // v0.9: 文書既定の文字色 — applyDocFont と同じ伝播規則
  // （auto/genko + 執筆モードの全エリアへ即時反映・.slm へ保存）
  const applyDocColor = (color: string) => {
    setDocColor(color);
    engine.setDoc({
      ...engine.doc,
      objects: engine.doc.objects.map((o) => {
        if (o.kind !== TEXT_KIND) return o;
        const d = o.data as TextAreaData | undefined;
        if (!(d?.auto || d?.genko || writeMode)) return o;
        return {
          ...o,
          data: { ...DEFAULT_TEXT_DATA, ...d, color },
        };
      }),
    });
  };

  // ── F25: 複製・コピー＆ペースト（テキストエリアは対象外） ──
  const groupSeqRef = useRef(1);
  // 既存ドキュメント（書庫由来の gN を含む）と被らない新しいグループID
  const freshGroup = () => {
    const used = new Set(
      engine.doc.objects.map((o) => o.group).filter(Boolean),
    );
    while (used.has(`g${groupSeqRef.current}`)) groupSeqRef.current++;
    return `g${groupSeqRef.current++}`;
  };
  const lastGroupClickRef = useRef<string | null>(null);
  const copyBuf = useRef<WorldObject[]>([]);
  const pasteN = useRef(0);
  const dupSrcs = () =>
    engine.doc.objects.filter(
      (o) =>
        engine.selectedIds.has(o.id) &&
        !o.locked &&
        o.kind !== PAGE_KIND,
    );
  const gridStep = () => (engine.doc.grid.size > 0 ? engine.doc.grid.size : 10);
  const freshIdGen = () => {
    const ids = new Set(engine.doc.objects.map((o) => o.id));
    return (base: string) => {
      let n = 1;
      let id = `${base}-copy`;
      while (ids.has(id)) id = `${base}-copy${++n}`;
      ids.add(id);
      return id;
    };
  };
  const makeClones = (
    srcs: WorldObject[],
    dx: number,
    dy: number,
    gen: (s: string) => string,
  ) => {
    const gmap = new Map<string, string>();
    return srcs.map((o) => {
      let g: string | undefined;
      if (o.group) {
        g = gmap.get(o.group);
        if (!g) {
          g = freshGroup();
          gmap.set(o.group, g);
        }
      }
      return {
        ...o,
        id: gen(o.id),
        x: o.x + dx,
        y: o.y + dy,
        group: g,
        shape: o.shape
          ? { ...o.shape, points: o.shape.points?.map((p) => ({ ...p })) }
          : undefined,
        style: o.style ? { ...o.style } : undefined,
        data: o.data ? JSON.parse(JSON.stringify(o.data)) : undefined,
      };
    });
  };
  const addClones = (copies: WorldObject[], srcs: WorldObject[]) => {
    if (!copies.length) return;
    engine.setDoc({
      ...engine.doc,
      objects: [...engine.doc.objects, ...copies],
    });
    engine.setSelection(copies.map((o) => o.id));
    // テキストエリアはリンクを引き継がず単独連鎖を新設し、フォント
    // 等の設定（data）と元連鎖の全文を引き継ぐ — 収まらない分は
    // あふれバッジで正直に出る
    const taChains: Chain[] = copies
      .map((c, i) => ({ c, s: srcs[i] }))
      .filter(({ c }) => c.kind === TEXT_KIND)
      .map(({ c, s }) => {
        const src = chainOf(chainsRef.current, s.id);
        const text = src ? src.text : (copyText.current.get(s.id) ?? '');
        return { id: nextId('c'), areas: [c.id], text };
      });
    if (taChains.length) setChains((prev) => [...prev, ...taChains]);
  };
  const duplicateSel = () => {
    const srcs = dupSrcs();
    const s = gridStep();
    addClones(makeClones(srcs, s, s, freshIdGen()), srcs);
  };
  const copyText = useRef(new Map<string, string>());
  // OS クリップボード側の残り物（画像等）が貼り付かないよう、
  // アプリ内コピー時はマーカーを書き込んで上書きする
  const CLIP_MARK = 'kusuma-plava:copy';
  const copySel = () => {
    const srcs = dupSrcs();
    copyBuf.current = JSON.parse(JSON.stringify(srcs));
    copyText.current = new Map(
      srcs
        .filter((o) => o.kind === TEXT_KIND)
        .map((o) => {
          const src = chainOf(chainsRef.current, o.id);
          return [o.id, src ? src.text : ''];
        }),
    );
    pasteN.current = 0;
  };
  // N-20: 直近のキャンバスクリック位置（world座標）— ペーストの配置先
  const lastClickRef = useRef<{ x: number; y: number } | null>(null);
  const pasteSel = () => {
    if (!copyBuf.current.length) return;
    const p = lastClickRef.current;
    let dx: number;
    let dy: number;
    if (p) {
      // コピー範囲の左上角をクリック位置へ（グリッド吸着）
      const minX = Math.min(...copyBuf.current.map((o) => o.x));
      const minY = Math.min(...copyBuf.current.map((o) => o.y));
      const gs = gridStep();
      dx = Math.round((p.x - minX) / gs) * gs;
      dy = Math.round((p.y - minY) / gs) * gs;
    } else {
      const s = gridStep() * ++pasteN.current;
      dx = s;
      dy = s;
    }
    addClones(makeClones(copyBuf.current, dx, dy, freshIdGen()), copyBuf.current);
  };

  // ── 執筆/組版モード切替（v0.2）— 執筆へ入るときは進行中の
  // レイアウト操作とキャンバス選択を畳む（機能は消さずゲートだけ） ──
  const onToggleMode = () => {
    const next = !writeMode;
    setWriteMode(next);
    writeModeRef.current = next; // このハンドラ内の focusPage 判定用に先行反映
    localStorage.setItem('kusuma-mode', next ? 'write' : 'layout');
    // 世界座標をモード軸へ載せ替える — ページは同じ slot に留まり、
    // オブジェクトは中心のページローカル位置を保って再配置される
    // （remapRectAxis。紙面上のオブジェクトは往復で厳密に戻る）
    commitPages(
      model,
      remapAxis(
        contentObjects(),
        next ? 'y' : 'x',
        next ? 'x' : 'y',
        model.spec,
      ),
    );
    focusPage(curPage); // モードごとのフィット（執筆=縦 / 組版=全体）へ合わせ直す
    if (next) {
      setLinkMode(false);
      setLinkFrom(null);
      setSelLink(null);
      setCtxMenu(null);
      setShapeTool(null);
      setShapeDrag(null);
      if (engine.mode === 'shape') engine.cancelShapeDraw();
      if (placingRef.current) {
        setPlacing(null);
        setGhost(null);
      }
      engine.setSelection([]);
    }
  };
  const onIndent = (v: boolean) => {
    setIndent(v);
    localStorage.setItem('kusuma-indent', v ? '1' : '0');
  };
  // 連鎖タブの選択 — 執筆ではペイン内状態、組版ではキャンバス選択
  const onPickChain = (id: string) => {
    if (writeModeRef.current) {
      setWriteChainId(id);
      return;
    }
    const c = chainsRef.current.find((x) => x.id === id);
    if (c?.areas[0]) engine.setSelection([c.areas[0]]);
  };

  // ── F26: グルーピング ──
  const groupSelection = () => {
    const g = freshGroup();
    const sel = new Set(engine.selectedIds);
    engine.setDoc({
      ...engine.doc,
      objects: engine.doc.objects.map((o) =>
        sel.has(o.id) && !o.locked && o.kind !== PAGE_KIND
          ? { ...o, group: g }
          : o,
      ),
    });
  };
  const ungroupSelection = () => {
    const sel = new Set(engine.selectedIds);
    engine.setDoc({
      ...engine.doc,
      objects: engine.doc.objects.map((o) =>
        sel.has(o.id) ? { ...o, group: undefined } : o,
      ),
    });
  };

  // ── F27: 曲線の多点入力（kimetron P49 の 'shape' mode） ──
  const commitCurve = () => {
    const o = engine.commitShapeDraw(nextId('sh'), {
      style: { stroke: '#333333', width: MM_PX * 0.5 },
      data: {},
    });
    if (o) setShapeTool(null);
  };

  // ── F29: 整列・分布 ──
  const onAlign = (op: string) => {
    const objs = engine.doc.objects.filter(
      (o) =>
        engine.selectedIds.has(o.id) && !o.locked && o.kind !== PAGE_KIND,
    );
    if (objs.length < 2) return;
    const minX = Math.min(...objs.map((o) => o.x));
    const maxX = Math.max(...objs.map((o) => o.x + o.w));
    const minY = Math.min(...objs.map((o) => o.y));
    const maxY = Math.max(...objs.map((o) => o.y + o.h));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const pos = new Map<string, Partial<WorldObject>>();
    if (op === 'hdist' || op === 'vdist') {
      if (objs.length < 3) return;
      const s = [...objs].sort((a, b) =>
        op === 'hdist'
          ? a.x + a.w / 2 - (b.x + b.w / 2)
          : a.y + a.h / 2 - (b.y + b.h / 2),
      );
      const f0 = s[0];
      const f1 = s[s.length - 1];
      const c0 = op === 'hdist' ? f0.x + f0.w / 2 : f0.y + f0.h / 2;
      const c1 = op === 'hdist' ? f1.x + f1.w / 2 : f1.y + f1.h / 2;
      s.forEach((o, i) => {
        const c = c0 + ((c1 - c0) * i) / (s.length - 1);
        pos.set(o.id, op === 'hdist' ? { x: c - o.w / 2 } : { y: c - o.h / 2 });
      });
    } else {
      const fx: Record<string, (o: WorldObject) => Partial<WorldObject>> = {
        left: () => ({ x: minX }),
        hcenter: (o) => ({ x: cx - o.w / 2 }),
        right: (o) => ({ x: maxX - o.w }),
        top: () => ({ y: minY }),
        vcenter: (o) => ({ y: cy - o.h / 2 }),
        bottom: (o) => ({ y: maxY - o.h }),
      };
      const f = fx[op];
      if (!f) return;
      for (const o of objs) pos.set(o.id, f(o));
    }
    engine.setDoc({
      ...engine.doc,
      objects: engine.doc.objects.map((o) =>
        pos.has(o.id) ? { ...o, ...pos.get(o.id) } : o,
      ),
    });
  };

  // ── 連鎖レイアウト（再描画のたびに貪欲配分） ──
  const objById = new Map(engine.doc.objects.map((o) => [o.id, o]));
  const layouts = new Map<string, LayoutResult>();
  // v0.4: 回しこみ — 障害のある縦書きエリアは layoutVertical の
  // 段×区間割当計画を保持し、描画は計画どおり区間を絶対配置する
  // （CSS writing-mode には障害を教えられないため — 案B。
  // 障害無しのスライスは従来どおり CSS 折返しで描く）
  const vflows = new Map<string, VFlow>();
  for (const c of chains) {
    const boxes: AreaBox[] = [];
    const boxById = new Map<string, AreaBox>();
    for (const id of c.areas) {
      const o = objById.get(id);
      if (!o) continue;
      const r = liveRect(engine, o);
      const d = { ...DEFAULT_TEXT_DATA, ...(o.data as TextAreaData) };
      const box: AreaBox = {
        id,
        width: Math.max(0, r.w - 2 * TEXT_PAD_MM),
        height: Math.max(0, r.h - 2 * TEXT_PAD_MM),
        fontSize: d.fontSize,
        fontFamily: d.fontFamily,
        bold: d.bold,
        italic: d.italic,
        writing: d.writing,
        ...(d.writing === 'vertical-rl'
          ? { obstacles: areaObstacles(engine, o) }
          : {}),
      };
      boxes.push(box);
      boxById.set(id, box);
    }
    const lr = layoutChain(c.text, boxes, measurerRef.current, c.marks);
    layouts.set(c.id, lr);
    for (const sl of lr.slices) {
      const b = boxById.get(sl.areaId);
      if (b?.writing === 'vertical-rl' && b.obstacles?.length) {
        vflows.set(
          sl.areaId,
          layoutVertical(sl.text, {
            ...b,
            marks: c.marks,
            textOffset: sl.offset,
          }),
        );
      }
    }
  }

  // 右ペインの駆動源（選択オブジェクト配列）
  const selObjs = engine.doc.objects.filter((o) =>
    engine.selectedIds.has(o.id),
  );
  const selObj = selObjs.length === 1 ? selObjs[0] : null;
  const selChain = selObj ? (chainOf(chains, selObj.id) ?? null) : null;
  // 執筆モード: 連鎖はキャンバス選択に依らずタブ選択（writeChainId）で
  // 駆動し、未選択なら先頭連鎖へフォールバック（常に執筆ペインが開く）
  const writeChain = writeMode
    ? (chains.find((c) => c.id === writeChainId) ?? chains[0] ?? null)
    : null;
  const dockChain = writeChain ?? selChain;
  // フォント等のエリア設定は連鎖の先頭エリアを代表に使う
  const writeArea = dockChain
    ? (objById.get(dockChain.areas[0]) ?? null)
    : null;

  // ── v0.9: ページの自動管理（執筆モード） ──
  // 連鎖テキストが最終枠からあふれたら自動追加、末尾ページが
  // 「自動升目枠1枚だけ・そのスライスが空」なら自動削除する。
  // 画像等の他オブジェクトがある末尾ページは人の配置なので残す。
  const wcOverflow = writeChain
    ? (layouts.get(writeChain.id)?.overflow ?? '')
    : '';
  const wcEmptyTail = (() => {
    if (!writeMode || !writeChain) return null;
    const prs = pageRects(model.spec, model.pages, curAxis());
    if (prs.length <= 1) return null;
    const last = prs[prs.length - 1];
    const inside = engine.doc.objects.filter(
      (o) =>
        o.kind !== PAGE_KIND &&
        o.x + o.w / 2 >= last.x &&
        o.x + o.w / 2 < last.x + last.w &&
        o.y + o.h / 2 >= last.y &&
        o.y + o.h / 2 < last.y + last.h,
    );
    if (inside.length === 0) return null;
    // v0.6: 段組では末尾ページに段数分の枠が乗る — すべて
    // genko/auto 枠で、かつ全スライスが空（空白のみ・孤児枠
    // も空扱い）なら末尾ページを削る
    const slices = layouts.get(writeChain.id)?.slices;
    const allEmpty = inside.every((o) => {
      const d = o.data as TextAreaData | undefined;
      if (!d?.genko && !d?.auto) return false;
      const sl = slices?.find((s) => s.areaId === o.id);
      return !sl || sl.text.trim() === '';
    });
    return allEmpty ? last.id : null;
  })();
  useEffect(() => {
    // あふれが空白だけなら追加しない — 追加すると空ページを
    // 削る処理と無限ループになる
    if (wcOverflow.length > 0 && wcOverflow.trim() !== '') {
      appendPage();
      return;
    }
    if (wcEmptyTail) removePage(wcEmptyTail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wcOverflow, wcEmptyTail]);

  // ── ページナビ: アクティブページ（枠クリック or ナビで切替） ──
  const axis: StackAxis = writeMode ? 'x' : 'y';
  const rects = pageRects(model.spec, model.pages, axis);
  const curPage = Math.min(activePage, Math.max(0, rects.length - 1));
  // G1+G2: ページが収まる倍率に調整して位置合わせする。
  // 執筆モードは用紙の縦でフィット（画面は用紙高さ基準）—
  // 横は用紙右端をキャンバス右端へ合わせる（縦書きの書き出し＝
  // 右上の書字列が画面右へ来る配置）。横積みでは後のページほど
  // 左へ延びるため、右端合わせがそのまま見開き送りになる。
  // 組版モードは従来通りページ全体が収まる倍率 + 左上合わせ。
  const focusPage = (i: number, mdl: PageModel = model) => {
    suppressDblUntil.current = performance.now() + 700;
    setActivePage(i);
    const el = canvasRef.current;
    const p = pageRects(
      mdl.spec,
      mdl.pages,
      writeModeRef.current ? 'x' : 'y',
    )[i];
    if (!el || !p) return;
    const pad = 30; // ルーラー帯 + 余白(px)
    const zoom = Math.min(
      4,
      Math.max(
        0.1,
        writeModeRef.current
          ? (el.clientHeight - pad * 2) / (p.h * MM_PX)
          : Math.min(
              (el.clientWidth - pad * 2) / (p.w * MM_PX),
              (el.clientHeight - pad * 2) / (p.h * MM_PX),
            ),
      ),
    );
    const u = MM_PX * zoom;
    engine.viewport = {
      ...engine.viewport,
      zoom,
      x: writeModeRef.current
        ? el.clientWidth - pad - (p.x + p.w) * u
        : pad - p.x * u,
      y: pad - p.y * u,
    };
    engine.panBy(0, 0); // viewport 反映のため emit を起こす
  };
  const goToPage = (i: number) => focusPage(i);

  const { spec } = model;
  const z = engine.viewport.zoom;
  // v0.3: 総字数（status.chars・目標進捗で共用）— サロゲート対は1字
  const totalChars = chains.reduce((n, c) => n + [...c.text].length, 0);
  // 「下書き HH:MM」表示用の時刻整形
  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  // ── v0.3: 版面の升目数（「版面 縦N×横N」表示・文書設定で共用） ──
  // 字サイズは執筆エリア（連鎖先頭）のもの。無ければ版面自動生成
  // エリア（data.auto）、それも無ければ文書既定にフォールバック。
  const cellArea =
    writeArea ??
    engine.doc.objects.find(
      (o) => o.kind === TEXT_KIND && (o.data as TextAreaData | undefined)?.auto,
    ) ??
    null;
  const cellFs = cellArea
    ? { ...DEFAULT_TEXT_DATA, ...(cellArea.data as TextAreaData) }.fontSize
    : DEFAULT_TEXT_DATA.fontSize;
  // v0.4: エリア実測の内寸で割る（版面全体ではなく枠そのものの升目）。
  // 内寸 = 矩形 − 四方 TEXT_PAD_MM（fitVertical に渡る箱と同じ）。
  // 段ピッチ = fontSize × (1 + RUBY_LANE_RATIO)。
  const hanmenCells = (() => {
    const pitch = cellFs * (1 + RUBY_LANE_RATIO);
    if (cellArea) {
      const r = liveRect(engine, cellArea);
      const iw = Math.max(0, r.w - 2 * TEXT_PAD_MM);
      const ih = Math.max(0, r.h - 2 * TEXT_PAD_MM);
      return {
        v: Math.max(0, Math.floor((ih + 1e-6) / cellFs)),
        h: Math.max(0, Math.floor((iw + 1e-6) / pitch)),
      };
    }
    // エリア無し — 版面全体の仮想升目（旧表示）
    const { bw, bh } = hanmenBox(spec, margins);
    return {
      v: Math.max(0, Math.floor((bh + 1e-6) / cellFs)),
      h: Math.max(0, Math.floor((bw + 1e-6) / pitch)),
    };
  })();

  // ── v0.5: 升目仕様（縦N字×横N段）の文書設定 ──
  // data.genko を持つ升目枠エリアのうち、旧仕様の中央寄せ枠と
  // 矩形一致しているもの（=ユーザーが動かしていない枠）を新仕様の
  // 枠へ作り直す — 用紙変更時の refitWritingAreas と同じ追従規則。
  // 枠から外れているエリア・genko の無いエリアは触らない。
  const applyGenko = (g: GenkoGrid) => {
    if (
      !Number.isInteger(g.cells) ||
      !Number.isInteger(g.cols) ||
      g.cells < 1 ||
      g.cells > 100 ||
      g.cols < 1 ||
      g.cols > 100
    )
      return;
    setGenko(g);
    const ax = curAxis();
    const rects = pageRects(model.spec, model.pages, ax);
    const eps = 0.01; // mm — refitWritingAreas と同じ許容誤差
    const objects = engine.doc.objects.map((o) => {
      if (o.kind !== TEXT_KIND) return o;
      const d = o.data as TextAreaData | undefined;
      if (!d?.genko) return o;
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      const hit = rects.find(
        (r) => cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h,
      );
      if (!hit) return o;
      const old = genkoFrame(
        model.spec,
        hit.slot,
        d.genko,
        ax,
        margins,
        d.col ?? 0,
      );
      if (
        !old ||
        Math.abs(o.x - old.x) > eps ||
        Math.abs(o.y - old.y) > eps ||
        Math.abs(o.w - old.w) > eps ||
        Math.abs(o.h - old.h) > eps
      )
        return o;
      const f = genkoFrame(
        model.spec,
        hit.slot,
        g,
        ax,
        margins,
        d.col ?? 0,
      );
      if (!f) return o;
      return {
        ...o,
        x: f.x,
        y: f.y,
        w: f.w,
        h: f.h,
        data: { ...d, fontSize: f.fontSize, genko: { ...g } },
      };
    });
    // v0.6: 段数の変更 — 各ページの genko 枠を右→左で col 昇順に
    // 揃え、足りない段は生成・多い段は削除して連鎖を貼り直す
    const n = Math.max(1, Math.min(3, Math.round(g.columns ?? 1)));
    const dropIds = new Set<string>();
    const insertAfter = new Map<string, string[]>();
    for (const r of rects) {
      const onPage = objects
        .filter((o) => {
          if (o.kind !== TEXT_KIND) return false;
          const dd = o.data as TextAreaData | undefined;
          if (!dd?.genko) return false;
          const cx = o.x + o.w / 2;
          const cy = o.y + o.h / 2;
          return (
            cx >= r.x &&
            cx < r.x + r.w &&
            cy >= r.y &&
            cy < r.y + r.h
          );
        })
        .sort((a, b) => b.x - a.x); // 右→左 = col 0..k-1
      if (!onPage.length) continue;
      onPage.forEach((o, i) => {
        if (i < n) return; // 残る段は先の refit で新 rect 済み
        dropIds.add(o.id);
      });
      if (onPage.length < n) {
        const extra = genkoAreaObjs(
          model.spec,
          r.slot,
          g,
          ax,
          margins,
        ).slice(onPage.length);
        objects.push(...extra);
        insertAfter.set(
          onPage[onPage.length - 1].id,
          extra.map((a) => a.id),
        );
      }
    }
    engine.setDoc({
      ...engine.doc,
      objects: objects.filter((o) => !dropIds.has(o.id)),
    });
    setChains((cs) =>
      cs.map((c) => {
        let areas = c.areas.filter((a) => !dropIds.has(a));
        for (const [anchor, ids] of insertAfter) {
          const at = areas.indexOf(anchor);
          if (at !== -1)
            areas = [
              ...areas.slice(0, at + 1),
              ...ids,
              ...areas.slice(at + 1),
            ];
        }
        return { ...c, areas };
      }),
    );
  };

  // v0.9: 版面マージン変更（天地・ノド・小口）— 旧マージンの枠と
  // 一致する升目枠を新マージンで作り直す（applyGenko と同じ追従規則）
  const applyMargins = (m: PageMargins) => {
    const ok = (v: number) => Number.isFinite(v) && v >= 0 && v <= 80;
    if (!ok(m.top) || !ok(m.bottom) || !ok(m.inside) || !ok(m.outside))
      return;
    const prev = margins;
    setMargins(m);
    const ax = curAxis();
    const rects = pageRects(model.spec, model.pages, ax);
    const eps = 0.01;
    const objects = engine.doc.objects.map((o) => {
      if (o.kind !== TEXT_KIND) return o;
      const d = o.data as TextAreaData | undefined;
      if (!d?.genko) return o;
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      const hit = rects.find(
        (r) => cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h,
      );
      if (!hit) return o;
      const old = genkoFrame(
        model.spec,
        hit.slot,
        d.genko,
        ax,
        prev,
        d.col ?? 0,
      );
      if (
        !old ||
        Math.abs(o.x - old.x) > eps ||
        Math.abs(o.y - old.y) > eps ||
        Math.abs(o.w - old.w) > eps ||
        Math.abs(o.h - old.h) > eps
      )
        return o;
      const f = genkoFrame(
        model.spec,
        hit.slot,
        d.genko,
        ax,
        m,
        d.col ?? 0,
      );
      if (!f) return o;
      return {
        ...o,
        x: f.x,
        y: f.y,
        w: f.w,
        h: f.h,
        data: { ...d, fontSize: f.fontSize },
      };
    });
    engine.setDoc({ ...engine.doc, objects });
  };

  // ── v0.3: 「400字詰め」プリセット ──
  // 升目枠の字サイズ（genkoFontSize と同じ計算）:
  //   fs = min(版面高/cells, 版面幅/(cols×(1+RUBY_LANE_RATIO)))
  // min なので拘束する次元がちょうど升目数、もう一方は以下に収まる
  // （A4縦 20×20 なら段ピッチが効いて fs≈5.25mm → 枠内寸 105×168mm）。
  // 極端な値（小さな用紙で <1mm 等）もそのまま適用する —
  // 0以下・非有限のみ抑止。適用先は升目計算と同じ代表エリア
  // （連鎖先頭 → data.auto 順の cellArea）。
  // v0.4: 字サイズだけでなく枠そのものを升目の中央寄せ矩形へ
  // 作り直し、data.genko を立てる（以後は用紙変更へ枠ごと追従）。
  // v0.5: 固定の 20×20 ではなく文書設定の升目仕様（genko state）を
  // 適用する — 既定は 20×20 なので従来の 400字詰と同一結果。
  // エリアが用紙上に無い等で枠を組めない時は字サイズのみ合わせる
  // 旧挙動へ退く。部分書式の fontSize マークは触らずエリア既定のみ
  // 更新 — Inspector サイズ欄と同じ patchAreaData 経路で再レイアウト。
  const fit400fs = genkoFontSize(spec, genko, margins);
  const fit400 = () => {
    if (fit400fs == null || !cellArea) return;
    const cx = cellArea.x + cellArea.w / 2;
    const cy = cellArea.y + cellArea.h / 2;
    const ax = curAxis();
    const hit = pageRects(spec, model.pages, ax).find(
      (r) => cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h,
    );
    const f = hit ? genkoFrame(spec, hit.slot, genko, ax, margins) : null;
    if (f) {
      patchObject(cellArea.id, { x: f.x, y: f.y, w: f.w, h: f.h });
      patchAreaData(cellArea.id, {
        fontSize: f.fontSize,
        genko: { ...genko },
      });
    } else {
      patchAreaData(cellArea.id, { fontSize: fit400fs });
    }
  };

  // ── v0.7: 柱のページローカル配置（mm） ──
  // 天の余白に横書き1行で出す（書籍の柱は横書きが一般的）。
  // 欄の右辺は升目枠の右辺（枠はページ左右中央寄せ →
  // 右辺 = (用紙幅 − 枠幅)/2）。
  // 升目が組めない用紙では版面（HANMEN_MARGIN+PAD の内側）へ畳む。
  // 版面の外側に置く飾りなので fit()/flow の計算には関与しない
  const hashiraRect = (() => {
    const dims = paperDims(spec);
    const fw =
      fit400fs != null
        ? genko.cols * fit400fs * (1 + RUBY_LANE_RATIO) + 2 * TEXT_PAD_MM
        : dims.w - 2 * (HANMEN_MARGIN_MM + TEXT_PAD_MM);
    const fh =
      fit400fs != null
        ? genko.cells * fit400fs + 2 * TEXT_PAD_MM
        : dims.h - 2 * (HANMEN_MARGIN_MM + TEXT_PAD_MM);
    return {
      top: HASHIRA_TOP_MM,
      right: (dims.w - fw) / 2,
      height: Math.max(0, (dims.h - fh) / 2 - HASHIRA_TOP_MM),
      size: HASHIRA_FONT_MM,
    };
  })();

  const renderObject = (o: WorldObject) => {
    if (o.kind === PAGE_KIND) {
      const d = o.data as { index: number };
      return (
        <>
        <div
          className={d.index === curPage ? 'page-tag active nodrag' : 'page-tag nodrag'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <span>
            p.{d.index + 1} — {spec.size}
            {t(spec.landscape ? 'page.landscape' : 'page.portrait')}{' '}
            {Math.round(o.w)}×{Math.round(o.h)}
            mm
          </span>
          {/* v0.9: ページの追加・削除は執筆モードでは自動管理 */}
          {!writeMode && (
            <>
              <button
                title={t('page.insertAfter')}
                onClick={() => insertBelow(d.index)}
              >
                ＋
              </button>
              <button
                title={t('page.delete')}
                onClick={() => removePage(o.id)}
              >
                ×
              </button>
            </>
          )}
        </div>
        {/* v0.3: ページ番号 — 文書設定 ON のとき版面下端中央にも出す
            （印刷側 .pnum と同じ位置・同じ数え方） */}
        {pageNum && (
          <div
            className="pnum-canvas nodrag"
            style={{
              bottom: 4 * MM_PX * z,
              fontSize: Math.max(9, 10 * z),
            }}
          >
            {d.index + 1}
          </div>
        )}
        {/* v0.7: 柱 — 文書設定の文字列があるとき天余白へ縦書きで出す
            （升目枠の右辺揃え・上辺まで。印刷側 .hashira と同じ位置） */}
        {hashira !== '' && (
          <div
            className="hashira-canvas nodrag"
            style={{
              top: hashiraRect.top * MM_PX * z,
              right: hashiraRect.right * MM_PX * z,
              fontSize: Math.max(9, hashiraRect.size * MM_PX * z),
              fontFamily: docFont,
            }}
          >
            {hashira}
          </div>
        )}
      </>
    );
    }
    if (o.kind === TEXT_KIND) {
      const d = { ...DEFAULT_TEXT_DATA, ...(o.data as TextAreaData) };
      const c = chainOf(chains, o.id);
      const lr = c ? layouts.get(c.id) : undefined;
      const sl = lr?.slices.find((s) => s.areaId === o.id);
      const runs = sliceRuns(sl?.text ?? '', c?.marks, sl?.offset ?? 0, {
        fontSize: d.fontSize,
        fontFamily: d.fontFamily,
        color: d.color,
        bold: d.bold,
        italic: d.italic,
        underline: d.underline,
        link: d.link,
      });
      const isLast = c ? c.areas[c.areas.length - 1] === o.id : false;
      const overflow = isLast ? (lr?.overflow ?? '') : '';
      // リンク連鎖（複数エリア）は左上起点固定。単独エリアのみ揃え可
      const alone = !c || c.areas.length === 1;
      const vertical = d.writing === 'vertical-rl';
      // 縦書き: スライス全体を組版単位へ分解（fitVertical と同じ分割で
      // 計測と描画を一致させる）。ラン境界にまたがる単位は先頭ランの
      // 装飾に寄せる（v0.1 の簡約 — ルビを分断しないため）
      const units = vertical ? tokenizeVertical(sl?.text ?? '') : null;
      // v0.4: 障害のある縦書きスライスは段×区間計画で絶対配置する。
      // units の区間割当は計画の u0/u1 が指す（同じトークン化列）
      const vflow = vertical ? vflows.get(o.id) : undefined;
      const rbs = (() => {
        if (!vertical) return null;
        let a = 0;
        return runs.map((r) => {
          const rb = { s: a, e: a + r.text.length, a: r.attrs };
          a += r.text.length;
          return rb;
        });
      })();
      const vStyleOf = (p: number): VStyle => {
        const r = rbs?.find((x) => p < x.e) ?? rbs?.[rbs.length - 1];
        const a = r?.a;
        return {
          css: {
            fontSize: (a?.fontSize ?? d.fontSize) * MM_PX * z,
            fontFamily: a?.fontFamily,
            // リンクは編集画面では遷移させず色+下線で表現
            color: a?.link ? '#1a56c4' : a?.color,
            fontWeight: a?.bold ? 'bold' : undefined,
            fontStyle: a?.italic ? 'italic' : undefined,
            textDecoration:
              a?.underline || a?.link ? 'underline' : undefined,
          },
          title: a?.link,
        };
      };
      const alignStyle = alone
        ? {
            textAlign: d.halign,
            ...(d.valign === 'middle' || d.valign === 'bottom'
              ? {
                  display: 'flex',
                  flexDirection: 'column' as const,
                  justifyContent:
                    d.valign === 'middle' ? 'center' : 'flex-end',
                }
              : {}),
          }
        : undefined;
      const cellPx = d.fontSize * MM_PX * z;
      return (
        <div
          className={`ta${linkFrom === o.id ? ' link-from' : ''}`}
          style={{
            padding: TEXT_PAD_MM * MM_PX * z,
            fontSize: d.fontSize * MM_PX * z,
            lineHeight: LINE_HEIGHT,
            fontFamily: d.fontFamily,
            color: d.color,
            fontWeight: d.bold ? 'bold' : undefined,
            fontStyle: d.italic ? 'italic' : undefined,
            textDecoration: d.underline ? 'underline' : undefined,
          }}
        >
          <div
            className={vertical ? 'ta-slice vt' : 'ta-slice'}
            style={
              vertical
                ? ({
                    '--cell': `${cellPx}px`,
                    '--lane': `${cellPx * RUBY_LANE_RATIO}px`,
                    '--pitch': `${cellPx * (1 + RUBY_LANE_RATIO)}px`,
                    // v0.6: 升目線の色+濃さ（文書設定）— 透過は
                    // 枠線0.45/ルビ欄0.18 の基準濃さへ乗算する
                    '--grid-line': gridLineCss(
                      gridColor,
                      gridAlpha * GRID_CELL_ALPHA,
                    ),
                    '--lane-line': gridLineCss(
                      gridColor,
                      gridAlpha * GRID_LANE_ALPHA,
                    ),
                    ...alignStyle,
                  } as React.CSSProperties)
                : alignStyle
            }
          >
            {vertical
              ? vflow
                ? vflow.segs.map((s, i) => (
                    <div
                      key={i}
                      className="vseg"
                      style={{
                        top: s.y * MM_PX * z,
                        height: s.h * MM_PX * z,
                        right: s.col * vflow.pitch * MM_PX * z,
                        width: vflow.pitch * MM_PX * z,
                      }}
                    >
                      {vunitSpans(units!.slice(s.u0, s.u1), vStyleOf)}
                    </div>
                  ))
                : vunitSpans(units!, vStyleOf)
              : runs.map((r, i) => (
                  <span
                    key={i}
                    title={r.attrs.link}
                    style={{
                      fontSize: r.attrs.fontSize! * MM_PX * z,
                      fontFamily: r.attrs.fontFamily,
                      // リンクは編集画面では遷移させず色+下線で表現
                      color: r.attrs.link ? '#1a56c4' : r.attrs.color,
                      fontWeight: r.attrs.bold ? 'bold' : undefined,
                      fontStyle: r.attrs.italic ? 'italic' : undefined,
                      textDecoration:
                        r.attrs.underline || r.attrs.link
                          ? 'underline'
                          : undefined,
                    }}
                  >
                    {r.text}
                  </span>
                ))}
          </div>
          {overflow.length > 0 && (
            <div
              className="oflabel nodrag"
              title={t('ta.overflowTip')}
              onClick={(e) => {
                e.stopPropagation();
                engine.setSelection([o.id]);
              }}
            >
              {tf(
                t,
                'ta.overflow',
                overflow.length,
                overflow.replace(/\n/g, '⏎').slice(0, 14),
              )}
            </div>
          )}
        </div>
      );
    }
    if (o.kind === IMG_KIND) {
      const d = o.data as ImageData;
      return <img className="img-fill" src={d.url} draggable={false} alt="" />;
    }
    // rect は kimetron 1.4.1 のネイティブ描画（ki-obj の
    // background/border = style 由来）に任せるため中身なし
    if (o.kind === 'rect') return null;
    return undefined;
  };

  const onTheme = (t: Theme) => {
    setTheme(t);
    localStorage.setItem('kusuma-theme', t);
  };

  return (
    <div
      className={writeMode ? 'app mode-write' : 'app'}
      data-theme={theme}
    >
      <div className="body">
        <MenuPane
          collapsed={collapsed}
          onToggle={() => setCollapsed((v) => !v)}
          onNew={newDoc}
          onOpen={() => openFileRef.current?.click()}
          onSave={() => setSaveDlg(docTitle || 'document')}
          onExportText={exportText}
          onUndo={undo}
          onRedo={redo}
          canUndo={histRef.current.past.length > 0}
          canRedo={histRef.current.future.length > 0}
          rulerOn={rulerOn}
          onRuler={() => setRulerOn((v) => !v)}
          onFit={() => focusPage(curPage)}
          linkMode={linkMode}
          onLinkMode={() => {
            setLinkMode((m) => !m);
            setLinkFrom(null);
          }}
          shapeTool={shapeTool}
          onShapeTool={setShapeTool}
          onImage={() => fileRef.current?.click()}
          onAddPage={appendPage}
          onDeletePage={removeCurrentPage}
          onPrint={() => setPrinting(true)}
          theme={theme}
          onTheme={onTheme}
          onLang={() => {
            const next = lang === 'ja' ? 'en' : 'ja';
            setLang(next);
            localStorage.setItem('kusuma-lang', next);
          }}
          lang={lang}
          writeMode={writeMode}
          onMode={onToggleMode}
          t={t}
        />
        <div
          ref={canvasRef}
          className={
            'canvas-wrap' +
            (linkMode ? ' link-mode' : '') +
            (shapeTool ? ' drawing' : '')
          }
          onClick={onCanvasClick}
          onDoubleClick={onDblClick}
          onPointerDown={(e) => {
            // 中ボタンドラッグの既定動作（オートスクロール）を抑止し、
            // kimetron のパン操作だけにする
            if (e.button === 1) e.preventDefault();
            // N-20: ペースト配置先のためクリック位置を world 座標で記憶
            if (e.button === 0) {
              const r = canvasRef.current!.getBoundingClientRect();
              lastClickRef.current = engine.screenToWorld({
                x: e.clientX - r.left,
                y: e.clientY - r.top,
              });
            }
          }}
          onPointerMove={(e) => {
            if (!placingRef.current) return;
            const r = canvasRef.current!.getBoundingClientRect();
            const w = engine.screenToWorld({
              x: e.clientX - r.left,
              y: e.clientY - r.top,
            });
            const gs = engine.doc.grid.size || 5;
            setGhost({
              x: Math.round(w.x / gs) * gs,
              y: Math.round(w.y / gs) * gs,
            });
          }}
          onPointerUp={() => {
            // アスペクト比ロック画像 → リサイズ確定時に補正
            let fix = false;
            const objects = engine.doc.objects.map((o) => {
              if (
                o.kind === IMG_KIND &&
                engine.selectedIds.has(o.id) &&
                (o.data as ImageData).lock
              ) {
                const d = o.data as ImageData;
                const h = o.w * d.aspect;
                if (Math.abs(o.h - h) > 0.05) {
                  fix = true;
                  return { ...o, h };
                }
              }
              return o;
            });
            if (fix) engine.setDoc({ ...engine.doc, objects });
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            // 執筆モードでは Z-order 等のコンテキスト編集を開かない
            if (writeModeRef.current) return;
            if (placingRef.current) {
              setPlacing(null);
              setGhost(null);
              return;
            }
            // ワイヤー右クリック → 切断メニュー
            const g = (e.target as Element).closest?.(
              'g[data-link]',
            ) as SVGGElement | null;
            if (g?.dataset.link) {
              const [chainId, idx] = g.dataset.link.split(':');
              const wire = { chainId, index: +idx };
              setSelLink(wire);
              setCtxMenu({ x: e.clientX, y: e.clientY, wire });
              return;
            }
            const objEl = (e.target as HTMLElement).closest?.(
              '[data-ki-obj],[data-id]',
            ) as HTMLElement | null;
            const id = objEl?.dataset.kiObj ?? objEl?.dataset.id;
            const cr = canvasRef.current!.getBoundingClientRect();
            const domO = id
              ? engine.doc.objects.find((x) => x.id === id)
              : undefined;
            // .ki-shape は pointer-events:none で DOM を抜け、着地した
            // ページ枠が拾われることがある — ページ以外の DOM 解決 →
            // 幾何ヒット（hitFilter でページ除外済み）の順で解決
            const o =
              (domO && domO.kind !== PAGE_KIND ? domO : undefined) ??
              engine.objectAt({
                x: e.clientX - cr.left,
                y: e.clientY - cr.top,
              });
            if (!o) return;
            if (!engine.selectedIds.has(o.id)) {
              engine.setSelection(
                o.group
                  ? engine.doc.objects
                      .filter((x) => x.group === o.group)
                      .map((x) => x.id)
                  : [o.id],
              );
            }
            setCtxMenu({ x: e.clientX, y: e.clientY });
          }}
        >
          <IsleCanvas
            engine={engine}
            style={{ position: 'absolute', inset: 0 }}
            renderObject={renderObject}
          />
          {/* 空ドキュメントの初見ヒント（ページ枠のみの時に表示） */}
          {!engine.doc.objects.some((o) => o.kind !== PAGE_KIND) && (
            <div className="canvas-hint">
              {t(writeMode ? 'canvas.hintWrite' : 'canvas.hint')}
            </div>
          )}
          {/* 執筆モードではリンクワイヤーを出さない（選択も不可） */}
          {!writeMode && (
            <LinkWires
              engine={engine}
              chains={chains}
              selLink={selLink}
              onPick={setSelLink}
            />
          )}
          {shapeTool && shapeTool !== 'curve' && (
            <div
              className="shape-overlay"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                const r = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - r.left;
                const y = e.clientY - r.top;
                setShapeDrag({ x0: x, y0: y, x1: x, y1: y });
              }}
              onPointerMove={(e) => {
                if (!shapeDrag) return;
                const r = e.currentTarget.getBoundingClientRect();
                setShapeDrag({
                  ...shapeDrag,
                  x1: e.clientX - r.left,
                  y1: e.clientY - r.top,
                });
              }}
              onPointerUp={() => {
                if (!shapeDrag) return;
                const a = engine.screenToWorld({
                  x: shapeDrag.x0,
                  y: shapeDrag.y0,
                });
                const b = engine.screenToWorld({
                  x: shapeDrag.x1,
                  y: shapeDrag.y1,
                });
                const gs = engine.doc.grid.size || 5;
                const sn = (v: number) => Math.round(v / gs) * gs;
                const dx = Math.abs(a.x - b.x);
                const dy = Math.abs(a.y - b.y);
                const x = sn(Math.min(a.x, b.x));
                const y = sn(Math.min(a.y, b.y));
                const w = Math.max(1, sn(dx));
                const h = Math.max(shapeTool === 'line' ? 1 : gs, sn(dy));
                const id = nextId('sh');
                // 線の chord — 水平/垂直に潰れたドラッグは対角ではなく
                // 辺中央アンカーの真っ直ぐな線にする（sethera 準拠）。
                // 先頭点 = ドラッグ始点（端子の向きのため保持）
                const fx0 = a.x <= b.x ? 0 : 1;
                const fy0 = a.y <= b.y ? 0 : 1;
                const linePts =
                  sn(dy) === 0
                    ? [
                        { fx: fx0, fy: 0.5 },
                        { fx: 1 - fx0, fy: 0.5 },
                      ]
                    : sn(dx) === 0
                      ? [
                          { fx: 0.5, fy: fy0 },
                          { fx: 0.5, fy: 1 - fy0 },
                        ]
                      : [
                          { fx: fx0, fy: fy0 },
                          { fx: 1 - fx0, fy: 1 - fy0 },
                        ];
                const obj: WorldObject =
                  shapeTool === 'rect'
                    ? {
                        id,
                        kind: 'rect',
                        x,
                        y,
                        w,
                        h,
                        style: {
                          fill: '#3a7bd51f',
                          stroke: '#3a7bd5',
                          width: MM_PX * 0.5,
                        },
                        data: {},
                      }
                    : shapeTool === 'ellipse'
                      ? {
                          id,
                          kind: 'ellipse',
                          x,
                          y,
                          w,
                          h,
                          style: {
                            fill: '#3a7bd51a',
                            stroke: '#3a7bd5',
                            width: MM_PX * 0.5,
                          },
                          data: {},
                        }
                      : {
                          id,
                          kind: 'line',
                          x,
                          y,
                          w,
                          h,
                          shape: { points: linePts },
                          style: { stroke: '#333333', width: MM_PX * 0.5 },
                          data: {},
                        };
                engine.addObject(obj);
                engine.setSelection([id]);
                setShapeDrag(null);
                setShapeTool(null);
              }}
            />
          )}
          {engine.shapeDraw && (
            <svg
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                zIndex: 5,
              }}
            >
              {(() => {
                const g = engine.doc.grid;
                const c = engine.cursorWorld;
                const cur =
                  g.snap && g.size > 0
                    ? {
                        x: Math.round(c.x / g.size) * g.size,
                        y: Math.round(c.y / g.size) * g.size,
                      }
                    : c;
                const pts = [...engine.shapeDraw.pts, cur].map((p) =>
                  engine.worldToScreen(p),
                );
                return (
                  <>
                    <polyline
                      points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
                      fill="none"
                      stroke="#3a7bd5"
                      strokeDasharray="4 3"
                    />
                    {engine.shapeDraw.pts.map((p, i) => {
                      const s = engine.worldToScreen(p);
                      return (
                        <rect
                          key={i}
                          x={s.x - 3}
                          y={s.y - 3}
                          width={6}
                          height={6}
                          fill="#3a7bd5"
                        />
                      );
                    })}
                  </>
                );
              })()}
            </svg>
          )}
          {shapeDrag && (
            <div
              className="shape-preview"
              style={{
                left: Math.min(shapeDrag.x0, shapeDrag.x1),
                top: Math.min(shapeDrag.y0, shapeDrag.y1),
                width: Math.abs(shapeDrag.x1 - shapeDrag.x0),
                height: Math.abs(shapeDrag.y1 - shapeDrag.y0),
              }}
            />
          )}
          {rulerOn && !writeMode && rects[curPage] && (
            <Rulers
              engine={engine}
              page={rects[curPage]}
              cursor={engine.cursorWorld}
            />
          )}
          <PageNav
            current={curPage}
            total={rects.length}
            collapsed={navCollapsed}
            onToggle={() => setNavCollapsed((v) => !v)}
            onGo={goToPage}
            t={t}
          />
          {/* N-19: スクロール（ホイールパン不慣れ対策のフローティングUI）。
              執筆モード（横積み・右→左）では前のページが右側にあるため
              ▶=前へ・◀=次へ の横送りになる */}
          <div className="scroll-nav">
            <button
              title={t('scroll.up')}
              onClick={() => {
                const el = canvasRef.current;
                if (!el) return;
                if (writeModeRef.current) {
                  engine.viewport.x -= el.clientWidth * 0.6;
                } else {
                  engine.viewport.y += el.clientHeight * 0.6;
                }
                engine.panBy(0, 0);
              }}
            >
              {writeMode ? '▶' : '▲'}
            </button>
            <button
              title={t('scroll.down')}
              onClick={() => {
                const el = canvasRef.current;
                if (!el) return;
                if (writeModeRef.current) {
                  engine.viewport.x += el.clientWidth * 0.6;
                } else {
                  engine.viewport.y -= el.clientHeight * 0.6;
                }
                engine.panBy(0, 0);
              }}
            >
              {writeMode ? '◀' : '▼'}
            </button>
          </div>
          {placing && ghost && (
            <div
              className="img-ghost"
              style={{
                left: engine.worldToScreen(ghost).x,
                top: engine.worldToScreen(ghost).y,
                width: placing.w * MM_PX * z,
                height: placing.h * MM_PX * z,
              }}
            >
              <img src={placing.url} draggable={false} alt="" />
            </div>
          )}
        </div>
        <RightDock
          selObjs={selObjs}
          chain={dockChain}
          writeMode={writeMode}
          writeArea={writeArea}
          chains={chains}
          onSelectChain={onPickChain}
          indent={indent}
          onIndent={onIndent}
          goal={goal}
          onGoal={(n) => {
            // 正準値は字数（0 = 未設定）。枚数入力側は ×400 済みで来る
            setGoal(n);
            localStorage.setItem('kusuma-goal', String(n));
          }}
          chainOverflow={
            dockChain ? (layouts.get(dockChain.id)?.overflow ?? '') : ''
          }
          onChainText={(text) =>
            setChains((cs) =>
              cs.map((c) =>
                c.id === dockChain!.id
                  ? {
                      ...c,
                      text,
                      marks: adjustMarksForEdit(c.marks, c.text, text),
                    }
                  : c,
              ),
            )
          }
          onApplyMark={(s, e, attrs) =>
            setChains((cs) =>
              cs.map((c) =>
                c.id === dockChain!.id
                  ? { ...c, marks: applyMark(c.marks, s, e, attrs) }
                  : c,
              ),
            )
          }
          onClearMarks={(s, e) =>
            setChains((cs) =>
              cs.map((c) =>
                c.id === dockChain!.id
                  ? { ...c, marks: clearMarksIn(c.marks, s, e) }
                  : c,
              ),
            )
          }
          onAreaData={(patch) => {
            // v0.9: 執筆モードの文字色は文書既定の文字色として
            // 本文全体へ伝播（applyDocColor — 保存にも載る）
            if (writeMode && patch.color !== undefined) {
              applyDocColor(patch.color);
              return;
            }
            // 執筆モードはキャンバス非選択なので先頭エリアを対象にする
            const o = writeMode ? writeArea : selObj;
            if (o) patchAreaData(o.id, patch);
          }}
          onAreaDataAll={(patch) =>
            selObjs
              .filter((o) => o.kind === TEXT_KIND)
              .forEach((o) => patchAreaData(o.id, patch))
          }
          onRect={(r) => selObj && patchObject(selObj.id, r)}
          onImageData={(patch) => selObj && patchImageData(selObj.id, patch)}
          onStyle={(patch) =>
            selObjs.forEach((o) =>
              patchObject(o.id, { style: { ...o.style, ...patch } }),
            )
          }
          onReorder={(op) => engine.reorderSelected(op)}
          onAlign={onAlign}
          onDeselect={() => engine.setSelection([])}
          collapsed={dockCollapsed}
          onToggleDock={() => setDockCollapsed((v) => !v)}
          onAddArea={() => {
            if (!selObj || !selChain) return;
            const id = nextId('ta');
            const i = selChain.areas.indexOf(selObj.id);
            engine.addObject({
              id,
              kind: TEXT_KIND,
              x: selObj.x,
              y: selObj.y + selObj.h + 5,
              w: selObj.w,
              h: selObj.h,
              style: selObj.style ? { ...selObj.style } : undefined,
              data: selObj.data ? { ...selObj.data } : { ...DEFAULT_TEXT_DATA },
            });
            setChains((cs) =>
              cs.map((c) =>
                c.id === selChain.id
                  ? {
                      ...c,
                      areas: [
                        ...c.areas.slice(0, i + 1),
                        id,
                        ...c.areas.slice(i + 1),
                      ],
                    }
                  : c,
              ),
            );
            engine.setSelection([id]);
          }}
          docProps={{
            title: docTitle,
            onTitle: setDocTitle,
            size: spec.size,
            landscape: spec.landscape,
            pageCount: model.pages.length,
            footer,
            onSize: setSize,
            onLandscape: toggleLandscape,
            onAddPage: appendPage,
            onInsertAfter: insertAt,
            onFooter: setFooter,
            pageOpacity,
            onOpacity: setPageOpacity,
            paperColor,
            onPaperColor: setPaperColor,
            font: docFont,
            onFont: applyDocFont,
            docColor,
            onDocColor: applyDocColor,
            pageNum,
            onPageNum: setPageNum,
            gridPrint,
            onGridPrint: setGridPrint,
            genko,
            onGenko: applyGenko,
            gridColor,
            onGridColor: setGridColor,
            gridAlpha,
            onGridAlpha: setGridAlpha,
            gridBg,
            onGridBg: setGridBg,
            gridBgAlpha,
            onGridBgAlpha: setGridBgAlpha,
            hashira,
            onHashira: setHashira,
            margins,
            onMargins: applyMargins,
            hanmenCells,
            fit400fs: cellArea ? fit400fs : null,
            onFit400: fit400,
          }}
          t={t}
        />
      </div>
      <footer className="status">
        <span className="hint">
          {hint || t(writeMode ? 'hint.write' : 'hint.default')}
        </span>
        <span className="sep" />
        {writeMode && (
          <span>
            {tf(t, 'status.chars', totalChars)}
            {/* v0.3: 目標字数のコンパクト進捗 */}
            {goal > 0 &&
              ` · ${tf(t, 'status.goalPct', Math.round((totalChars / goal) * 100))}`}
          </span>
        )}
        {/* v0.3: 版面に収まる升目数（縦=段あたり字数・横=段数） */}
        {writeMode && (
          <span title={t('status.hanmenTip')}>
            {tf(t, 'status.hanmen', hanmenCells.v, hanmenCells.h)}
          </span>
        )}
        {/* v0.3: 自動保存した下書きの時刻 */}
        {draftAt && (
          <span title={t('status.draftTip')}>
            {tf(t, 'status.draft', fmtTime(draftAt))}
          </span>
        )}
        <span>{tf(t, 'status.pages', model.pages.length)}</span>
        <span>scale {engine.scaleText()}</span>
        <span>
          ({formatLength(engine.cursorWorld.x, 'mm')},{' '}
          {formatLength(engine.cursorWorld.y, 'mm')})
        </span>
      </footer>

      {/* 印刷展開オーバーレイ */}
      {printing && (
        <Printout
          model={model}
          footer={footer}
          pageNum={pageNum}
          gridPrint={gridPrint}
          gridColor={gridColor}
          gridAlpha={gridAlpha}
          hashira={hashira}
          hashiraRect={hashiraRect}
          hashiraFont={docFont}
          objects={canon(engine.doc.objects)}
          sliceRuns={(o) => {
            const c = chainOf(chains, o.id);
            if (!c) return [];
            const lr = layouts.get(c.id);
            const sl = lr?.slices.find((s) => s.areaId === o.id);
            if (!sl) return [];
            const d = { ...DEFAULT_TEXT_DATA, ...(o.data as TextAreaData) };
            return sliceRuns(sl.text, c.marks, sl.offset, {
              fontSize: d.fontSize,
              fontFamily: d.fontFamily,
              color: d.color,
              bold: d.bold,
              italic: d.italic,
              underline: d.underline,
              link: d.link,
            });
          }}
          areaAlone={(o) => {
            const c = chainOf(chains, o.id);
            return !c || c.areas.length === 1;
          }}
          vflowFor={(o) => vflows.get(o.id) ?? null}
          onPrint={() => window.print()}
          onClose={() => setPrinting(false)}
          t={t}
        />
      )}

      {/* 画像取り込みダイアログ */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={onPickFile}
      />
      <input
        ref={openFileRef}
        type="file"
        accept=".slm"
        style={{ display: 'none' }}
        onChange={onOpenFile}
      />
      {imgDlg && (
        <div className="dlg-backdrop">
          <div className="dlg">
            <img className="img-prev" src={imgDlg.url} alt="preview" />
            <div className="row">
              {t('dlg.w')}{' '}
              <input
                type="number"
                step="0.1"
                value={imgDlg.w}
                onChange={(e) => dlgPatch({ w: +e.currentTarget.value })}
              />{' '}
              mm {t('dlg.h')}{' '}
              <input
                type="number"
                step="0.1"
                value={imgDlg.h}
                onChange={(e) => dlgPatch({ h: +e.currentTarget.value })}
              />{' '}
              mm
            </div>
            <div className="row">
              <label>
                <input
                  type="checkbox"
                  checked={imgDlg.lock}
                  onChange={(e) => dlgPatch({ lock: e.currentTarget.checked })}
                />
                {t('img.lock')}
              </label>
            </div>
            <div className="btns">
              <button
                onClick={() => {
                  setPlacing({
                    url: imgDlg.url,
                    w: imgDlg.w,
                    h: imgDlg.h,
                    aspect: imgDlg.h / imgDlg.w,
                    lock: imgDlg.lock,
                  });
                  setImgDlg(null);
                }}
              >
                {t('dlg.place')}
              </button>
              <button onClick={() => setImgDlg(null)}>{t('dlg.cancel')}</button>
            </div>
          </div>
        </div>
      )}

      {/* 右クリック: Z-order メニュー */}
      {ctxMenu && (
        <div
          className="ctx-backdrop"
          onClick={() => setCtxMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtxMenu(null);
          }}
        >
          <div
            className="ctx-menu"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
          >
            {ctxMenu.wire ? (
              <button
                onClick={() => {
                  setChains((cs) =>
                    unlinkAt(cs, ctxMenu.wire!.chainId, ctxMenu.wire!.index, nextId('c')),
                  );
                  setSelLink(null);
                  setCtxMenu(null);
                }}
              >
                {t('ctx.unlink')}
              </button>
            ) : (
              <>
            <button
              onClick={() => {
                engine.reorderSelected('front');
                setCtxMenu(null);
              }}
            >
              {t('z.front')}
            </button>
            <button
              onClick={() => {
                engine.reorderSelected('forward');
                setCtxMenu(null);
              }}
            >
              {t('z.forward')}
            </button>
            <button
              onClick={() => {
                engine.reorderSelected('backward');
                setCtxMenu(null);
              }}
            >
              {t('z.backward')}
            </button>
            <button
              onClick={() => {
                engine.reorderSelected('back');
                setCtxMenu(null);
              }}
            >
              {t('z.back')}
            </button>
            {selObjs.filter((o) => o.kind !== PAGE_KIND && !o.locked)
              .length >= 2 && (
              <button
                onClick={() => {
                  groupSelection();
                  setCtxMenu(null);
                }}
              >
                {t('ctx.group')}
              </button>
            )}
            {selObjs.some((o) => o.group) && (
              <button
                onClick={() => {
                  ungroupSelection();
                  setCtxMenu(null);
                }}
              >
                {t('ctx.ungroup')}
              </button>
            )}
              </>
            )}
          </div>
        </div>
      )}

      {/* 名前を付けて保存ダイアログ */}
      {saveDlg !== null && (
        <div className="dlg-backdrop">
          <div className="dlg">
            <div className="row">
              <label>
                {t('dlg.filename')}{' '}
                <input
                  type="text"
                  value={saveDlg}
                  style={{ width: '180px' }}
                  autoFocus
                  onChange={(e) => setSaveDlg(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmSave(saveDlg);
                  }}
                />
                .slm
              </label>
            </div>
            <div className="btns">
              <button onClick={() => confirmSave(saveDlg)}>
                {t('dlg.save')}
              </button>
              <button onClick={() => setSaveDlg(null)}>{t('dlg.cancel')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
