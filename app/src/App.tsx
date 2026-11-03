import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { unzipSync } from 'fflate';
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
  type KinsokuMode,
  type LayoutResult,
  type PageModel,
  type PaperSize,
  type PaperSpec,
  type StackAxis,
  type TextAttrs,
  type TextMark,
  type VFlow,
} from 'inimbal';
import { About } from './About';
import { RightDock, DocProps } from './Inspector';
import { LinkWires, type LinkSel } from './LinkWires';
import { MenuPane, type ShapeTool, type Theme } from './MenuPane';
import { PageNav } from './PageNav';
import { Printout } from './Printout';
import { Rulers } from './Rulers';
import { makeT, tf, type Lang } from './i18n';
import { ARCHIVE_EXT, packArchive, unpackArchive } from './docio';
import { clearDraft, loadDraft, saveDraft } from './autosave';
import { createCanvasMeasurer } from './measure';
import { vunitSpans, type VStyle } from './vtrender';
import { parseAozora, type AozoraResult } from './aozora';
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
    // v0.9: noWrap の画像は回り込みせずブロック扱い — 縦版は
    // 画像の段範囲を全高で占有（画像下の余白も回しこみ禁止。
    // 本文は画像の左へだけ流れる）、横版は縦帯を全幅で占有し
    // テキストは画像の上下のみ流れる。
    // ※注記由来の「次の段〜画像段数ぶん」の予約は注記から導く
    //   ゾーン障害が担う（layouts 側で付与）— この帯は画像が
    //   次頁へ送られた場合に画像自身の段を塞ぐ役目
    if (o.kind === IMG_KIND && (o.data as ImageData).noWrap) {
      // 縦版の注記枠は注記ゾーンが塞ぐ — 自身の帯は立てない
      // （帯が画像に追従すると 帯→組版→ゾーン→アンカー→帯 と
      // 循環して振動する）。横版は縦帯を全幅で占有
      const ph2 = (o.data as ImageData).placeholder;
      const vert = (self.data as TextAreaData).writing === 'vertical-rl';
      if (vert && ph2) continue;
      out.push(
        vert
          ? { x: q.x - ix, y: 0, w: q.w, h: ih }
          : { x: 0, y: q.y - iy, w: iw, h: q.h },
      );
      continue;
    }
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
  // 縦書きの段組は上段→下段の帯分割 — 帯の高さで字数、
  // 版面幅で段あたり列数が決まる
  const bandH = (bh - (n - 1) * gap) / n;
  const fs = Math.min(bandH / g.cells, bw / (g.cols * (1 + RUBY_LANE_RATIO)));
  return Number.isFinite(fs) && fs > 0 ? fs : null;
}

/** slot ページの升目枠を段数分すべて返す（上段→下段 = col 0..n-1）。
    縦書きの段組は版面箱を水平な帯へ段間 gap で等分し、
    各帯の中央に升目枠を寄せる（文中は帯内で右→左へ流れる） */
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
  const bandH = (bh - (n - 1) * gap) / n;
  return Array.from({ length: n }, (_, col) => {
    // col 0 = 上段 — 版面箱の上から帯を積む（縦書きの段順）
    const cy = p.y + i.t + col * (bandH + gap);
    return {
      x: p.x + i.l + (bw - w) / 2,
      y: cy + (bandH - h) / 2,
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
      // fill は他の枠生成経路（genkoAreaObjs）と同じ既定 —
      // 持たないと P1 だけ塗りの有無がずれる
      style: {
        stroke: 'rgba(90,110,140,0.4)',
        fill: gridLineCss(DEFAULT_GRID_BG, 0),
      },
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

/** 画像注記の配置サイズ（mm）— 注記の横×縦(px)は 96dpi 実寸へ換算、
    サイズ省略は版面幅の60%・高さは幅の75%。版面に収まらない指定は
    収まる比率で縮小する。ゾーン計算・空枠生成・判型変更の
    再フィットで同じ基準を使う（ズレの元を一本化） */
function noteImgSize(
  img: { w: number; h: number },
  bw: number,
  bh: number,
): { w: number; h: number } {
  let w = img.w > 0 ? img.w / MM_PX : bw * 0.6;
  let h = img.h > 0 ? img.h / MM_PX : w * 0.75;
  const sc = Math.min(1, bw / w, bh / h);
  w *= sc;
  h *= sc;
  return { w, h };
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
    矩形（属するページは升目枠は中心点、旧来は矩形一致で判定）。
    v0.10: aozora を渡すと注記由来の画像枠（data.placeholder）も
    追従する — ゾーンは版面変更で再計算されるが、枠の w/h が
    旧版面基準のままだと新ゾーンと食い違うため、注記サイズから
    同じ規則（noteImgSize）で再導出する。手置きの画像は触らない。 */
function refitWritingAreas(
  objects: WorldObject[],
  prev: PageModel,
  next: PageModel,
  axis: StackAxis = 'y',
  margins: PageMargins = DEFAULT_MARGINS,
  aozora?: Map<string, AozoraResult>,
): WorldObject[] {
  const eps = 0.01; // mm — 浮動小数の計算誤差を許容
  const prevRects = pageRects(prev.spec, prev.pages, axis);
  // 連鎖ごとの注記由来画像枠を pos 順に並べ、注記 index を引く
  // （空枠同期エフェクトと同じ index 対応規則）
  const phFrames = new Map<string, WorldObject[]>();
  if (aozora) {
    for (const o of objects) {
      const d = o.data as ImageData | undefined;
      if (o.kind !== IMG_KIND || !d?.placeholder?.chain) continue;
      const l = phFrames.get(d.placeholder.chain) ?? [];
      l.push(o);
      phFrames.set(d.placeholder.chain, l);
    }
    for (const l of phFrames.values())
      l.sort(
        (a, b) =>
          (a.data as ImageData).placeholder!.pos -
          (b.data as ImageData).placeholder!.pos,
      );
  }
  return objects.map((o) => {
    if (o.kind === IMG_KIND) {
      const d = o.data as ImageData | undefined;
      const ph = d?.placeholder;
      if (!ph?.chain || !aozora) return o;
      const img =
        aozora.get(ph.chain)?.images[
          phFrames.get(ph.chain)?.indexOf(o) ?? -1
        ];
      if (!img) return o;
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      const hit = prevRects.find(
        (r) => cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h,
      );
      if (!hit) return o;
      const p = pageRectAt(next.spec, hit.slot, axis);
      const ni = marginInsets(margins, hit.slot);
      const s = noteImgSize(img, p.w - ni.l - ni.r, p.h - ni.t - ni.b);
      // 充填済みは自然アスペクトを保つ（幅だけ版面へ再フィット）
      const h = d!.url ? s.w * (d!.aspect || s.h / s.w) : s.h;
      return {
        ...o,
        w: s.w,
        h,
        data: { ...d!, aspect: d!.url ? d!.aspect : h / s.w },
      };
    }
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
  // v0.11: About オーバーレイ
  const [aboutOpen, setAboutOpen] = useState(false);
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
  // v0.11: 右側メニュー — 頁ナビ・章・文書設定を右端レールの
  // フロートパネルへ折りたためる（入力欄を広く使うため）
  const [sidePanel, setSidePanel] = useState<
    'nav' | 'chap' | 'doc' | null
  >('nav');
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
  // v0.6: 見開き表示 — 組版モードでのみ有効な第3の積み軸。
  // 偶数スロット=左・奇数=右（右綴じ）、slot0 は右単独
  const [spread, setSpread] = useState(false);
  // 執筆モードでの連鎖選択（キャンバス選択とは独立）
  const [writeChainId, setWriteChainId] = useState<string | null>(null);
  // 字下げ — Enter 入力時に段落頭の全角スペースを自動挿入（既定ON）
  const [indent, setIndent] = useState(
    () => localStorage.getItem('kusuma-indent') !== '0',
  );
  // v0.3: ページ番号（ノンブル）— 文書設定。書庫の doc.json へ保存。
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
  // v0.10: 空行を畳む — 文書設定。ソースの空行（\n\n 連続）を組版から
  // 除く（青空本文の見栄え用空行の抑制。既定OFF = 1空行=1空段の仕様）
  const [collapseNl, setCollapseNl] = useState(false);
  // v0.12: 禁則処理 — 文書設定。'oidashi'=分割点前倒し（既定・升目原稿
  // 向き）/ 'burasage'=句読点を区間規定字に1字はみ出す（書籍組版向き）。
  // doc.json の kinsoku へ保存（文書ごとに切替可）
  const [kinsoku, setKinsoku] = useState<KinsokuMode>('oidashi');
  // v0.3: 目標字数 — アプリ設定（文書ではなく環境の好み）として
  // localStorage へ。正準値は字数（枚数入力は ×400 で畳み込む）
  const [goal, setGoal] = useState(
    () => +(localStorage.getItem('kusuma-goal') ?? 0) || 0,
  );
  // v0.3: 自動保存した下書きの時刻（「下書き HH:MM」表示用）
  const [draftAt, setDraftAt] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // v0.11: 下書き fingerprint — createdAt+タイトルの文書識別子。
  // 下書きへ併記しておき、復元時に「最後に開いていた文書」の
  // fp（localStorage）と照合 — 別文書の下書きを誤復元しない
  // （書庫・新規への切替直後に古い下書きが蘇るケースの抑止）
  const docFp = (createdAt: string, title: string) =>
    `${createdAt}\n${title}`;
  const stampDocFp = (createdAt: string, title: string) =>
    localStorage.setItem('kusuma-docfp', docFp(createdAt, title));
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
    collapseNl: boolean;
    kinsoku: KinsokuMode;
    goal: number;
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
  const textFileRef = useRef<HTMLInputElement>(null);
  // v0.9: 青空文庫 ZIP 読込 — 同梱画像を basename → dataURL で保持し、
  // 注記 file と一致する未割当空枠へ自動充填する
  const aozoraZipRef = useRef<HTMLInputElement>(null);
  const aozoraImgRef = useRef(new Map<string, string>());
  const aozoraImgBusy = useRef(new Set<string>());
  const chainsRef = useRef(chains);
  chainsRef.current = chains;
  const linkModeRef = useRef(linkMode);
  linkModeRef.current = linkMode;
  const writeModeRef = useRef(writeMode);
  writeModeRef.current = writeMode;
  const spreadRef = useRef(spread);
  spreadRef.current = spread;
  const placingRef = useRef(placing);
  placingRef.current = placing;
  // setTimeout 内で最新の model を参照する（自動頁追加の競合対策）
  const modelRef = useRef(model);
  modelRef.current = model;
  const measurerRef = useRef(createCanvasMeasurer());
  // v0.7: ページビューア — 一度だけ bind されるホイール/リサイズ
  // ハンドラが最新の現ページ・focusPage を参照するための ref
  const curPageRef = useRef(0);
  const focusPageRef = useRef<(i: number) => void>(() => {});
  const wheelAcc = useRef(0);
  const wheelAt = useRef(0);

  // ── 積み軸（v0.4）— ページは同じ PageModel を2つの世界座標系で解釈する:
  //   'y' = 組版モードの縦積み（従来）、'x' = 執筆モードの右→左横積み。
  // エンジンの doc オブジェクトは常に「現在のモード軸」の座標で保持し、
  // モード切替時に remapAxis で全オブジェクトを載せ替える。
  // 書庫・履歴スナップ・下書き・印刷展開は常に正準系 'y' — 境界で
  // canon/uncanon が変換する（往復変換は紙面上のオブジェクトで厳密）。
  const curAxis = (): StackAxis =>
    writeModeRef.current ? 'x' : spreadRef.current ? 'spread' : 'y';
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
    // （レイアウト編集は組版モード側の仕事 — 執筆ペインは別駆動）。
    // 例外: 画像は執筆モードでも触れる（v0.9 — 挿絵の差し込み・
    // 移動・リサイズ・削除を執筆中に行えるようにする）
    engine.hitFilter = (o) =>
      o.kind !== PAGE_KIND &&
      !linkModeRef.current &&
      (!writeModeRef.current || o.kind === IMG_KIND);
    engine.marqueeFilter = (o) =>
      o.kind !== PAGE_KIND &&
      !linkModeRef.current &&
      (!writeModeRef.current || o.kind === IMG_KIND);
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
        setAboutOpen(false);
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
      // ワイヤー切断は組版モード専用。オブジェクト削除は hitFilter が
      // 許すものだけ — 執筆モードでは画像のみ選択可能なので
      // 画像の削除は執筆中でも有効（v0.9）
      if (selLink) {
        if (writeModeRef.current) return;
        setChains((cs) =>
          unlinkAt(cs, selLink.chainId, selLink.index, nextId('c')),
        );
        setSelLink(null);
      } else {
        // 注記と対応付いた画像は注記も除去（残すと空枠が復活する）
        removeLinkedNotes(
          engine.doc.objects.filter(
            (o) =>
              engine.selectedIds.has(o.id) &&
              o.kind === IMG_KIND &&
              !!(o.data as ImageData).placeholder?.chain,
          ),
        );
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
      // 外部テキストのネイティブ貼り付けは入力欄へ通す — ただし
      // 画像は入力欄へ入れられないため、画像を含む場合は常に
      // オブジェクト化する（執筆モードで textarea にフォーカスが
      // 残っていても画像貼り付けが飲み込まれないようにする）
      const items = e.clipboardData?.items;
      const imgItem = items
        ? [...items].find((it) => it.type.startsWith('image/'))
        : undefined;
      if (editable && !imgItem) return;
      if (!imgItem) return;
      const file = imgItem.getAsFile();
      if (!file) return;
      e.preventDefault();
      const rd = new FileReader();
      rd.onload = () => {
        const url = rd.result as string;
        const img = new Image();
        img.onload = () => {
          const aspect = img.naturalHeight / img.naturalWidth;
          // v0.9: 選択中の空枠があれば新規生成ではなく枠へ充填
          const ph = selectedPlaceholder();
          if (ph) {
            fillPlaceholder(ph, url, aspect);
            return;
          }
          if (writeModeRef.current) {
            // 執筆モード: クリック位置が空枠上ならその枠へ充填。
            // それ以外はゴースト追従 → クリックで配置位置を決める
            const p = lastClickRef.current;
            const under =
              p &&
              engine.doc.objects.find(
                (o) =>
                  o.kind === IMG_KIND &&
                  !!(o.data as ImageData).placeholder &&
                  !(o.data as ImageData).url &&
                  p.x >= o.x &&
                  p.x < o.x + o.w &&
                  p.y >= o.y &&
                  p.y < o.y + o.h,
              );
            if (under) {
              fillPlaceholder(under, url, aspect);
              return;
            }
            const w = Math.min(100, img.naturalWidth / MM_PX);
            setPlacing({ url, w, h: w * aspect, aspect, lock: true });
            return;
          }
          const w = Math.min(100, img.naturalWidth / MM_PX);
          const p = lastClickRef.current ?? { x: 30, y: 30 };
          const under = placeholderAt(p);
          if (under) {
            fillPlaceholder(under, url, aspect);
            return;
          }
          const id = nextId('im');
          const s = snapToAreaEdge({ x: p.x, y: p.y, w, h: w * aspect });
          engine.addObject({
            id,
            kind: IMG_KIND,
            x: s.x,
            y: s.y,
            w: s.w,
            h: s.h,
            data: { url, aspect, lock: true } satisfies ImageData,
          });
          engine.setSelection([id]);
          linkImageNote(id);
        };
        img.src = url;
      };
      rd.readAsDataURL(file);
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
  // v0.6: slot ページの段組升目枠を上→下（col 0..n-1）で生成
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
        fill: gridLineCss(gridBg, gridBgAlpha / 100),
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
      refitWritingAreas(
        contentObjects(),
        model,
        next,
        curAxis(),
        margins,
        aozora,
      ),
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
      // ページ枠オブジェクトはすべて commitPages が作り直す —
      // 残すと旧枠+新枠で id(p1,p2…) が重複する
      if (o.kind === PAGE_KIND) return false;
      if (!pr) return true;
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      const hit =
        cx >= pr.x &&
        cx < pr.x + pr.w &&
        cy >= pr.y &&
        cy < pr.y + pr.h;
      if (!hit) return true;
      inside.add(o.id);
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

  // ── ファイル操作（書庫ファイル） ──
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
    collapseNl,
    kinsoku,
    goal,
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
    setCollapseNl(s.collapseNl);
    setKinsoku(s.kinsoku);
    setGoal(s.goal);
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
  }, [engine.doc.objects, chains, model, footer, docTitle, pageOpacity, docFont, docColor, pageNum, gridPrint, genko, gridColor, gridAlpha, hashira, margins, gridBg, gridBgAlpha, paperColor, collapseNl, kinsoku, goal]);

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
      // v0.11: 別文書の下書きは復元しない — 最後に開いていた
      // 文書の fp と不一致ならスキップ（両方無い旧形式は従来どおり）
      const lastFp = localStorage.getItem('kusuma-docfp');
      if (rec.fp && lastFp && rec.fp !== lastFp) return;
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
          collapseNl: false,
          kinsoku: 'oidashi' as const,
          goal: 0,
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
          collapseNl: r.collapseNl,
          kinsoku: r.kinsoku,
          goal: r.goal,
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

  // ── v0.3: 自動保存 — 変更のたびに 1.5s デバウンスで書庫と同じ
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
          collapseNl,
          kinsoku,
          goal,
        });
        const fp = docFp(createdAtRef.current, docTitle);
        void saveDraft(u8, fp).then((at) => {
          if (at) setDraftAt(at);
        });
        stampDocFp(createdAtRef.current, docTitle);
      } catch {
        // 直列化・保存の失敗は静かに諦める（次の変更で再試行される）
      }
    }, 1500);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.doc.objects, chains, model, footer, docTitle, pageOpacity, docFont, docColor, pageNum, gridPrint, genko, gridColor, gridAlpha, hashira, margins, gridBg, gridBgAlpha, paperColor, collapseNl, kinsoku, goal]);

  // v0.7: 執筆モードのホイール = ページめくり — ページビューア化で
  // 可変ズームと自由パンを廃止したため、ホイール送りは現ページ±1へ
  // 進退するだけ。小刻みな delta（トラックパッド）は累積して閾値で
  // 1ページ進退し、逆方向や間が空いた送りでは累積を捨てる。
  // Ctrl+ホイール（ピンチ）を含め kimetron 側へは一切渡さない
  // （capture で抑止）。中ボタンドラッグのパンも同様に潰す
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!writeModeRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) return;
      const d = e.deltaX + e.deltaY;
      if (d === 0) return;
      const now = performance.now();
      if (
        now - wheelAt.current > 400 ||
        Math.sign(d) !== Math.sign(wheelAcc.current)
      )
        wheelAcc.current = 0;
      wheelAt.current = now;
      wheelAcc.current += d;
      if (Math.abs(wheelAcc.current) >= 80) {
        const step = d > 0 ? 1 : -1;
        wheelAcc.current = 0;
        focusPageRef.current(curPageRef.current + step);
      }
    };
    const onMid = (e: PointerEvent) => {
      if (writeModeRef.current && e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    el.addEventListener('wheel', onWheel, {
      capture: true,
      passive: false,
    });
    el.addEventListener('pointerdown', onMid, { capture: true });
    return () => {
      el.removeEventListener('wheel', onWheel, { capture: true });
      el.removeEventListener('pointerdown', onMid, { capture: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  // v0.7: ページ高さ=ウィンドウ高さの固定表示 — リサイズで再フィット
  // する（執筆モードのみ。組版は従来の手動フィットのまま）
  useEffect(() => {
    const onResize = () => {
      if (writeModeRef.current) focusPageRef.current(curPageRef.current);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    const fill = gridLineCss(gridBg, gridBgAlpha / 100);
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
    const d = buildWritingDoc(DEFAULT_FONT_FAMILY);
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
    setCollapseNl(false);
    setKinsoku('oidashi');
    createdAtRef.current = new Date().toISOString();
    // v0.11: 文書が切り替わった時点で fp を更新 — 旧文書の
    // 下書きが残っていても次回起動で誤復元しない
    stampDocFp(createdAtRef.current, '');
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
      collapseNl,
      kinsoku,
      goal,
    });
    const a = document.createElement('a');
    const url = URL.createObjectURL(
      new Blob([u8.buffer as ArrayBuffer], {
        type: 'application/octet-stream',
      }),
    );
    a.href = url;
    a.download = name.endsWith(ARCHIVE_EXT)
      ? name
      : `${name}${ARCHIVE_EXT}`;
    a.click();
    URL.revokeObjectURL(url);
    dirtyRef.current = false;
    setSaveDlg(null);
  };
  // 書庫の展開結果をアプリ状態へ反映する（書庫読込と下書き復元で共用）
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
    // 旧書庫・下書きに残る \r を正規化（textarea は LF 前提）
    setChains(
      r.chains.map((c) => ({ ...c, text: c.text.replace(/\r\n?/g, '\n') })),
    );
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
    setCollapseNl(r.collapseNl === true);
    setKinsoku(r.kinsoku);
    setGoal(r.goal);
    createdAtRef.current = r.createdAt || new Date().toISOString();
    // v0.11: 下書き fingerprint を開いた文書へ更新（下書き復元
    // 経路でも同一 fp になるため二重書きは害なし）
    stampDocFp(createdAtRef.current, r.title);
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
      const under = placeholderAt(ghost);
      setPlacing(null);
      setGhost(null);
      // ドロップ点が未割当の空枠内なら新規生成ではなくその枠へ充填
      if (under) {
        fillPlaceholder(under, p.url, p.aspect);
        return;
      }
      const id = nextId('im');
      const s = snapToAreaEdge({ x: ghost.x, y: ghost.y, w: p.w, h: p.h });
      engine.addObject({
        id,
        kind: IMG_KIND,
        x: s.x,
        y: s.y,
        w: s.w,
        h: s.h,
        data: { url: p.url, aspect: p.aspect, lock: p.lock } satisfies ImageData,
      });
      engine.setSelection([id]);
      linkImageNote(id);
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
    // （執筆モードではそのページへ移動 = ナビと同じ扱い）
    if (o?.kind === PAGE_KIND) {
      const idx = pageRects(model.spec, model.pages, curAxis()).findIndex(
        (p) => p.id === o.id,
      );
      if (idx >= 0) {
        if (writeModeRef.current) focusPage(idx);
        else setActivePage(idx);
      }
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
        const aspect = probe.naturalHeight / probe.naturalWidth;
        // v0.9: 選択中の空枠があればダイアログ・配置操作を
        // 飛ばしてその枠へ直接充填する
        const ph = selectedPlaceholder();
        if (ph) {
          fillPlaceholder(ph, url, aspect);
          return;
        }
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

  // v0.9: 選択中の空枠（青空画像注記のプレースホルダ）— 画像の
  // 貼り付け・ファイル読込は新規オブジェクト生成ではなく
  // この枠への充填へ分岐する
  const selectedPlaceholder = () =>
    [...engine.selectedIds]
      .map((sid) => engine.doc.objects.find((x) => x.id === sid))
      .find(
        (x): x is WorldObject =>
          !!x &&
          x.kind === IMG_KIND &&
          !!(x.data as ImageData).placeholder &&
          !(x.data as ImageData).url,
      );
  // 空枠へ画像を充填 — 幅は注記由来の枠のまま、高さは実画像の
  // アスペクトへ合わせ直す（placeholder は出自情報として残す）
  const fillPlaceholder = (ph: WorldObject, url: string, aspect: number) => {
    patchObject(ph.id, {
      h: ph.w * aspect,
      data: { ...(ph.data as ImageData), url, aspect, lock: true },
    });
  };
  // 座標上の未割当空枠 — 貼り付け・配置ドロップの充填先判定
  const placeholderAt = (p: { x: number; y: number }) =>
    engine.doc.objects.find(
      (o) =>
        o.kind === IMG_KIND &&
        !!(o.data as ImageData).placeholder &&
        !(o.data as ImageData).url &&
        p.x >= o.x &&
        p.x < o.x + o.w &&
        p.y >= o.y &&
        p.y < o.y + o.h,
    );

  // 手動差し込みは版面の一番上/一番下へ吸着（青空のまわりこみ
  // 規則 — 以降の文章が画像の下へ回り込む形に揃える）。
  // ドロップ中心がエリア上側なら上端・下側なら下端、横位置は
  // ドロップ点。エリア外ドロップは自由位置のまま
  const snapToAreaEdge = (r: {
    x: number;
    y: number;
    w: number;
    h: number;
  }) => {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const a = engine.doc.objects.find(
      (o) =>
        o.kind === TEXT_KIND &&
        cx >= o.x &&
        cx < o.x + o.w &&
        cy >= o.y &&
        cy < o.y + o.h,
    );
    if (!a) return r;
    // 升目枠の端へ詰める（内側パディングは残さない）
    const ix = a.x;
    const iy = a.y;
    const iw = a.w;
    const ih = a.h;
    return {
      x: Math.max(ix, Math.min(r.x, ix + iw - r.w)),
      y:
        cy < iy + ih / 2
          ? iy
          : Math.max(iy, iy + ih - r.h),
      w: r.w,
      h: r.h,
    };
  };

  // 新規配置の画像を青空注記と対応付ける — 画像中心が乗る
  // テキストエリアの連鎖テキストへ、画像位置に最も近い行境界へ
  // 独立行で ［＃挿絵（file、横W×縦H）入る］ を挿入し、画像に
  // placeholder を付ける（空枠同期が別枠を生成しないための印）
  const linkImageNote = (imgId: string) => {
    const img = engine.doc.objects.find((o) => o.id === imgId);
    if (!img) return;
    const cx = img.x + img.w / 2;
    const cy = img.y + img.h / 2;
    const areaObj = engine.doc.objects.find(
      (o) =>
        o.kind === TEXT_KIND &&
        cx >= o.x &&
        cx < o.x + o.w &&
        cy >= o.y &&
        cy < o.y + o.h,
    );
    if (!areaObj) return;
    const c = chainOf(chainsRef.current, areaObj.id);
    const pz = c && aozora.get(c.id);
    const sl =
      c && layouts.get(c.id)?.slices.find((s) => s.areaId === areaObj.id);
    if (!c || !pz || !sl) return;
    const d = { ...DEFAULT_TEXT_DATA, ...(areaObj.data as TextAreaData) };
    const ix = areaObj.x + TEXT_PAD_MM;
    const iy = areaObj.y + TEXT_PAD_MM;
    const iw = Math.max(0, areaObj.w - 2 * TEXT_PAD_MM);
    const ih = Math.max(0, areaObj.h - 2 * TEXT_PAD_MM);
    // 画像位置 → スライス内の推定オフセット（縦:段×字・横:行×字の近似）
    let est: number;
    if (d.writing === 'vertical-rl') {
      const perCol = Math.max(1, Math.floor(ih / d.fontSize));
      const col = Math.max(
        0,
        Math.floor((ix + iw - cx) / (d.fontSize * (1 + RUBY_LANE_RATIO))),
      );
      est = col * perCol + Math.max(0, Math.floor((cy - iy) / d.fontSize));
    } else {
      const perLine = Math.max(1, Math.floor(iw / d.fontSize));
      est =
        Math.floor((cy - iy) / (d.fontSize * LINE_HEIGHT)) * perLine;
    }
    const target = sl.offset + Math.max(0, Math.min(sl.text.length, est));
    // 最も近い行境界へ吸着（注記は独立行にするため）
    const back = pz.text.lastIndexOf('\n', target);
    const fwd = pz.text.indexOf('\n', target);
    const bs = back < 0 ? 0 : back + 1;
    const fs = fwd < 0 ? pz.text.length : fwd + 1;
    const bound = target - bs <= fs - target ? bs : fs;
    const rawPos = pz.toRaw(bound);
    const m = /^data:image\/(\w+)/.exec((img.data as ImageData).url);
    const file = `image.${(m?.[1] ?? 'png').replace('jpeg', 'jpg')}`;
    const note = `［＃挿絵（${file}、横${Math.round(img.w * MM_PX)}×縦${Math.round(img.h * MM_PX)}）入る］`;
    const pre = rawPos > 0 && c.text[rawPos - 1] !== '\n' ? '\n' : '';
    const post =
      rawPos < c.text.length && c.text[rawPos] !== '\n' ? '\n' : '';
    setChains((cs) =>
      cs.map((x) =>
        x.id === c.id
          ? {
              ...x,
              text:
                x.text.slice(0, rawPos) +
                pre +
                note +
                post +
                x.text.slice(rawPos),
            }
          : x,
      ),
    );
    patchObject(img.id, {
      data: {
        ...(img.data as ImageData),
        placeholder: { alt: '挿絵', file, chain: c.id, pos: bound },
      },
    });
  };

  // 注記と対応付いた画像の削除 → 注記も除去する
  // （残すと空枠同期が空枠を復活させてしまう）
  const removeLinkedNotes = (imgs: WorldObject[]) => {
    for (const img of imgs) {
      const ph = (img.data as ImageData).placeholder;
      if (!ph?.chain) continue;
      const c = chainsRef.current.find((x) => x.id === ph.chain);
      const pz = aozora.get(ph.chain);
      if (!c || !pz) continue;
      // pos 一致 → 連鎖内 pos 順の index 対応 の順で注記を同定
      let im = pz.images.find((i) => i.pos === ph.pos);
      if (!im) {
        const linked = engine.doc.objects
          .filter(
            (o) =>
              o.kind === IMG_KIND &&
              (o.data as ImageData)?.placeholder?.chain === c.id,
          )
          .sort(
            (a, b) =>
              (a.data as ImageData).placeholder!.pos -
              (b.data as ImageData).placeholder!.pos,
          );
        const k = linked.findIndex((o) => o.id === img.id);
        im = k >= 0 ? pz.images[k] : undefined;
      }
      if (!im) continue;
      const re = pz.toRaw(im.pos);
      const rs = c.text.lastIndexOf('［＃', re);
      const close = rs >= 0 ? c.text.indexOf('］', rs) : -1;
      if (close < 0) continue;
      // 注記だけの行なら行ごと除去（残ると空行だけが残る）
      const ls = c.text.lastIndexOf('\n', rs - 1) + 1;
      const only = /^［＃[^］]*］$/.test(c.text.slice(ls, close + 1));
      const s = only ? ls : rs;
      const e = only && c.text[close + 1] === '\n' ? close + 2 : close + 1;
      setChains((cs) =>
        cs.map((x) =>
          x.id === c.id
            ? { ...x, text: x.text.slice(0, s) + x.text.slice(e) }
            : x,
        ),
      );
    }
  };

  // .txt / ZIP 内 txt のデコード — UTF-8 とは限らない
  // （青空文庫系は Shift-JIS）ため、化けがあれば SJIS で読み直す
  const decodeAozoraText = (u8: Uint8Array) => {
    const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(u8);
    return utf8.includes('�')
      ? new TextDecoder('shift_jis').decode(u8)
      : utf8;
  };

  // .txt 読込の共通部（.txt 直接読込・青空 ZIP 読込で共用）—
  // 連鎖へ本文を流し、容量が足りなければ頁＋升目枠を一括追加する。
  // 画像注記の空枠は注記同期エフェクトが後から自動生成する
  const importChainText = (
    text: string,
    name: string,
    fix?: { spec: PageModel['spec']; genko: GenkoGrid },
    title?: string,
  ) => {
    requestAnimationFrame(() =>
      setTimeout(() => {
        // 青空注記は描画側で解釈 — 連鎖テキストは公式 txt の
        // まま保持する（編集・検索が生文に対して動く）。ここでは
        // 注記件数の報告のためにパースする。CRLF 改行は \n へ
        // 正規化 — textarea は値を LF に正規化するため、\r が
        // 残るとキャレット位置が行数ぶんズレる
        const src = text.replace(/\r\n?/g, '\n');
        const parsed = parseAozora(src);
        const ax = curAxis();
        // v0.10: 読込は必ず新規文書から始める — 旧文書の本文・
        // 画像・図形が残ると読込結果へ混入する。升目枠だけの
        // 空ドキュメント（newDoc と同じ buildWritingDoc）を
        // 組み直してから本文を流す
        const fresh = buildWritingDoc(docFont);
        const objs: WorldObject[] = [];
        // 判型/升目の強制指定は同じ next に対して適用する —
        // 外側で setState すると遅延実行が旧 model を捕捉して
        // 不整合になる（ページが旧 spec で組まれて表示が崩れる）
        const g = fix?.genko ?? genko;
        let next = fresh.model;
        if (fix?.spec) next = setPaper(next, fix.spec);
        // P1 の枠は目標の spec・升目・マージンで直接生成する —
        // buildWritingDoc の枠は既定マージン基準で作られるため、
        // 文書マージンが既定と違うと refitWritingAreas の旧枠一致
        // 判定から外れて「手動枠」と誤認され追従しない不具合が
        // あった（P1 だけ旧版面の枠が残る）。生成物と分かっている
        // 枠は判定なしで差し替えてよい
        const baseIds: string[] = [];
        const first = genkoAreaObjs(
          next.spec,
          next.pages[0].slot,
          g,
          ax,
          margins,
        );
        if (first.length) {
          for (const a of first) {
            objs.push(a);
            baseIds.push(a.id);
          }
        } else {
          // 升目が組めない極小用紙 — 版面矩形の単一枠へ退く
          const pr = pageRectAt(next.spec, next.pages[0].slot, ax);
          const ni = marginInsets(margins, next.pages[0].slot);
          const a: WorldObject = {
            id: nextId('ta'),
            kind: TEXT_KIND,
            x: pr.x + ni.l,
            y: pr.y + ni.t,
            w: pr.w - ni.l - ni.r,
            h: pr.h - ni.t - ni.b,
            style: {
              stroke: 'rgba(90,110,140,0.4)',
              fill: gridLineCss(gridBg, gridBgAlpha / 100),
            },
            data: {
              ...DEFAULT_TEXT_DATA,
              fontFamily: docFont,
              writing: 'vertical-rl',
              auto: true,
            },
          };
          objs.push(a);
          baseIds.push(a.id);
        }
        const ids: string[] = [];
        // 大文書は あふれ→追加 の往復が二乗級に遅い —
        // 枠容量から必要ページ数を概算して先に一括生成
        const perPage = Math.max(
          50,
          g.cells * g.cols * Math.max(1, g.columns ?? 1),
        );
        const need = Math.ceil(text.length / perPage) + 1;
        while (next.pages.length < need) {
          next = addPage(next);
          const slot = next.pages[next.pages.length - 1].slot;
          for (const a of genkoAreaObjs(
            next.spec,
            slot,
            g,
            ax,
            margins,
          )) {
            objs.push(a);
            ids.push(a.id);
          }
        }
        commitPages(next, objs);
        setChains(
          fresh.chains.map((c) => ({
            ...c,
            areas: [...baseIds, ...ids],
            text: src,
            marks: [],
          })),
        );
        setWriteChainId(null);
        engine.setSelection([]);
        createdAtRef.current = new Date().toISOString();
        // v0.11: 読込は新規文書 — 文書メタ（タイトル・柱）も新文書の
        // ものへ（旧文書の値が残って文書設定が不整合になるのを防ぐ）。
        // タイトルは青空ZIP=先頭行（作品名）/txt=ファイル名
        const ttl = (title ?? name.replace(/\.[^.]+$/, '')).slice(0, 40);
        setDocTitle(ttl);
        setHashira('');
        // fp も新文書へ更新（旧文書の下書きが残っていても誤復元しない）
        stampDocFp(createdAtRef.current, ttl);
        // 読込は新規文書なので必ず先頭ページへフィット
        focusPage(0, next);
        setBusy(null);
        flash(
          tf(t, 'hint.imported', name) +
            (parsed.handled || parsed.dropped
              ? ' / ' +
                tf(t, 'hint.aozora', parsed.handled, parsed.dropped)
              : '') +
            (parsed.images.length
              ? ' / ' + tf(t, 'hint.aozoraImg', parsed.images.length)
              : ''),
        );
      }, 30),
    );
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
  // （auto/genko + 執筆モードの全エリアへ即時反映・書庫へ保存）
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
  // v0.6: 見開き表示トグル（組版モードのみ）— 世界座標を
  // 'y'⇄'spread' で載せ替える（右綴じ: 奇数=右・偶数=左）
  const onToggleSpread = () => {
    const next = !spreadRef.current;
    setSpread(next);
    spreadRef.current = next;
    commitPages(
      model,
      remapAxis(
        contentObjects(),
        next ? 'y' : 'spread',
        next ? 'spread' : 'y',
        model.spec,
      ),
    );
    focusPage(curPage);
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

  // ── 連鎖レイアウト（貪欲配分） ──
  // v0.7: 大文書対応 — fitVertical は呼出のたび残り全文を
  // トークン化するため全体で O(エリア数×残文字数)。再描画のたびに
  // 全再計算するとページめくり1回でも数秒かかるので、依存が変わ
  // った時だけ計算する。ページめくり・パン・カーソル移動では
  // engine.version が進むが doc/chains は不変 → キャッシュ命中。
  // 幾何ジェスチャ中（drag/resize/rotate/vertex/bend）は liveRect が
  // engine のジェスチャ状態を読むため、毎 emit で再計算する。
  const objById = new Map(engine.doc.objects.map((o) => [o.id, o]));
  // v0.8: 青空注記は描画時に解釈 — 連鎖 text は公式 txt のまま
  // 保持し、組版はパース結果（text + marks）で行う。
  // 生⇔変換の位置マップで手動マーク・キャレット同期も整合する
  const aozora = useMemo(() => {
    const m = new Map<string, AozoraResult>();
    // 見出しは本文×1.3、キャプションは本文×0.8（v0.9）
    const bfs =
      genkoFontSize(model.spec, genko, margins) ??
      DEFAULT_TEXT_DATA.fontSize;
    for (const c of chains)
      m.set(
        c.id,
        parseAozora(c.text, {
          headingFs: bfs * 1.3,
          captionFs: bfs * 0.8,
          collapseNl,
        }),
      );
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chains, model.spec, genko, margins, collapseNl]);
  // v0.11: 章境界（柱の章ごと版）— `［＃「…」は見出し］` と ＊◇※
  // の区切り行を章の切れ目とみなす。スライス（parsed 座標）と
  // 比較するため位置は toParsed で写す。章名は見出しの「…」、
  // 区切り行は次の非空行の先頭（話区切り一覧のラベルと同じ規則）
  const chapterBounds = useMemo(() => {
    const m = new Map<string, { pos: number; name: string }[]>();
    for (const c of chains) {
      const pz = aozora.get(c.id);
      const items: { pos: number; name: string }[] = [];
      const lines = c.text.split('\n');
      let off = 0;
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const hm = /［＃「(.{1,30})」は[大中小]見出し］/.exec(line);
        const bm = /^[＊◇※]+\s*$/.exec(line);
        const bh = /［＃ここから[大中小]見出し］/.test(line);
        // v0.11: 注記無しの章行も章境界へ — 青空作品には
        // 「一、…」「第…章」や単独数字行で章を区切るものが多い
        const clean = line.replace(/［＃[^］]*］/g, '').trim();
        const dm = /^第[0-9０-９一二三四五六七八九十百千]+[章話節編部回]/.test(
          clean,
        );
        const km =
          clean.length <= 24 &&
          /^[一二三四五六七八九十]{1,3}[、．・　]/.test(clean);
        const nm = /^[一二三四五六七八九十]{1,3}$/.test(clean);
        if (hm) {
          items.push({ pos: pz ? pz.toParsed(off) : off, name: hm[1] });
        } else if (dm || km || nm) {
          items.push({
            pos: pz ? pz.toParsed(off) : off,
            name: clean.slice(0, 24),
          });
        } else if (bm || bh) {
          let nl = '';
          for (let k = li + 1; k < lines.length; k++) {
            const t2 = lines[k]
              .replace(/［＃[^］]*］/g, '')
              .trim();
            if (t2) {
              nl = t2.slice(0, 24);
              break;
            }
          }
          items.push({
            pos: pz ? pz.toParsed(off) : off,
            name: nl || line.trim(),
          });
        }
        off += line.length + 1;
      }
      if (items.length) m.set(c.id, items);
    }
    return m;
  }, [chains, aozora]);
  // レイアウト・描画に使う marks = 青空注記由来（変換座標）
  // + ユーザー手動 marks（生座標→変換座標へマップ）
  const chainMarks = (c: Chain): TextMark[] => {
    const marks = c.marks ?? [];
    const pz = aozora.get(c.id);
    if (!pz || (!pz.marks.length && !marks.length)) return marks;
    return [
      ...pz.marks,
      ...marks.map((m) => ({
        start: pz.toParsed(m.start),
        end: pz.toParsed(m.end),
        attrs: m.attrs,
      })),
    ];
  };
  const liveGeom = ['drag', 'resize', 'rotate', 'vertex', 'bend'].includes(
    engine.mode,
  )
    ? engine.version
    : 0;
  const { layouts, vflows, zones } = useMemo(() => {
    const layouts = new Map<string, LayoutResult>();
    // v0.4: 回しこみ — 障害のある縦書きエリアは layoutVertical の
    // 段×区間割当計画を保持し、描画は計画どおり区間を絶対配置する
    // （CSS writing-mode には障害を教えられないため — 案B。
    // 障害無しのスライスは従来どおり CSS 折返しで描く）
    const vflows = new Map<string, VFlow>();
    // 連鎖→注記index→予約ゾーンの実矩形（inner局所座標）—
    // 画像はこの矩形へそのまま配置する（anchorOf 側での
    // 段推定と二重になってずれるのを防ぐ）
    const zrec = new Map<
      string,
      Map<number, { areaId: string; zL: number; zR: number }>
    >();
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
          kinsoku, // v0.12: 禁則処理（文書設定）を組版へ引き渡す
          ...(d.writing === 'vertical-rl'
            ? { obstacles: areaObstacles(engine, o) }
            : {}),
        };
        boxes.push(box);
        boxById.set(id, box);
      }
      const pz = aozora.get(c.id);
      const txt = pz?.text ?? c.text;
      const marks = chainMarks(c);
      // 明示ブレイク（改丁/改ページ/改段）— 改段は段組でだけ意味を
      // 持つ（単段では改行と同義なので落とす。連鎖の枠仕様で判定）
      const gcols = (() => {
        const o = c.areas[0] ? objById.get(c.areas[0]) : undefined;
        return (
          (o?.data as TextAreaData | undefined)?.genko?.columns ?? 1
        );
      })();
      const brks = pz?.breaks?.filter(
        (b) => b.kind === 'page' || gcols > 1,
      );
      let lr = layoutChain(txt, boxes, measurerRef.current, marks, brks);
      // v0.9: 青空画像注記の予約ゾーン — 注記の段の次の段から
      // 画像段数ぶんを回しこみ禁止にする（収まらないぶんは頁末
      // まで塞がり改ページ相当 — 案①。ゾーンは注記から導くので
      // 画像オブジェクトの位置に依存せず安定する）。
      // 注記は文章順に逐次決定する — 直前のゾーンを入れた組版で
      // 次の注記の段を求めると、その押し出しを反映した確定位置に
      // なる（一括で出してから反復するとゾーン同士が位置を
      // 取り合って発散する）
      if (pz?.images.length) {
        const zl = new Map<
          number,
          { areaId: string; zL: number; zR: number }
        >();
        zrec.set(c.id, zl);
        // v0.10: 手配置の画像（回り込み・noWrap なし）に注記が
        // 対応づいた注記はゾーンを立てない — 枠自身が障害として
        // 回しこむため、ゾーン予約と二重になると空段ができる。
        // ゾーン方式は空枠（noWrap）対応の注記専用に戻す。
        // 枠の対応は空枠同期と同じ pos 順の index 対応
        const phFr = engine.doc.objects
          .filter((o) => {
            const d = o.data as ImageData | undefined;
            return (
              o.kind === IMG_KIND &&
              !!d?.placeholder &&
              d.placeholder.chain === c.id
            );
          })
          .sort(
            (a, b) =>
              (a.data as ImageData).placeholder!.pos -
              (b.data as ImageData).placeholder!.pos,
          );
        pz.images.forEach((img, zi) => {
          const fr = phFr[zi];
          if (fr && !(fr.data as ImageData).noWrap) return;
          const sl =
            lr.slices.find(
              (s) => img.pos < s.offset + s.text.length,
            ) ?? lr.slices[lr.slices.length - 1];
          const b = sl && boxById.get(sl.areaId);
          const ao = sl && objById.get(sl.areaId);
          const dd =
            ao &&
            ({ ...DEFAULT_TEXT_DATA, ...(ao.data as TextAreaData) });
          if (!sl || !b || !dd || dd.writing !== 'vertical-rl')
            return;
          const fs = Math.max(1, dd.fontSize);
          const pitch = fs * (1 + RUBY_LANE_RATIO);
          const off = Math.max(
            0,
            Math.min(img.pos - sl.offset, sl.text.length),
          );
          // 注記の段は推定ではなく実組版の単位割当から取る —
          // セル数近似だと禁則・段送りで数段ずれて隙間に後続
          // 本文が入り込む。注記直前の単位が載る段 = 注記の段
          const lv0 = layoutVertical(sl.text, {
            ...b,
            marks,
            textOffset: sl.offset,
            continuesPara: sl.offset > 0 && txt[sl.offset - 1] !== '\n',
            continuesAfter:
              sl.offset + sl.text.length < txt.length &&
              txt[sl.offset + sl.text.length] !== '\n',
          });
          const units = Array.from(
            tokenizeVertical(sl.text, marks, sl.offset),
          );
          const lastCol = lv0.segs[lv0.segs.length - 1]?.col ?? 0;
          // brk 単位はどの seg にも属さない — 後続側は次の seg、
          // 直前側は前の seg を返す
          const segOf = (i: number, dir: 1 | -1) =>
            lv0.segs.find((s) => i >= s.u0 && i < s.u1) ??
            (dir === 1
              ? lv0.segs.find((s) => s.u0 > i)
              : [...lv0.segs].reverse().find((s) => s.u0 < i));
          const uAt = (p: number) =>
            units.findIndex((u) => u.start <= p && p < u.start + u.raw);
          // 画像の開始段 = max(注記直前の字の段 + 1, 後続本文が
          // 始まる段) — 段落末では後続は次段から始まり、それが
          // そのまま画像の段になる。途中なら直前の段の次から
          const colPre =
            off > 0 ? (segOf(uAt(off - 1), -1)?.col ?? -1) : -1;
          const iPost =
            uAt(off) >= 0
              ? uAt(off)
              : units.findIndex((u) => u.start > off);
          const colPost =
            iPost >= 0 ? (segOf(iPost, 1)?.col ?? lastCol) : lastCol;
          const col = Math.max(colPre + 1, colPost);
          // 画像の段数 = ceil(画像幅 / 段ピッチ)。枠生成・判型変更の
          // 再フィットと同じ基準（ページ版面の60%/注記px→mm）で
          // 揃える — エリア内寸基準だと枠とゾーンが食い違う（v0.10）
          const imgW = (() => {
            const cx = ao.x + ao.w / 2;
            const cy = ao.y + ao.h / 2;
            const pr = pageRects(
              model.spec,
              model.pages,
              curAxis(),
            ).find(
              (r) =>
                cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h,
            );
            const mi = pr
              ? marginInsets(margins, pr.slot)
              : { l: 0, r: 0, t: 0, b: 0 };
            const bw = pr ? pr.w - mi.l - mi.r : b.width;
            const bh = pr ? pr.h - mi.t - mi.b : b.height;
            return noteImgSize(img, bw, bh).w;
          })();
          const k = Math.max(1, Math.ceil(imgW / pitch));
          const zR = b.width - col * pitch; // = 段 col-1 の左端
          const zL = Math.max(0, b.width - (col + k) * pitch);
          const cols = Math.floor(b.width / pitch);
          const fits = col + k <= cols;
          // 注記の段〜頁末はゾーンとして塞ぐ（収まらないぶんは
          // 頁末まで = 改ページ — 後続本文は画像の次の段から）
          if (zR > zL)
            b.obstacles = [
              ...(b.obstacles ?? []),
              { x: zL, y: 0, w: zR - zL, h: b.height },
            ];
          if (fits) {
            zl.set(zi, { areaId: sl.areaId, zL, zR });
          } else {
            // 残り段に収まらない → 次スライスの枠の先頭 k 段を
            // 画像のゾーンにする（画像はそこへ置かれ、自身の帯は
            // 不要 — 帯→組版→アンカー→帯 の循環を避ける）
            const nsl = lr.slices[lr.slices.indexOf(sl) + 1];
            const nb = nsl && boxById.get(nsl.areaId);
            if (nb) {
              const nk = Math.min(
                k,
                Math.max(1, Math.floor(nb.width / pitch)),
              );
              const nzL = nb.width - nk * pitch;
              nb.obstacles = [
                ...(nb.obstacles ?? []),
                { x: nzL, y: 0, w: nk * pitch, h: nb.height },
              ];
              zl.set(zi, {
                areaId: nb.id,
                zL: nzL,
                zR: nb.width,
              });
            } else {
              zl.set(zi, { areaId: sl.areaId, zL, zR });
            }
          }
          // このゾーンによる押し出しを次の注記へ反映するため
          // その場で組み直す
          if (zR > zL || !fits)
            lr = layoutChain(
              txt,
              boxes,
              measurerRef.current,
              marks,
              brks,
            );
        });
      }
      layouts.set(c.id, lr);
      for (const sl of lr.slices) {
        const b = boxById.get(sl.areaId);
        // v0.12: 縦書きスライスはすべて区間計画（vflow）で描く — CSS
        // 折返しは禁則を知らず、追い出し/ぶら下げ・折返し字下げ・地付き
        // のいずれも再現できない（障害・sep のための vflow を一般化）。
        // 描画は計画の u0/u1 どおり絶対配置 — 計測と見た目が一致する
        if (b?.writing === 'vertical-rl') {
          vflows.set(
            sl.areaId,
            layoutVertical(sl.text, {
              ...b,
              marks,
              textOffset: sl.offset,
              continuesPara: sl.offset > 0 && txt[sl.offset - 1] !== '\n',
              continuesAfter:
                sl.offset + sl.text.length < txt.length &&
                txt[sl.offset + sl.text.length] !== '\n',
            }),
          );
        }
      }
    }
    return { layouts, vflows, zones: zrec };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chains, engine.doc.objects, liveGeom, aozora, kinsoku]);

  // ── v0.9: 画像注記 ↔ 空枠の同期 ──
  // 連鎖テキスト中の画像注記 `［＃説明（file、横○×縦○）入る］` に
  // 対応する未割当の空枠（placeholder 付き image オブジェクト）を、
  // 注記の並び順で index 対応させる。.txt 読込・テキスト貼付・
  // 手編集・書庫復元のいずれの経路でも注記と枠が一致する。
  // 注記が増えたぶんは注記位置が乗るページの版面中央へ生成、
  // 消えたぶんは末尾の未割当枠から削除（充填済みは触らない）
  useEffect(() => {
    if (applyingRef.current) return;
    const ax = curAxis();
    const prs = pageRects(model.spec, model.pages, ax);
    const objs = engine.doc.objects;
    const pageOf = (o: WorldObject) => {
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      return prs.find(
        (p) => cx >= p.x && cx < p.x + p.w && cy >= p.y && cy < p.y + p.h,
      );
    };
    const isEmptyPh = (o: WorldObject) => {
      const d = o.data as ImageData | undefined;
      return o.kind === IMG_KIND && !!d?.placeholder && !d.url;
    };
    // 出自不明の空枠（chain 未保持の旧形式）— 不足が出た
    // 連鎖へ先着順で引き取らせる
    const untagged = objs.filter(
      (o) => isEmptyPh(o) && !(o.data as ImageData).placeholder!.chain,
    );
    const perPage = new Map<string, number>();
    for (const o of objs) {
      if (o.kind !== IMG_KIND) continue;
      const pid = pageOf(o)?.id;
      if (pid) perPage.set(pid, (perPage.get(pid) ?? 0) + 1);
    }
    // 注記位置の段/行を推定して画像の段アンカーを計算する。
    // 縦書きは注記の段の次の段から画像が始まる（右端=注記段の左端、
    // 上は升目枠の最上段）。横書きは注記の行の次の行の上端。
    // 単位数/段高の近似なので正確な折返しとはずれ得るが、
    // 生成・移動の両方で同じ規則を使う
    const anchorOf = (
      sl: { offset: number; text: string },
      nextSl: { offset: number; text: string; areaId: string } | undefined,
      ao: WorldObject,
      imgPos: number,
      w: number,
      h: number,
      n: number,
      zone?: { zL: number; zR: number },
      marks?: TextMark[],
    ): { x: number; y: number; next?: boolean } | null => {
      const d = { ...DEFAULT_TEXT_DATA, ...(ao.data as TextAreaData) };
      // 注記ゾーンが分かっていればその矩形へ直接置く — 右端を
      // ゾーン右端に揃え、幅がゾーンに収まらなければ次頁へ送る
      // （段推定と二重にならずずれない）
      if (d.writing === 'vertical-rl' && zone) {
        const x = ao.x + TEXT_PAD_MM + zone.zR - w;
        if (x >= ao.x + TEXT_PAD_MM + zone.zL) return { x, y: ao.y };
        const ao2 = nextSl && objs.find((q) => q.id === nextSl.areaId);
        if (ao2) return { x: ao2.x + ao2.w - w, y: ao2.y, next: true };
        return { x: ao.x, y: ao.y };
      }
      const fs = Math.max(1, d.fontSize);
      const off = Math.max(0, Math.min(imgPos - sl.offset, sl.text.length));
      const units = tokenizeVertical(
        sl.text.slice(0, off),
        marks,
        sl.offset,
      );
      let cells = 0;
      if (d.writing === 'vertical-rl') {
        const perCol = Math.max(
          1,
          Math.floor((ao.h - 2 * TEXT_PAD_MM) / fs),
        );
        for (const u of units) {
          if (u.kind === 'brk') {
            const r = cells % perCol;
            cells += r ? perCol - r : perCol;
          } else cells += u.cells;
        }
        const col = Math.floor(cells / perCol);
        const pitch = fs * (1 + RUBY_LANE_RATIO);
        // 注記の段の次の段から — 右端を注記段の左端に揃える。
        // 残り段に収まらない場合は改ページ — 次スライスの枠の
        // 先頭段（右端）へ送る（注記の段〜頁末は注記ゾーンが
        // 塞いでいるので後続本文は画像の次の段から再開する）
        const right = ao.x + ao.w - TEXT_PAD_MM - (col + 1) * pitch;
        const x = right - w - n * (w + 2);
        if (x >= ao.x) return { x, y: ao.y };
        const ao2 = nextSl && objs.find((q) => q.id === nextSl.areaId);
        if (ao2) return { x: ao2.x + ao2.w - w, y: ao2.y, next: true };
        return { x: ao.x, y: ao.y };
      }
      const perLine = Math.max(
        1,
        Math.floor((ao.w - 2 * TEXT_PAD_MM) / fs),
      );
      for (const u of units) {
        if (u.kind === 'brk') {
          const r = cells % perLine;
          cells += r ? perLine - r : perLine;
        } else cells += u.cells;
      }
      const row = Math.floor(cells / perLine);
      const x = ao.x + Math.max(0, (ao.w - w) / 2);
      const y = Math.max(
        ao.y,
        Math.min(
          ao.y + TEXT_PAD_MM + (row + 1) * fs * LINE_HEIGHT + n * (h + 2),
          ao.y + ao.h - h,
        ),
      );
      return { x, y };
    };
    const adds: WorldObject[] = [];
    const drops = new Set<string>();
    const patches = new Map<string, ImageData>();
    // 組版変動で枠の頁が注記スライスの頁からずれたぶんの寄せ直し
    const moves = new Map<
      string,
      { x: number; y: number; next?: boolean }
    >();
    for (const c of chains) {
      const imgs = aozora.get(c.id)?.images ?? [];
      // 対応付けは充填済みの実画像も含める — 配置済み画像に
      // placeholder が付く（注記挿入で対応づいたもの）ため、
      // 空枠だけを数えると注記のぶん余分な枠が生まれる
      const frames = objs
        .filter((o) => {
          const d = o.data as ImageData | undefined;
          return (
            o.kind === IMG_KIND &&
            !!d?.placeholder &&
            d.placeholder.chain === c.id
          );
        })
        .sort(
          (a, b) =>
            (a.data as ImageData).placeholder!.pos -
            (b.data as ImageData).placeholder!.pos,
        );
      for (let i = imgs.length; i < frames.length; i++)
        if (isEmptyPh(frames[i])) drops.add(frames[i].id);
      // 注記ゾーンは注記から導いて組版へ入っている（layouts の
      // 2パス）ので、ゾーン込みのスライス位置がそのまま画像の
      // 宛先になる — 帯抜き再組版は不要（ゾーンは画像位置に
      // 依存しないため振動しない）
      const lrF = layouts.get(c.id);
      for (const o of frames) {
        const d2 = o.data as ImageData;
        if (!d2.noWrap || !d2.placeholder) continue;
        // ドラッグ/リサイズ中はアンカーへ寄せない — 帯の移動で
        // 組版が揺れてアンカー計算と干渉し振動する
        if (liveGeom) continue;
        // 生成・削除と同じく pos 順の添字で対応させる — pos 厳密
        // 一致だと本文編集で注記位置がずれた枠が永遠に対象外になる
        const fi = frames.indexOf(o);
        const img = imgs[fi];
        const zn = zones.get(c.id)?.get(fi);
        if (!img || !lrF) continue;
        const cur = pageOf(o);
        const slIdx = lrF.slices.findIndex(
          (s) => img.pos < s.offset + s.text.length,
        );
        const sl =
          slIdx >= 0
            ? lrF.slices[slIdx]
            : lrF.slices[lrF.slices.length - 1];
        const ao = sl && objs.find((q) => q.id === sl.areaId);
        if (!ao) continue;
        // 宛先頁に既にいる他の注記枠ぶんカスケードする
        const n = objs.filter(
          (q) =>
            q.id !== o.id &&
            q.kind === IMG_KIND &&
            (q.data as ImageData | undefined)?.placeholder &&
            pageOf(q)?.id === pageOf(ao)?.id,
        ).length;
        const a2 = anchorOf(
          sl,
          slIdx >= 0 ? lrF.slices[slIdx + 1] : undefined,
          // ゾーンのエリアへ着地させる（次頁送りのゾーンは
          // 次頁のエリアを指す）
          (zn ? objs.find((q) => q.id === zn.areaId) : undefined) ??
            ao,
          img.pos,
          o.w,
          o.h,
          n,
          zn,
          chainMarks(c),
        );
        if (!a2) continue;
        // 収まらず次頁へ回った場合はその頁が宛先 — 着地先の頁と
        // 座標の両方が一致していれば移動しない（頁外に置かれた
        // 枠は cur が取れずスキップされ見えなくなるので、cur 無し
        // でも必ずアンカーへ戻す）
        const land = pageOf({ ...o, x: a2.x, y: a2.y });
        if (
          cur &&
          land &&
          land.id === cur.id &&
          Math.abs(a2.x - o.x) < 1 &&
          Math.abs(a2.y - o.y) < 1
        )
          continue;
        moves.set(o.id, a2);
      }
      for (let i = frames.length; i < imgs.length; i++) {
        const img = imgs[i];
        const zn = zones.get(c.id)?.get(i);
        const adopt = untagged.shift();
        if (adopt) {
          patches.set(adopt.id, {
            ...(adopt.data as ImageData),
            placeholder: {
              ...(adopt.data as ImageData).placeholder!,
              chain: c.id,
              pos: img.pos,
            },
          });
          continue;
        }
        const lr = layouts.get(c.id);
        const slIdx =
          lr?.slices.findIndex((s) => img.pos < s.offset + s.text.length) ??
          -1;
        const sl =
          slIdx >= 0
            ? lr!.slices[slIdx]
            : lr?.slices[lr.slices.length - 1];
        const ao = sl && objs.find((o) => o.id === sl.areaId);
        const pr = ao && pageOf(ao);
        if (!pr) continue;
        const mi = marginInsets(margins, pr.slot);
        const bw = pr.w - mi.l - mi.r;
        const bh = pr.h - mi.t - mi.b;
        // 注記の横×縦（px）は 96dpi 実寸 mm へ換算。版面に収まらない
        // 指定は収まる比率で縮小、サイズ省略は版面幅の60%を既定 —
        // ゾーン計算・判型変更の再フィットと同じ基準（noteImgSize）
        const { w, h } = noteImgSize(img, bw, bh);
        // 注記由来の画像は回り込みしないブロック扱い — 注記の
        // 段の次の段から画像が始まる（縦版）/ 次の行の上端（横版）。
        // 画像下の余白は障害の全高化で回しこみ禁止になる
        const n = perPage.get(pr.id) ?? 0;
        perPage.set(pr.id, n + 1);
        const a = anchorOf(
          sl!,
          slIdx >= 0 ? lr!.slices[slIdx + 1] : undefined,
          (zn ? objs.find((q) => q.id === zn.areaId) : undefined) ??
            ao!,
          img.pos,
          w,
          h,
          n,
          zn,
          chainMarks(c),
        ) ?? { x: ao!.x, y: ao!.y };
        const { x, y } = a;
        adds.push({
          id: nextId('im'),
          kind: IMG_KIND,
          x,
          y,
          w,
          h,
          style: { stroke: 'rgba(90,110,140,0.4)' },
          data: {
            url: '',
            aspect: h / w,
            lock: true,
            // 注記由来の画像は回り込みしない（青空注記には回り込み
            // 指定が無いためブロック扱い — アプリで差し込んだ
            // 画像のみ回しこみ対象）
            noWrap: true,
            placeholder: {
              alt: img.alt,
              file: img.file,
              chain: c.id,
              pos: img.pos,
              nextPage: a.next,
            },
          } satisfies ImageData,
        });
      }
    }
    if (!adds.length && !drops.size && !patches.size && !moves.size)
      return;
    engine.setDoc({
      ...engine.doc,
      objects: [
        ...objs
          .filter((o) => !drops.has(o.id))
          .map((o) => {
            const p = patches.get(o.id);
            const m = moves.get(o.id);
            if (!p && !m) return o;
            const { next, ...xy } = m ?? {};
            let data = p ?? o.data;
            const d3 = o.data as ImageData | undefined;
            if (
              !p &&
              next !== undefined &&
              d3?.placeholder &&
              !!d3.placeholder.nextPage !== !!next
            )
              data = {
                ...d3,
                placeholder: { ...d3.placeholder, nextPage: !!next },
              };
            return { ...o, ...xy, data };
          }),
        ...adds,
      ],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aozora, layouts, chains, engine.doc.objects, model, margins]);

  // v0.9: 青空ZIP の同梱画像で空枠を自動充填 — 注記の file 名と
  // 同梱画像ファイル名（basename 一致）を対応づける
  useEffect(() => {
    const map = aozoraImgRef.current;
    if (!map.size) return;
    for (const o of engine.doc.objects) {
      const d = o.data as ImageData | undefined;
      if (o.kind !== IMG_KIND || !d?.placeholder || d.url) continue;
      const url = map.get(d.placeholder.file.toLowerCase());
      if (!url || aozoraImgBusy.current.has(o.id)) continue;
      aozoraImgBusy.current.add(o.id);
      const im = new Image();
      im.onload = () => {
        aozoraImgBusy.current.delete(o.id);
        fillPlaceholder(o, url, im.naturalHeight / im.naturalWidth);
      };
      im.src = url;
    }
  }, [engine.doc.objects]);

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
    // オブジェクトが一つも無い末尾ページは完全な空 — 削除対象
    if (inside.length === 0) return last.id;
    // v0.6: 段組では末尾ページに段数分の枠が乗る — すべて
    // genko/auto 枠で、かつ全スライスが空（空白のみ・孤児枠
    // も空扱い）なら末尾ページを削る
    const slices = layouts.get(writeChain.id)?.slices;
    const allEmpty = inside.every((o) => {
      const d = o.data as TextAreaData | undefined;
      // v0.9: 未割当の画像空枠（placeholder）は残り物扱い —
      // 注記は本文側に残るため、消しても同期エフェクトが正しい
      // 頁へ再生成する。充填済み画像は人の配置なので残す
      const id2 = o.data as ImageData | undefined;
      if (o.kind === IMG_KIND && id2?.placeholder && !id2.url)
        return true;
      if (!d?.genko && !d?.auto) return false;
      const sl = slices?.find((s) => s.areaId === o.id);
      return !sl || sl.text.trim() === '';
    });
    return allEmpty ? last.id : null;
  })();
  const wcLastOv = useRef({ ov: '', areas: 0, pages: 0 });
  useEffect(() => {
    // あふれが空白だけなら追加しない — 追加すると空ページを
    // 削る処理と無限ループになる
    if (wcOverflow.length > 0 && wcOverflow.trim() !== '') {
      // 吸収不能（枠が組めない spec や連鎖未接続）なら打ち切り
      // — ただし「あふれが同じ」だけでは止めず、頁・エリアも
      // 変わっていない（真に進捗ゼロ）ときだけ打ち切る。
      // あふれ文字列だけの比較だと、追加→再計算の途中で同一
      // 文字列に見えたまま追加が永久に止まることがあった
      const areasN = (writeChain ?? chains[0])?.areas.length ?? 0;
      const last = wcLastOv.current;
      if (
        wcOverflow === last.ov &&
        areasN === last.areas &&
        model.pages.length === last.pages
      )
        return;
      wcLastOv.current = {
        ov: wcOverflow,
        areas: areasN,
        pages: model.pages.length,
      };
      // あふれ文字数から必要ページを一括追加 — 1ページずつ
      // 往復すると大文書で時間がかかる。別タスク化も兼ねる
      setTimeout(() => {
        const perPage = Math.max(
          50,
          genko.cells * genko.cols * Math.max(1, genko.columns ?? 1),
        );
        const need = Math.ceil(wcOverflow.length / perPage) + 1;
        const ax = curAxis();
        const base = modelRef.current; // タイムアウト時点の最新
        let next = base;
        const objs = contentObjects();
        const ids: string[] = [];
        while (next.pages.length < base.pages.length + need) {
          next = addPage(next);
          const slot = next.pages[next.pages.length - 1].slot;
          for (const a of genkoAreaObjs(next.spec, slot, genko, ax, margins)) {
            objs.push(a);
            ids.push(a.id);
          }
        }
        const target = writeChain ?? chainsRef.current[0];
        if (target && ids.length)
          setChains((cs) =>
            cs.map((c) =>
              c.id === target.id
                ? { ...c, areas: [...c.areas, ...ids] }
                : c,
            ),
          );
        commitPages(next, objs);
      }, 0);
      return;
    }
    wcLastOv.current = { ov: '', areas: 0, pages: 0 };
    if (wcEmptyTail)
      setTimeout(() => {
        // バグ等で空末尾ページが量産された場合、1枚ずつでは
        // 追いつかない — 末尾から連続する空ページを一括削除する
        const prs = pageRects(model.spec, model.pages, curAxis());
        const slices = layouts.get(writeChain!.id)?.slices;
        const tail: string[] = [];
        const tailRects: typeof prs = [];
        for (let i = prs.length - 1; i >= 1; i--) {
          const pr = prs[i];
          const inside = engine.doc.objects.filter(
            (o) =>
              o.kind !== PAGE_KIND &&
              o.x + o.w / 2 >= pr.x &&
              o.x + o.w / 2 < pr.x + pr.w &&
              o.y + o.h / 2 >= pr.y &&
              o.y + o.h / 2 < pr.y + pr.h,
          );
          if (!inside.length) {
            // オブジェクトの無い頁も空として削除へ含める
            tail.unshift(pr.id);
            tailRects.unshift(pr);
            continue;
          }
          const allEmpty = inside.every((o) => {
            const d = o.data as TextAreaData | undefined;
            // 未割当の画像空枠は残り物 — 頁と一緒に消してよい
            const id2 = o.data as ImageData | undefined;
            if (o.kind === IMG_KIND && id2?.placeholder && !id2.url)
              return true;
            if (!d?.genko && !d?.auto) return false;
            const sl = slices?.find((s) => s.areaId === o.id);
            return !sl || sl.text.trim() === '';
          });
          if (!allEmpty) break;
          tail.unshift(pr.id);
          tailRects.unshift(pr);
        }
        if (!tail.length) return;
        const insideIds = new Set<string>();
        const objs = engine.doc.objects.filter((o) => {
          if (o.kind === PAGE_KIND) return false;
          const cx = o.x + o.w / 2;
          const cy = o.y + o.h / 2;
          const onTail = tailRects.some(
            (pr) =>
              cx >= pr.x && cx < pr.x + pr.w && cy >= pr.y && cy < pr.y + pr.h,
          );
          if (!onTail) return true;
          insideIds.add(o.id);
          return false;
        });
        if (insideIds.size)
          setChains((cs) =>
            cs.map((c) => ({
              ...c,
              areas: c.areas.filter((a) => !insideIds.has(a)),
            })),
          );
        let next = model;
        for (const id of tail) next = deletePage(next, id);
        commitPages(next, objs);
      }, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wcOverflow, wcEmptyTail]);

  // ── ページナビ: アクティブページ（枠クリック or ナビで切替） ──
  const axis: StackAxis = writeMode ? 'x' : 'y';
  const rects = pageRects(model.spec, model.pages, axis);
  const curPage = Math.min(activePage, Math.max(0, rects.length - 1));

  // 連鎖テキスト ⇄ ページの双方向シンク（v0.8）
  // Slice.offset が連鎖内の開始位置を持つので、テキスト位置から
  // 表示すべきページが引ける（逆はページ上の最初のエリアの offset）
  const pageIndexOf = (o: WorldObject | undefined) => {
    if (!o) return -1;
    const cx = o.x + o.w / 2;
    const cy = o.y + o.h / 2;
    return (
      rects.find(
        (r) => cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h,
      )?.index ?? -1
    );
  };
  const writeSlices = writeChain
    ? (layouts.get(writeChain.id)?.slices ?? [])
    : [];
  const caretPage = (pos: number) => {
    if (!writeSlices.length) return -1;
    // キャレットは生テキスト座標、スライスは変換後座標 — 写像で揃える
    const pz = writeChain ? aozora.get(writeChain.id) : undefined;
    const pp = pz ? pz.toParsed(pos) : pos;
    let sl = writeSlices[writeSlices.length - 1];
    for (const s of writeSlices) {
      if (pp < s.offset + s.text.length) {
        sl = s;
        break;
      }
    }
    return pageIndexOf(objById.get(sl.areaId));
  };
  // テキスト → ビュー: キャレット位置のページへ移動
  const syncViewToCaret = (pos: number) => {
    const pg = caretPage(pos);
    if (pg >= 0 && pg !== curPage) {
      setActivePage(pg);
      focusPage(pg);
    }
  };
  // ビュー → テキスト: 現ページの先頭文字へキャレットを移す。
  // 検索ジャンプも同じ経路（onJumpSel）へ統一
  const [textJump, setTextJump] = useState<{ s: number; e: number; n: number }>();
  const syncTextToView = () => {
    const s = writeSlices.find(
      (sl) => pageIndexOf(objById.get(sl.areaId)) === curPage,
    );
    if (s) {
      const pz = writeChain ? aozora.get(writeChain.id) : undefined;
      const pos = pz ? pz.toRaw(s.offset) : s.offset;
      setTextJump((prev) => ({ s: pos, e: pos, n: (prev?.n ?? 0) + 1 }));
    }
  };
  curPageRef.current = curPage;
  // G1+G2: ページが収まる倍率に調整して位置合わせする。
  // v0.7: 執筆モードはページ高さをウィンドウ高さで固定し、
  // 現ページを中央表示するページビューア — 横位置は両軸中央揃え。
  // 組版モードは従来通りページ全体が収まる倍率 + 左上合わせ。
  const focusPage = (i: number, mdl: PageModel = model) => {
    suppressDblUntil.current = performance.now() + 700;
    const rs = pageRects(
      mdl.spec,
      mdl.pages,
      writeModeRef.current ? 'x' : 'y',
    );
    const idx = Math.min(Math.max(0, i), Math.max(0, rs.length - 1));
    setActivePage(idx);
    const el = canvasRef.current;
    const p = rs[idx];
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
        ? (el.clientWidth - p.w * u) / 2 - p.x * u
        : pad - p.x * u,
      y: pad - p.y * u,
    };
    engine.panBy(0, 0); // viewport 反映のため emit を起こす
  };
  focusPageRef.current = focusPage;
  const goToPage = (i: number) => focusPage(i);

  // 末尾ページの自動削除等で現ページが圏外へ出たら補正して再フィット
  // （activePage が clamp された = ページ数が縮んだ印）
  useEffect(() => {
    if (writeMode && curPage !== activePage) focusPage(curPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curPage, activePage, writeMode]);

  const { spec } = model;
  const z = engine.viewport.zoom;
  // v0.3: 総字数（status.chars・目標進捗で共用）— サロゲート対は1字
  const totalChars = useMemo(
    () => chains.reduce((n, c) => n + [...c.text].length, 0),
    [chains],
  );
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
    // v0.6: 段数の変更 — 各ページの genko 枠を上→下で col 昇順に
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
        .sort((a, b) => a.y - b.y); // 上→下 = col 0..k-1
      if (!onPage.length) continue;
      const frames = genkoFrames(model.spec, r.slot, g, ax, margins);
      onPage.forEach((o, i) => {
        if (i >= n) {
          dropIds.add(o.id);
          return;
        }
        // 残る段も無条件で新枠・col・仕様を書き直す — refit の
        // 位置一致を通らなかった枠は col/fontSize が古いまま
        // 固まり、以後ずっと同期を外れ続けるため
        const f = frames[i];
        if (!f) return;
        const k = objects.indexOf(o);
        const dd = o.data as TextAreaData;
        objects[k] = {
          ...o,
          x: f.x,
          y: f.y,
          w: f.w,
          h: f.h,
          data: {
            ...dd,
            fontSize: f.fontSize,
            genko: { ...g },
            col: i,
          },
        };
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

  // v0.7: 執筆モードのビューポート仮想化 — 大文書では全ページ・
  // 全エリアの DOM 化が支配的コスト。IsleCanvas の objectFilter で
  // 現ページ±1 のページ区間に乗るオブジェクトだけ DOM 化する
  // （ページ枠・エリア矩形の ki-obj ネイティブ描画も間引く）。
  // ページ枠に乗らないオブジェクト（帯の隙間）は従来どおり描く
  const inView = (o: WorldObject) => {
    const cx = o.x + o.w / 2;
    const cy = o.y + o.h / 2;
    const hit = rects.find(
      (r) =>
        cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h,
    );
    return !hit || Math.abs(hit.index - curPage) <= 1;
  };

  // v0.11: 柱の章ごと版 — ページに乗るスライス末尾（parsed 座標）
  // までの直近の章境界名をその頁の柱へ出す。境界の無い頁・
  // 先頭境界より前の頁は doc 設定の柱（hashira）へ畳む
  // hit-test は実オブジェクト座標の軸で（執筆='x'・組版='y'・見開き）
  const navPrs = pageRects(model.spec, model.pages, curAxis());
  const navPageOf = (o: WorldObject | undefined) => {
    if (!o) return -1;
    const cx = o.x + o.w / 2;
    const cy = o.y + o.h / 2;
    return (
      navPrs.find(
        (r) =>
          cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h,
      )?.index ?? -1
    );
  };
  const pageChapter = (() => {
    const m = new Map<number, string>();
    for (const c of chains) {
      const bounds = chapterBounds.get(c.id);
      if (!bounds?.length) continue;
      const lr = layouts.get(c.id);
      if (!lr) continue;
      // ページごとの最終スライス位置（parsed 座標・排他端）を集める
      const endByPage = new Map<number, number>();
      for (const sl of lr.slices) {
        const pi = navPageOf(objById.get(sl.areaId));
        if (pi < 0) continue;
        const end = sl.offset + sl.text.length;
        if (end > (endByPage.get(pi) ?? -1)) endByPage.set(pi, end);
      }
      for (const [pi, end] of endByPage) {
        if (m.has(pi)) continue; // 先の連鎖の章を優先
        let name: string | undefined;
        for (const b of bounds) {
          if (b.pos < end) name = b.name;
          else break;
        }
        if (name) m.set(pi, name);
      }
    }
    return m;
  })();
  const hashiraAt = (index: number) => pageChapter.get(index) ?? hashira;
  // v0.11: 章一覧（ページナビのジャンプ用）— 各章境界の開始頁を
  // 境界位置が載るスライスから引く（柱クリックは頁クリック送りと
  // 競合するためペイン選択式へ — 欄外は表示専用）
  const chapterNav = (() => {
    const out: { name: string; page: number }[] = [];
    for (const c of chains) {
      const bounds = chapterBounds.get(c.id);
      if (!bounds?.length) continue;
      const lr = layouts.get(c.id);
      if (!lr) continue;
      for (const b of bounds) {
        const sl =
          lr.slices.find((s) => b.pos < s.offset + s.text.length) ??
          lr.slices[lr.slices.length - 1];
        if (!sl) continue;
        const p = navPageOf(objById.get(sl.areaId));
        if (p >= 0) out.push({ name: b.name, page: p });
      }
    }
    return out;
  })();

  const renderObject = (o: WorldObject) => {
    if (o.kind === PAGE_KIND) {
      const d = o.data as { index: number };
      const hs = hashiraAt(d.index);
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
              color: docColor,
            }}
          >
            {d.index + 1}
          </div>
        )}
        {/* v0.7: 柱 — 文書設定の文字列があるとき天余白へ縦書きで出す
            （升目枠の右辺揃え・上辺まで。印刷側 .hashira と同じ位置）。
            v0.11: 章境界のある頁は章名（hashiraAt）、無い頁は doc 設定 */}
        {hs !== '' && (
          <div
            className="hashira-canvas nodrag"
            style={{
              top: hashiraRect.top * MM_PX * z,
              right: hashiraRect.right * MM_PX * z,
              fontSize: Math.max(9, hashiraRect.size * MM_PX * z),
              fontFamily: docFont,
              color: docColor,
            }}
          >
            {hs}
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
      const runs = sliceRuns(
        sl?.text ?? '',
        c ? chainMarks(c) : undefined,
        sl?.offset ?? 0,
        {
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
      const units = vertical
        ? tokenizeVertical(
            sl?.text ?? '',
            c ? chainMarks(c) : undefined,
            sl?.offset ?? 0,
          )
        : null;
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
            // 傍点（青空注記由来）— 横書きは sesame、縦書きは
            // よみがな扱いでルビ欄へ「・」（vtrender 側）
            textEmphasis: a?.boten ? 'sesame' : undefined,
          },
          boten: a?.boten,
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
                        // v0.12: padTop（折返し字下げ・地付き/地寄せ）は
                        // 区間を縮めて上側へ空きを作り、hang（ぶら下げ）は
                        // 区間下端のはみ出しを clip しないよう延ばす
                        top: (s.y + (s.padTop ?? 0)) * MM_PX * z,
                        height:
                          (s.h - (s.padTop ?? 0) + (s.hang ?? 0)) *
                          MM_PX *
                          z,
                        right: s.col * vflow.pitch * MM_PX * z,
                        width: vflow.pitch * MM_PX * z,
                      }}
                    >
                      {vunitSpans(
                        units!.slice(s.u0, s.u1),
                        vStyleOf,
                        s.h * MM_PX * z,
                      )}
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
                      textEmphasis: r.attrs.boten ? 'sesame' : undefined,
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
      // v0.9: 未割当のプレースホルダ枠 — 注記の説明文を
      // 中央表示した空枠として描く（選択中の貼付/読込で充填）
      if (d.placeholder && !d.url)
        return (
          <div className="img-ph">
            <span>{d.placeholder.alt || d.placeholder.file}</span>
            {d.placeholder.file && (
              <span className="img-ph-file">{d.placeholder.file}</span>
            )}
            {writeMode && (
              <span className="img-ph-hint">{t('img.phClick')}</span>
            )}
          </div>
        );
      return (
        <img
          className="img-fill"
          src={d.url}
          draggable={false}
          alt={d.placeholder?.alt ?? ''}
        />
      );
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

  // v0.11: 文書設定プロップス — RightDock と右側フロートパネルの
  // 両方から参照するため定数化（パネルは右端レールから開く）
  const docPropsObj = {
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
    collapseNl,
    onCollapseNl: setCollapseNl,
    kinsoku,
    onKinsoku: setKinsoku,
    hanmenCells,
    fit400fs: cellArea ? fit400fs : null,
    onFit400: fit400,
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
          onImportText={() => textFileRef.current?.click()}
          onImportZip={() => aozoraZipRef.current?.click()}
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
          spread={spread}
          onToggleSpread={onToggleSpread}
          onAbout={() => setAboutOpen(true)}
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
            objectFilter={writeMode ? inView : undefined}
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
          {/* v0.11: 右側メニュー — 頁ナビ/文書設定は右端レールの
              ボタンで開閉するフロートパネルへ（入力欄を広く使う
              ため。レールは常時表示、パネルは同時に1つ） */}
          <div className="side-rail">
            <button
              className={sidePanel === 'nav' ? 'active' : ''}
              title={t('side.nav')}
              onClick={() =>
                setSidePanel((p) => (p === 'nav' ? null : 'nav'))
              }
            >
              頁
            </button>
            {chapterNav.length > 0 && (
              <button
                className={sidePanel === 'chap' ? 'active' : ''}
                title={t('side.chap')}
                onClick={() =>
                  setSidePanel((p) => (p === 'chap' ? null : 'chap'))
                }
              >
                章
              </button>
            )}
            <button
              className={sidePanel === 'doc' ? 'active' : ''}
              title={t('side.doc')}
              onClick={() =>
                setSidePanel((p) => (p === 'doc' ? null : 'doc'))
              }
            >
              設
            </button>
          </div>
          {sidePanel === 'nav' && (
            <PageNav
              current={curPage}
              total={rects.length}
              collapsed={false}
              onToggle={() => setSidePanel(null)}
              onGo={goToPage}
              t={t}
            />
          )}
          {sidePanel === 'chap' && chapterNav.length > 0 && (
            <div className="side-panel chap">
              <div className="sp-head">
                <span>{t('side.chap')}</span>
                <button
                  title={t('chain.close')}
                  onClick={() => setSidePanel(null)}
                >
                  ×
                </button>
              </div>
              <div className="sp-body">
                {chapterNav.map((ch, i) => (
                  <button
                    key={i}
                    className="sp-chap"
                    title={t('nav.chapter')}
                    onClick={() => goToPage(ch.page)}
                  >
                    <span className="sp-chap-name">{ch.name}</span>
                    <span className="sp-chap-p">p.{ch.page + 1}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {sidePanel === 'doc' && (
            <div className="side-panel doc">
              <div className="sp-head">
                <span>{t('doc.settings')}</span>
                <button
                  title={t('chain.close')}
                  onClick={() => setSidePanel(null)}
                >
                  ×
                </button>
              </div>
              <div className="sp-body">
                <DocProps {...docPropsObj} t={t} />
              </div>
            </div>
          )}
          {/* N-19: スクロール（ホイールパン不慣れ対策のフローティングUI）。
              v0.7: 執筆モードはページナビのみへ再構成し左右ボタンを
              廃止 — 残るのは組版（縦積み）の俯瞰移動用 */}
          {!writeMode && (
            <div className="scroll-nav">
              <button
                title={t('scroll.up')}
                onClick={() => {
                  const el = canvasRef.current;
                  if (!el) return;
                  engine.viewport.y += el.clientHeight * 0.6;
                  engine.panBy(0, 0);
                }}
              >
                ▲
              </button>
              <button
                title={t('scroll.down')}
                onClick={() => {
                  const el = canvasRef.current;
                  if (!el) return;
                  engine.viewport.y -= el.clientHeight * 0.6;
                  engine.panBy(0, 0);
                }}
              >
                ▼
              </button>
            </div>
          )}
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
          // 連鎖テキスト ⇄ ページの双方向シンク（執筆モードのみ）
          onCaret={writeMode ? syncViewToCaret : undefined}
          onGotoText={writeMode ? syncTextToView : undefined}
          onJumpSel={
            writeMode
              ? (s, e) =>
                  setTextJump((prev) => ({ s, e, n: (prev?.n ?? 0) + 1 }))
              : undefined
          }
          textJump={textJump}
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
          docProps={docPropsObj}
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
        {/* v0.3: 自動保存した下書きの時刻 — v0.11: クリックで明示削除 */}
        {draftAt && (
          <span
            title={t('status.draftClearTip')}
            style={{ cursor: 'pointer' }}
            onClick={() => {
              void clearDraft();
              setDraftAt(null);
            }}
          >
            {tf(t, 'status.draft', fmtTime(draftAt))} ✕
          </span>
        )}
        <span>{tf(t, 'status.pages', model.pages.length)}</span>
        {/* v0.7: 執筆モードは固定倍率のためスケール表示を出さない */}
        {!writeMode && <span>scale {engine.scaleText()}</span>}
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
          hashiraFor={hashiraAt}
          hashiraRect={hashiraRect}
          hashiraFont={docFont}
          hashiraColor={docColor}
          objects={canon(engine.doc.objects)}
          sliceRuns={(o) => {
            const c = chainOf(chains, o.id);
            if (!c) return [];
            const lr = layouts.get(c.id);
            const sl = lr?.slices.find((s) => s.areaId === o.id);
            if (!sl) return [];
            const d = { ...DEFAULT_TEXT_DATA, ...(o.data as TextAreaData) };
            return sliceRuns(sl.text, chainMarks(c), sl.offset, {
              fontSize: d.fontSize,
              fontFamily: d.fontFamily,
              color: d.color,
              bold: d.bold,
              italic: d.italic,
              underline: d.underline,
              link: d.link,
            });
          }}
          unitsFor={(o) => {
            const c = chainOf(chains, o.id);
            if (!c) return [];
            const lr = layouts.get(c.id);
            const sl = lr?.slices.find((s) => s.areaId === o.id);
            if (!sl) return [];
            return tokenizeVertical(sl.text, chainMarks(c), sl.offset);
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
      {/* v0.7: テキスト取り込み — .txt を連鎖テキストへ
          読み込む（長文はコピペだとハングするため） */}
      <input
        ref={textFileRef}
        type="file"
        accept=".txt,.text,text/plain"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (!f) return;
          // 長文の流れ込みは重い — まず進行中オーバーレイを
          // 描いてから次フレームで流す（描けなければハングに見える）
          setBusy(t('hint.importing'));
          f.arrayBuffer().then((buf) =>
            importChainText(decodeAozoraText(new Uint8Array(buf)), f.name),
          );
        }}
      />
      {/* v0.9: 青空文庫 ZIP 読込 — txt と同梱画像を取り込み、
          注記の file と一致する空枠へ画像を自動充填する */}
      <input
        ref={aozoraZipRef}
        type="file"
        accept=".zip"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (!f) return;
          setBusy(t('hint.importing'));
          f.arrayBuffer().then((buf) => {
            let files: Record<string, Uint8Array>;
            try {
              files = unzipSync(new Uint8Array(buf));
            } catch {
              setBusy(null);
              flash(t('hint.zipBad'));
              return;
            }
            // 同梱画像を basename → dataURL へ（注記 file と対応づけ）
            const map = new Map<string, string>();
            for (const [n, u8] of Object.entries(files)) {
              const m = /\.(png|jpe?g|gif|webp)$/i.exec(n);
              if (!m) continue;
              let b = '';
              for (let i = 0; i < u8.length; i += 0x8000)
                b += String.fromCharCode(...u8.subarray(i, i + 0x8000));
              const ext = m[1].toLowerCase().replace('jpeg', 'jpg');
              map.set(
                n.split('/').pop()!.toLowerCase(),
                `data:image/${ext};base64,${btoa(b)}`,
              );
            }
            aozoraImgRef.current = map;
            const tn = Object.keys(files).find((n) => /\.txt$/i.test(n));
            if (!tn) {
              setBusy(null);
              flash(t('hint.zipNoTxt'));
              return;
            }
            // 青空ZIPは四六判・縦・単行本(43×17)へ揃える —
            // 画像ゾーン・枠は読込時の版面で確定するため、別判型で
            // 読むと画像と文字がずれる。遅延実行内で同じ model へ
            // 適用しないと不整合になるので fix として渡す
            setGenko({ cells: 43, cols: 17, columns: 1 });
            const txts = decodeAozoraText(files[tn]);
            // 青空形式の先頭行は作品名 — 文書タイトルへ（無ければ
            // importChainText 側でファイル名へ畳む）
            const ttl = txts
              .split('\n')
              .map((l) => l.trim())
              .find((l) => l !== '');
            importChainText(txts, f.name, {
              spec: {
                ...model.spec,
                size: 'SHIROKU',
                landscape: false,
              },
              genko: { cells: 43, cols: 17, columns: 1 },
            }, ttl);
          });
        }}
      />
      <input
        ref={openFileRef}
        type="file"
        accept={`${ARCHIVE_EXT},.slm`}
        style={{ display: 'none' }}
        onChange={onOpenFile}
      />
      {busy && (
        <div className="dlg-backdrop">
          <div className="dlg busy">{busy}</div>
        </div>
      )}
      {/* v0.11: About オーバーレイ */}
      {aboutOpen && <About onClose={() => setAboutOpen(false)} t={t} />}
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
                {ARCHIVE_EXT}
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
