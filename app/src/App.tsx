import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { IsleCanvas, useEngine, useEngineVersion } from '@kimetron/react';
import { formatLength, type Engine, type WorldObject } from '@kimetron/core';
import {
  addPage,
  adjustMarksForEdit,
  applyMark,
  applyVerticalShift,
  canLink,
  chainOf,
  clearMarksIn,
  createPages,
  deletePage,
  insertPage,
  layoutChain,
  linkChains,
  normalizeRuby,
  paperDims,
  pageRectAt,
  pageRects,
  pruneChains,
  RUBY_LANE_RATIO,
  setPaper,
  sliceRuns,
  tokenizeVertical,
  unlinkAt,
  type Chain,
  type LayoutResult,
  type PageModel,
  type PaperSize,
  type TextAttrs,
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
  DEFAULT_TEXT_DATA,
  IMG_KIND,
  LINE_HEIGHT,
  liveRect,
  MM_PX,
  PAGE_KIND,
  TEXT_KIND,
  TEXT_PAD_MM,
  type ImageData,
  type TextAreaData,
} from './types';
import './styles.css';

/** ページ枠を kimetron オブジェクトとして展開する。
    locked + layer -1 で最背面・操作対象外（hitFilter でも除外）。 */
function pageObjects(model: PageModel, opacity = 1): WorldObject[] {
  return pageRects(model.spec, model.pages).map((r) => ({
    id: r.id,
    kind: PAGE_KIND,
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    locked: true,
    layer: -1,
    style: { fill: `rgba(255,255,255,${opacity})` },
    data: { index: r.index },
  }));
}

/** ページの辺・中心をドラッグ/リサイズのスナップ対象へ登録する */
function syncSnapExtra(engine: Engine, model: PageModel): void {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of pageRects(model.spec, model.pages)) {
    xs.push(r.x, r.x + r.w / 2, r.x + r.w);
    ys.push(r.y, r.y + r.h / 2, r.y + r.h);
  }
  engine.snapExtra = { xs, ys };
}

/** 版面マージン（mm）— buildWritingDoc の簡易版面と
    用紙変更時の追従計算（refitWritingAreas）で共用する規約。
    天/地/小口/ノド一律 */
const HANMEN_MARGIN_MM = 20;

/** 執筆モード既定ドキュメント（v0.2）— 第1ページの版面
    （上下左右 HANMEN_MARGIN_MM マージン）を覆う縦書き
    テキストエリア1枚 + それに繋がる連鎖1本。新規作成・初期起動で
    「原稿用紙 + 執筆ペイン」の形に開く。 */
function buildWritingDoc(font: string): {
  model: PageModel;
  objects: WorldObject[];
  chains: Chain[];
} {
  const model = createPages({ size: 'A4', landscape: false }, 1);
  const p = pageRectAt(model.spec, 0);
  const m = HANMEN_MARGIN_MM;
  const areaId = 'ta1';
  return {
    model,
    objects: [
      {
        id: areaId,
        kind: TEXT_KIND,
        x: p.x + m,
        y: p.y + m,
        w: p.w - 2 * m,
        h: p.h - 2 * m,
        style: { stroke: 'rgba(90,110,140,0.4)' },
        // 既定は縦書き（v0.1 の新規エリア既定と同じ）
        data: {
          ...DEFAULT_TEXT_DATA,
          fontFamily: font,
          writing: 'vertical-rl',
          // 自動生成の印 — 用紙変更時の版面追従の判別材料
          // （判定自体は版面矩形との一致で行う。refitWritingAreas 参照）
          auto: true,
        },
      },
    ],
    chains: [{ id: 'c1', areas: [areaId], text: '' }],
  };
}

/** 用紙 spec 変更に伴い、版面を覆うテキストエリアを新しい版面へ追従させる。
    対象 = 旧 spec でいずれかのページ版面（HANMEN_MARGIN_MM 内側）を
    ちょうど覆う TEXT_KIND オブジェクト。判定を data.auto の印ではなく
    版面矩形との一致で行うのは、印のない旧 .slm 書庫・旧下書きの
    自動生成エリアも救済するため（ユーザーが版面ぴったりに置いた
    エリアも追従するが、これは版面エリアとして妥当な挙動とみなす）。
    版面から外れているエリア — auto 印付きでもユーザーが動かしたもの —、
    および画像・その他のオブジェクトは一切触れない。
    追従先は同じページスロットの新 spec での版面矩形。 */
function refitWritingAreas(
  objects: WorldObject[],
  prev: PageModel,
  next: PageModel,
): WorldObject[] {
  const m = HANMEN_MARGIN_MM;
  const eps = 0.01; // mm — 浮動小数の計算誤差を許容
  const prevRects = pageRects(prev.spec, prev.pages);
  return objects.map((o) => {
    if (o.kind !== TEXT_KIND) return o;
    const hit = prevRects.find(
      (r) =>
        Math.abs(o.x - (r.x + m)) <= eps &&
        Math.abs(o.y - (r.y + m)) <= eps &&
        Math.abs(o.w - (r.w - 2 * m)) <= eps &&
        Math.abs(o.h - (r.h - 2 * m)) <= eps,
    );
    if (!hit) return o;
    const p = pageRectAt(next.spec, hit.slot);
    return {
      ...o,
      x: p.x + m,
      y: p.y + m,
      w: p.w - 2 * m,
      h: p.h - 2 * m,
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
  const [initDoc] = useState(() => buildWritingDoc('sans-serif'));
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
  const [pageOpacity, setPageOpacity] = useState(50);
  const [footer, setFooter] = useState(true);
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
  const [docFont, setDocFont] = useState('sans-serif');
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
  // v0.3: ページ番号（ノンブル）— 文書設定。.slm の doc.json へ保存
  const [pageNum, setPageNum] = useState(false);
  // v0.3: 升目の印刷出し分け — 文書設定。既定 ON（WYSIWYG 整合:
  // キャンバスに見える升目はそのまま印刷に出る）
  const [gridPrint, setGridPrint] = useState(true);
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
    docFont: string;
    pageNum: boolean;
    gridPrint: boolean;
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
      objects: [...pageObjects(model), ...initDoc.objects],
    });
    syncSnapExtra(engine, model);
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
      objects: [...pageObjects(next, pageOpacity / 100), ...content],
    });
    syncSnapExtra(engine, next);
  };
  // 用紙サイズ・向きの変更 — 版面を覆う自動生成エリアは
  // 新しい版面へ追従させる（手置きエリアは触らない。refitWritingAreas 参照）
  const applySpec = (spec: PageModel['spec']) => {
    const next = setPaper(model, spec);
    commitPages(next, refitWritingAreas(contentObjects(), model, next));
  };
  const setSize = (size: PaperSize) => applySpec({ ...model.spec, size });
  const toggleLandscape = () =>
    applySpec({ ...model.spec, landscape: !model.spec.landscape });
  const appendPage = () => commitPages(addPage(model));
  const removePage = (id: string) => commitPages(deletePage(model, id));
  const insertAt = (index: number) => {
    const res = insertPage(model, index);
    const content = applyVerticalShift(
      engine.doc.objects.filter((o) => o.kind !== PAGE_KIND),
      res.thresholdY,
      res.dy,
    );
    commitPages({ ...model, pages: res.pages }, content);
  };
  const insertBelow = (index: number) => insertAt(index + 1);
  const removeCurrentPage = () => {
    const r = pageRects(model.spec, model.pages)[curPage];
    if (r) removePage(r.id);
  };

  // ── ファイル操作（.slm 書庫） ──
  const contentObjects = () =>
    engine.doc.objects.filter((o) => o.kind !== PAGE_KIND);

  // ── Undo/Redo（doc＋連鎖＋ページ＋設定の統合スナップショット） ──
  const makeSnap = (): Snap => ({
    objects: contentObjects(),
    chains,
    model,
    footer,
    title: docTitle,
    pageOpacity,
    docFont,
    pageNum,
    gridPrint,
  });
  const applySnap = (s: Snap) => {
    applyingRef.current = true;
    setModel(s.model);
    engine.setDoc({
      ...engine.doc,
      objects: [
        ...pageObjects(s.model, s.pageOpacity / 100),
        ...s.objects,
      ],
    });
    syncSnapExtra(engine, s.model);
    setChains(s.chains);
    setFooter(s.footer);
    setDocTitle(s.title);
    setPageOpacity(s.pageOpacity);
    setDocFont(s.docFont);
    setPageNum(s.pageNum);
    setGridPrint(s.gridPrint);
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
  }, [engine.doc.objects, chains, model, footer, docTitle, pageOpacity, docFont, pageNum, gridPrint]);

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
          footer: true,
          title: '',
          pageOpacity: 50,
          docFont: 'sans-serif',
          pageNum: false,
          gridPrint: true,
        };
        const cur = {
          spec: r.model.spec,
          pages: r.model.pages,
          objects: r.objects,
          chains: r.chains,
          footer: r.footer,
          title: r.title,
          pageOpacity: r.pageOpacity,
          docFont: r.docFont ?? 'sans-serif',
          pageNum: r.pageNum,
          gridPrint: r.gridPrint,
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
          objects: contentObjects(),
          chains,
          footer,
          title: docTitle,
          createdAt: createdAtRef.current,
          pageOpacity,
          docFont,
          pageNum,
          gridPrint,
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
  }, [engine.doc.objects, chains, model, footer, docTitle, pageOpacity, docFont, pageNum, gridPrint]);

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
                fill: `rgba(255,255,255,${pageOpacity / 100})`,
              },
            }
          : o,
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageOpacity]);

  const newDoc = () => {
    if (!window.confirm(t('confirm.new'))) return;
    const d = buildWritingDoc(docFont);
    commitPages(d.model, d.objects);
    setChains(d.chains);
    setWriteChainId(null);
    setFooter(true);
    setDocTitle('');
    setPageOpacity(50);
    setDocFont('sans-serif');
    setPageNum(false);
    setGridPrint(true);
    createdAtRef.current = new Date().toISOString();
    dirtyRef.current = false;
    engine.setSelection([]);
    focusPage(0, d.model);
  };
  const confirmSave = (name: string) => {
    const u8 = packArchive({
      spec: model.spec,
      pages: model.pages,
      objects: contentObjects(),
      chains,
      footer,
      title: docTitle,
      createdAt: createdAtRef.current,
      pageOpacity,
      docFont,
      pageNum,
      gridPrint,
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
    commitPages(r.model, objects);
    setChains(r.chains);
    setWriteChainId(null);
    setFooter(r.footer);
    setDocTitle(r.title);
    setPageOpacity(r.pageOpacity);
    setDocFont(r.docFont ?? 'sans-serif');
    setPageNum(r.pageNum);
    setGridPrint(r.gridPrint);
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
    const onPaper = pageRects(model.spec, model.pages).some(
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
      const idx = pageRects(model.spec, model.pages).findIndex(
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
    localStorage.setItem('kusuma-mode', next ? 'write' : 'layout');
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
  for (const c of chains) {
    const boxes = c.areas.flatMap((id) => {
      const o = objById.get(id);
      if (!o) return [];
      const r = liveRect(engine, o);
      const d = { ...DEFAULT_TEXT_DATA, ...(o.data as TextAreaData) };
      return [
        {
          id,
          width: Math.max(0, r.w - 2 * TEXT_PAD_MM),
          height: Math.max(0, r.h - 2 * TEXT_PAD_MM),
          fontSize: d.fontSize,
          fontFamily: d.fontFamily,
          bold: d.bold,
          italic: d.italic,
          writing: d.writing,
        },
      ];
    });
    layouts.set(
      c.id,
      layoutChain(c.text, boxes, measurerRef.current, c.marks),
    );
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

  // ── ページナビ: アクティブページ（枠クリック or ナビで切替） ──
  const rects = pageRects(model.spec, model.pages);
  const curPage = Math.min(activePage, Math.max(0, rects.length - 1));
  // G1+G2: ページ全体が収まる倍率に調整し、ページ左上（ルーラー原点）を
  // キャンバス左上（ルーラー帯分の余白込み）に合わせる
  const focusPage = (i: number, mdl: PageModel = model) => {
    suppressDblUntil.current = performance.now() + 700;
    setActivePage(i);
    const el = canvasRef.current;
    const p = pageRects(mdl.spec, mdl.pages)[i];
    if (!el || !p) return;
    const pad = 30; // ルーラー帯 + 余白(px)
    const zoom = Math.min(
      4,
      Math.max(
        0.1,
        Math.min(
          (el.clientWidth - pad * 2) / (p.w * MM_PX),
          (el.clientHeight - pad * 2) / (p.h * MM_PX),
        ),
      ),
    );
    const u = MM_PX * zoom;
    engine.viewport = {
      ...engine.viewport,
      zoom,
      x: pad - p.x * u,
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
  // fitVertical に渡る実効ボックスと同じ内寸で割る — 版面矩形
  // （用紙 − HANMEN_MARGIN_MM 四方）からエリア内側余白 TEXT_PAD_MM を
  // 引いた幅・高さ。段ピッチ = fontSize × (1 + RUBY_LANE_RATIO)。
  const hanmenCells = (() => {
    const { w, h } = paperDims(spec);
    const bw = w - 2 * (HANMEN_MARGIN_MM + TEXT_PAD_MM);
    const bh = h - 2 * (HANMEN_MARGIN_MM + TEXT_PAD_MM);
    const pitch = cellFs * (1 + RUBY_LANE_RATIO);
    return {
      v: Math.max(0, Math.floor((bh + 1e-6) / cellFs)),
      h: Math.max(0, Math.floor((bw + 1e-6) / pitch)),
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
          <button
            title={t('page.insertAfter')}
            onClick={() => insertBelow(d.index)}
          >
            ＋
          </button>
          <button title={t('page.delete')} onClick={() => removePage(o.id)}>
            ×
          </button>
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
                    ...alignStyle,
                  } as React.CSSProperties)
                : alignStyle
            }
          >
            {vertical
              ? vunitSpans(units!, vStyleOf)
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
          {/* N-19: 上下スクロール（ホイールパン不慣れ対策のフローティングUI） */}
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
            font: docFont,
            onFont: setDocFont,
            pageNum,
            onPageNum: setPageNum,
            gridPrint,
            onGridPrint: setGridPrint,
            hanmenCells,
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
          objects={engine.doc.objects}
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
