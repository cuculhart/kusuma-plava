// 連鎖編集ペイン — 右ペインの連鎖テキスト欄。
// 編集対象は常に連鎖テキスト1本（エリア内直接編集は持たない）。
// IME 確定・キャレット維持・順序崩れの問題が構造的に消える設計。
// 選択範囲への部分装飾（TextMark）とインストール済みフォント列挙を持つ。

import { useLayoutEffect, useRef, useState } from 'react';
import { sliceRuns, type Chain, type TextAttrs } from 'inimbal';
import type { TFunc } from './i18n';
import { tf } from './i18n';
import type { TextAreaData } from './types';
import { DEFAULT_TEXT_DATA, FONT_SIZES_MM } from './types';
import { FontPick } from './FontPick';

// textarea のキャレット位置へスクロールする — ブラウザの
// caret-into-view は環境依存で効かないため、同じスタイルの
// 不可視 div で文字位置を実測して scrollTop を直接設定する
// （禁則処理やぶら下がり空白も含め実際の折返しを測れる
// 定番手法 — canvas シミュレートでは行折り規則を再現しきれない）
const scrollTaToCaret = (el: HTMLTextAreaElement, pos: number) => {
  const div = document.createElement('div');
  const cs = getComputedStyle(el);
  // textarea-caret-position 定番のプロパティ一式 — フォント
  // メトリクス・パディング・ラップ挙動を完全に揃えないと
  // 長文では行数ぶん誤差が蓄積する
  const props = [
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'borderStyle',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'fontStyle',
    'fontVariant',
    'fontWeight',
    'fontStretch',
    'fontSize',
    'fontSizeAdjust',
    'lineHeight',
    'fontFamily',
    'textAlign',
    'textTransform',
    'textIndent',
    'textDecoration',
    'letterSpacing',
    'wordSpacing',
    'tabSize',
    'fontKerning',
    'fontFeatureSettings',
    'fontVariantEastAsian',
    'textRendering',
    'wordBreak',
    'overflowWrap',
    'lineBreak',
    'direction',
    'unicodeBidi',
    'textSizeAdjust',
  ];
  for (const p of props) div.style.setProperty(p, cs.getPropertyValue(p));
  // 幅は css width ではなく clientWidth − padding を使う —
  // 縦スクロールバー分の差で折返し位置が変わる
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  div.style.boxSizing = 'content-box';
  div.style.width = `${el.clientWidth - padL - padR}px`;
  div.style.whiteSpace = 'pre-wrap';
  if (!cs.overflowWrap || cs.overflowWrap === 'normal')
    div.style.overflowWrap = 'break-word';
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.textContent = el.value.slice(0, pos);
  const marker = document.createElement('span');
  marker.textContent = el.value.slice(pos, pos + 1) || 'x';
  div.appendChild(marker);
  // 全文を入れて総高さを比べ、比率で位置を自己補正する —
  // 環境差で発生する折返しの系統的誤差は el/div の
  // scrollHeight 比で打ち消せる（pos までの部分だけでは
  // 比較できないため全文が必須）
  div.appendChild(document.createTextNode(el.value.slice(pos + 1)));
  document.body.appendChild(div);
  const ratio =
    div.scrollHeight > 0 ? el.scrollHeight / div.scrollHeight : 1;
  el.scrollTop = Math.max(
    0,
    marker.offsetTop * ratio - el.clientHeight / 2,
  );
  div.remove();
};

export function ChainPane({
  chain,
  /** ペインを開いたエリア（フォント等はこのエリア単位） */
  areaData,
  overflow,
  onText,
  onApplyMark,
  onClearMarks,
  onAreaData,
  onClose,
  indent,
  onIndent,
  goal,
  onGoal,
  chains,
  onPickChain,
  writeMode,
  onCaret,
  onGotoText,
  onJumpSel,
  textJump,
  t,
}: {
  chain: Chain;
  areaData: TextAreaData | null;
  overflow: string;
  onText: (text: string) => void;
  /** 選択範囲 [s,e) への部分装飾適用 */
  onApplyMark: (s: number, e: number, attrs: Partial<TextAttrs>) => void;
  /** 選択範囲 [s,e) 内の装飾マーク除去 */
  onClearMarks: (s: number, e: number) => void;
  onAreaData: (patch: Partial<TextAreaData>) => void;
  onClose: () => void;
  /** 字下げ — Enter の段落頭に全角スペースを自動挿入（v0.2） */
  indent: boolean;
  onIndent: (v: boolean) => void;
  /** 目標字数（v0.3）— 正準値は字数。0 = 未設定（枚数側は ×400 で畳む） */
  goal: number;
  onGoal: (chars: number) => void;
  /** 連鎖タブ（複数連鎖時の切替 + 連鎖別字数）。未指定なら非表示 */
  chains?: Chain[];
  onPickChain?: (chainId: string) => void;
  /** 執筆モード — 選択範囲装飾行・字サイズ欄・エリアリンクを畳む（v0.6。
      字サイズは文書設定の升目仕様が自動決定するため触らせない） */
  writeMode?: boolean;
  /** 連鎖テキスト ⇄ ページ双方向シンク（執筆モードのみ）。
      onCaret = テキスト→ビュー（キャレット位置のページへ移動）、
      onGotoText = ビュー→テキスト（現ページ先頭文字へキャレット）、
      textJump = App からのジャンプ要求 */
  onCaret?: (pos: number) => void;
  onGotoText?: () => void;
  /** 検索ジャンプも「文」と同じ経路へ — App 側 textJump に
      乗せて統一（選択範囲 s..e を渡す） */
  onJumpSel?: (s: number, e: number) => void;
  textJump?: { s: number; e: number; n: number };
  t: TFunc;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  // 選択範囲はボタン押下でフォーカスが外れても保持するため state で記憶
  const [sel, setSel] = useState<{ s: number; e: number }>({ s: 0, e: 0 });
  const [markColor, setMarkColor] = useState('#222222');


  // 選択開始位置の実効色（マーク後勝ち → エリア既定へフォールバック）
  const colorAt = (pos: number) => {
    const base: TextAttrs = { ...DEFAULT_TEXT_DATA, ...areaData };
    return (
      sliceRuns(chain.text[pos] ?? 'x', chain.marks, pos, base)[0]?.attrs
        .color ??
      base.color ??
      '#222222'
    );
  };

  const syncSel = () => {
    const el = taRef.current;
    if (!el) return;
    setSel({ s: el.selectionStart, e: el.selectionEnd });
    if (el.selectionEnd > el.selectionStart)
      setMarkColor(colorAt(el.selectionStart));
    // テキスト→ビューシンク — 入力・クリック・カーソル移動で
    // キャレット位置のページへビューを連れて行く（v0.8）
    onCaret?.(el.selectionStart);
  };

  // ビュー→テキストシンク — ページ送り側が現ページ先頭文字の
  // textJump を投げてくる。focus() でキャレット位置へスクロール
  const lastJump = useRef(0);
  useLayoutEffect(() => {
    const el = taRef.current;
    if (el && textJump && textJump.n !== lastJump.current) {
      lastJump.current = textJump.n;
      // まずミラー計測で近似位置へ — その後 selection を設定する。
      // フォーカス済み要素への selection 変更はブラウザが
      // キャレットへ正確にスクロールするため、効く環境では
      // ネイティブ位置が最終決定になる（ミラーは効かない
      // 環境向けのフォールバック）
      scrollTaToCaret(el, textJump.s);
      el.focus();
      el.selectionStart = textJump.s;
      el.selectionEnd = textJump.e;
      el.blur();
      el.focus();
      // プログラム的 selection 変更は onSelect を発火しないため
      // ビューシンクを明示通知（文/検索ジャンプでビューが追従）
      onCaret?.(el.selectionStart);
    }
  }, [textJump]);

  const hasSel = sel.e > sel.s;
  const apply = (attrs: Partial<TextAttrs>) =>
    hasSel && onApplyMark(sel.s, sel.e, attrs);


  // ── v0.2 執筆補助 ──
  // 字下げ・話区切りで差し込んだ文字の後へキャレットを戻すための退避
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = taRef.current;
    if (el && pendingCaret.current != null) {
      el.selectionStart = el.selectionEnd = pendingCaret.current;
      pendingCaret.current = null;
    }
  }, [chain.text]);

  // 字下げ: 「\n1字の挿入」のみを検出して直後に全角スペースを差す
  // （入力時適用 — 既存テキストへは遡及しない。ペースト・範囲置換・
  // IME 変換中は素通し）。縦書きエリアのみ有効
  const onTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    let v = el.value;
    const pos = el.selectionStart;
    const vertical =
      (areaData?.writing ?? 'vertical-rl') === 'vertical-rl';
    if (
      indent &&
      vertical &&
      !(e.nativeEvent as InputEvent).isComposing &&
      v.length === chain.text.length + 1
    ) {
      const nl = v.lastIndexOf('\n', pos - 1);
      if (
        nl >= 0 &&
        v === chain.text.slice(0, nl) + '\n' + chain.text.slice(nl)
      ) {
        const after = v.slice(nl + 1);
        // 次行が既に全角スペース始まり or 空行（連続改行）なら挿さない
        if (after === '' || (after[0] !== '　' && after[0] !== '\n')) {
          v = `${v.slice(0, nl + 1)}　${after}`;
          pendingCaret.current = pos + 1;
        }
      }
    }
    onText(v);
  };

  // 話区切り — キャレット位置にマーカー行を差し込む（構造は持たない）
  const insertBreak = (mark: '＊' | '◇') => {
    const el = taRef.current;
    const s = el ? el.selectionStart : chain.text.length;
    const e = el ? el.selectionEnd : s;
    const before = chain.text.slice(0, s);
    // 行頭に揃える — 直前が改行済みか文頭なら改行を足さない
    const ins = `${before === '' || before.endsWith('\n') ? '' : '\n'}${mark}\n`;
    pendingCaret.current = s + ins.length;
    onText(before + ins + chain.text.slice(e));
    el?.focus();
  };

  // ルビ挿入 — 選択があれば ｜選択《》 へ包み、無ければ《》だけ
  // 挿入（直前の漢字連続へ暗黙に掛かる）。キャレットは《》内へ
  // 置いてそのままヨミを打てる
  const insertRuby = () => {
    const el = taRef.current;
    const s = el ? el.selectionStart : chain.text.length;
    const e = el ? el.selectionEnd : s;
    const sel = chain.text.slice(s, e);
    const ins = sel ? `｜${sel}《》` : '《》';
    pendingCaret.current = s + ins.length - 1;
    onText(chain.text.slice(0, s) + ins + chain.text.slice(e));
    el?.focus();
  };

  // ── v0.3: 検索・置換 — アクティブ連鎖のテキストだけを対象にする
  // （textarea 文字列操作の範囲。キャンバスは再レイアウトで自動追従） ──
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [repl, setRepl] = useState('');
  const [curHit, setCurHit] = useState(-1); // 選択中の一致 index
  // 置換後にテキストをまたいで選択範囲を復帰するための退避
  const pendingSel = useRef<{ s: number; e: number } | null>(null);
  useLayoutEffect(() => {
    const el = taRef.current;
    if (el && pendingSel.current) {
      el.selectionStart = pendingSel.current.s;
      el.selectionEnd = pendingSel.current.e;
      pendingSel.current = null;
    }
  }, [chain.text]);

  // 一致位置の全列挙 — 素朴な indexOf 走査（原稿規模なら十分軽い）
  const hits: number[] = [];
  if (query) {
    for (
      let i = chain.text.indexOf(query);
      i >= 0;
      i = chain.text.indexOf(query, i + Math.max(1, query.length))
    ) {
      hits.push(i);
    }
  }

  const pick = (i: number) => {
    const el = taRef.current;
    if (!el || i < 0 || i >= hits.length) return;
    // 「文」と同じジャンプ経路に統一（App 側 textJump）—
    // 選択範囲の設定とスクロールを一本化して挙動を揃える
    onJumpSel?.(hits[i], hits[i] + query.length);
    if (!onJumpSel) {
      el.selectionStart = hits[i];
      el.selectionEnd = hits[i] + query.length;
      scrollTaToCaret(el, hits[i]);
      el.blur();
      el.focus();
    }
    setCurHit(i);
  };
  // 選択がいずれかの一致上にあるか（入力直後の自動選択状態）
  const selHitIdx = () =>
    hits.findIndex((h) => h === (taRef.current?.selectionStart ?? -1));
  const goNext = () => {
    if (!hits.length) return;
    // ナビ未実行（-/N）かつ選択が一致上にあるなら、それを
    // 現在地として表示する — 次の一致へ飛ばさない
    const on = selHitIdx();
    if (curHit < 0 && on >= 0) return pick(on);
    const pos = taRef.current?.selectionEnd ?? 0;
    const i = hits.findIndex((h) => h >= pos);
    pick(i >= 0 ? i : 0); // 末尾を越えたら先頭へ回る
  };
  const goPrev = () => {
    if (!hits.length) return;
    const on = selHitIdx();
    if (curHit < 0 && on >= 0) return pick(on);
    const pos = taRef.current?.selectionStart ?? chain.text.length;
    let i = -1;
    for (let k = hits.length - 1; k >= 0; k--) {
      if (hits[k] < pos) {
        i = k;
        break;
      }
    }
    pick(i >= 0 ? i : hits.length - 1); // 先頭より前なら末尾へ回る
  };
  const replaceOne = () => {
    if (!query || !hits.length) return;
    const el = taRef.current;
    // 現在選択が一致そのものならそれを、違えばキャレット以降の
    // 最初の一致を置換する
    let s = -1;
    if (
      el &&
      el.selectionEnd - el.selectionStart === query.length &&
      chain.text.slice(el.selectionStart, el.selectionEnd) === query
    ) {
      s = el.selectionStart;
    } else {
      const pos = el?.selectionEnd ?? 0;
      const i = hits.findIndex((h) => h >= pos);
      s = hits[i >= 0 ? i : 0];
    }
    pendingSel.current = { s, e: s + repl.length };
    setCurHit(-1);
    onText(chain.text.slice(0, s) + repl + chain.text.slice(s + query.length));
  };
  const replaceAll = () => {
    if (!query || !hits.length) return;
    setCurHit(-1);
    onText(chain.text.split(query).join(repl));
  };
  const openFind = () => {
    // テキスト側の選択を初期クエリにする（改行を跨ぐ長選択は除外）
    const el = taRef.current;
    if (el && el.selectionEnd > el.selectionStart) {
      const v = chain.text.slice(el.selectionStart, el.selectionEnd);
      if (v.length <= 60 && !v.includes('\n')) setQuery(v);
    }
    setCurHit(-1);
    setFindOpen(true);
  };

  // 字数 — 原稿用紙換算は 400字=1枚（作家の共通言語）。
  // サロゲート対を1字に数えるためコードポイントで数える
  const total = [...chain.text].length;
  const selCount = hasSel
    ? [...chain.text.slice(sel.s, sel.e)].length
    : 0;
  const sheets = (total / 400).toFixed(1);

  // v0.10: 話区切り・見出しの一覧 — ＊/◇ のマーカー行と青空の
  // 見出し注記行を拾い、クリックでその位置へジャンプする。
  // 章・場面の構造化の入口（字数集計は未対応）
  const outline = (() => {
    const items: { pos: number; mark: string; label: string }[] = [];
    let off = 0;
    const lines = chain.text.split('\n');
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const bm = /^([＊◇]+)\s*$/.exec(line);
      const hm = /［＃「(.{1,30})」は[大中小]見出し］/.exec(line);
      if (bm) {
        const next = lines[li + 1]?.trim().slice(0, 24) ?? '';
        items.push({ pos: off, mark: bm[1], label: next });
      } else if (hm) {
        items.push({ pos: off, mark: '◆', label: hm[1] });
      }
      off += line.length + 1;
    }
    // v0.11: 区間の字数 — 次の区切りまでの文字数（話ごとの
    // 分量を見る。末尾区切りは文末まで）
    return items.map((it, i) => ({
      ...it,
      count:
        (i + 1 < items.length ? items[i + 1].pos : chain.text.length) -
        it.pos,
    }));
  })();
  const jumpTo = (pos: number) => {
    const el = taRef.current;
    onJumpSel?.(pos, pos);
    if (el) {
      el.selectionStart = el.selectionEnd = pos;
      scrollTaToCaret(el, pos);
      el.blur();
      el.focus();
      onCaret?.(pos);
    }
  };

  return (
    <aside className="chain-pane">
      {/* 複数連鎖の切替タブ（連鎖別字数つき） */}
      {chains && chains.length > 1 && (
        <div className="chain-tabs">
          {chains.map((c, i) => (
            <button
              key={c.id}
              className={c.id === chain.id ? 'on' : ''}
              onClick={() => onPickChain?.(c.id)}
            >
              {tf(t, 'chain.tab', i + 1, [...c.text].length)}
            </button>
          ))}
        </div>
      )}
      <header>
        <span>{tf(t, 'chain.title', chain.areas.length)}</span>
        {/* × は組版モードのみ（選択解除）— 執筆モードは外側の
            details で縦に畳むので不要 */}
        {!writeMode && (
          <button onClick={onClose} title={t('chain.close')}>
            ×
          </button>
        )}
      </header>
      {/* v0.3: 検索・置換バー — この連鎖のテキストだけを対象にする */}
      {findOpen && (
        <div className="find-bar">
          <input
            className="find-q"
            value={query}
            placeholder={t('find.placeholder')}
            autoFocus
            onChange={(e) => {
              const v = e.currentTarget.value;
              setQuery(v);
              setCurHit(-1);
              // 入力中も最初の一致へキャレットを動かす
              // （ブラウザのページ内検索と同じ感覚）
              const el = taRef.current;
              if (!v || !el) return;
              const i = chain.text.indexOf(v, el.selectionStart);
              const idx = i >= 0 ? i : chain.text.indexOf(v);
              if (idx >= 0) {
                el.selectionStart = idx;
                el.selectionEnd = idx + v.length;
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) goPrev();
                else goNext();
              }
              if (e.key === 'Escape') setFindOpen(false);
            }}
          />
          <span className="find-count">
            {tf(
              t,
              'find.count',
              curHit >= 0 && curHit < hits.length ? curHit + 1 : '–',
              hits.length,
            )}
          </span>
          <button
            title={t('find.prev')}
            disabled={!hits.length}
            onMouseDown={(e) => e.preventDefault()}
            onClick={goPrev}
          >
            ↑
          </button>
          <button
            title={t('find.next')}
            disabled={!hits.length}
            onMouseDown={(e) => e.preventDefault()}
            onClick={goNext}
          >
            ↓
          </button>
          <input
            className="find-r"
            value={repl}
            placeholder={t('find.replace')}
            onChange={(e) => setRepl(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') replaceOne();
              if (e.key === 'Escape') setFindOpen(false);
            }}
          />
          {/* mousedown preventDefault: ボタンにフォーカスが
              残ると Enter で再発火してしまうため */}
          <button
            disabled={!hits.length}
            onMouseDown={(e) => e.preventDefault()}
            onClick={replaceOne}
          >
            {t('find.replaceOne')}
          </button>
          <button
            disabled={!hits.length}
            onMouseDown={(e) => e.preventDefault()}
            onClick={replaceAll}
          >
            {t('find.replaceAll')}
          </button>
          <button
            title={t('chain.close')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setFindOpen(false)}
          >
            ×
          </button>
        </div>
      )}
      <textarea
        ref={taRef}
        className="chain-text"
        value={chain.text}
        spellCheck={false}
        placeholder={t('chain.placeholder')}
        onChange={onTextChange}
        onSelect={syncSel}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            openFind();
          }
        }}
      />
      {/* 執筆ツール — 検索 / 話区切り / 字下げ / 字数 */}
      <div className="chain-tools">
        <button title={t('find.open')} onClick={() => setFindOpen((v) => !v)}>
          検
        </button>
        <button title={t('write.breakTip')} onClick={() => insertBreak('＊')}>
          ＊
        </button>
        <button title={t('write.breakTip')} onClick={() => insertBreak('◇')}>
          ◇
        </button>
        <button title={t('write.rubyTip')} onClick={insertRuby}>
          ｜《
        </button>
        {/* ビュー⇄テキストのシンクボタン（執筆モード） */}
        {onCaret && (
          <button
            title={t('chain.toPage')}
            onClick={() => onCaret(taRef.current?.selectionStart ?? 0)}
          >
            頁
          </button>
        )}
        {onGotoText && (
          <button title={t('chain.toText')} onClick={onGotoText}>
            文
          </button>
        )}
        <label title={t('write.indentTip')}>
          <input
            type="checkbox"
            checked={indent}
            onChange={(e) => onIndent(e.currentTarget.checked)}
          />
          {t('write.indent')}
        </label>
        <span className="chain-count">
          {tf(t, 'write.count', total, sheets)}
          {hasSel ? ` · ${tf(t, 'write.sel', selCount)}` : ''}
          {/* デバッグ: キャレット位置（生 text index・行番号） */}
          {` · #${sel.s} L${chain.text.slice(0, sel.s).split('\n').length}`}
        </span>
      </div>
      {/* v0.3: 目標字数 + 進捗 — 正準値は字数。枚数入力は ×400 で
          畳み込む（400字詰N枚は作家の共通言語） */}
      <div className="chain-goal">
        <span className="goal-label">{t('write.goal')}</span>
        <input
          type="number"
          min={0}
          step={100}
          value={goal || ''}
          placeholder="0"
          title={t('write.goalCharsTip')}
          onChange={(e) =>
            onGoal(Math.max(0, +e.currentTarget.value || 0))
          }
        />
        <span>{t('write.goalChars')}</span>
        <input
          type="number"
          min={0}
          step={1}
          value={goal ? +(goal / 400).toFixed(1) : ''}
          placeholder="0"
          title={t('write.goalSheetsTip')}
          onChange={(e) =>
            onGoal(Math.max(0, Math.round((+e.currentTarget.value || 0) * 400)))
          }
        />
        <span>{t('write.goalSheets')}</span>
        {goal > 0 && (
          <>
            <span className="goal-bar" title={t('write.goalTip')}>
              <span
                className="goal-fill"
                style={{
                  width: `${Math.min(100, (total / goal) * 100)}%`,
                }}
              />
            </span>
            <span className="goal-text">
              {tf(
                t,
                'write.progress',
                total.toLocaleString(),
                goal.toLocaleString(),
                (total / 400).toFixed(1),
                (goal / 400).toFixed(1),
              )}
            </span>
          </>
        )}
      </div>
      {/* v0.10: 話区切り・見出し一覧 — クリックでその位置へ */}
      {outline.length > 0 && (
        <details className="chain-outline">
          <summary>
            {t('chain.outline')} ({outline.length})
          </summary>
          {outline.map((s, i) => (
            <button key={i} onClick={() => jumpTo(s.pos)}>
              {s.mark} {s.label}{' '}
              <span className="outline-count">{s.count}字</span>
            </button>
          ))}
        </details>
      )}
      {overflow && (
        <div className="chain-overflow">
          {tf(
            t,
            'chain.overflow',
            overflow.length,
            overflow.replace(/\n/g, '⏎').slice(0, 14),
          )}
        </div>
      )}
      {/* 選択範囲の B/I/U は執筆モードでも使う。色・サイズ・書体・
          リンクは組版モードの仕事 — 執筆モードでは畳む（v0.6） */}
      <div className="chain-marks">
        <span className="chain-marks-label">{t('chain.mark')}</span>
        <button disabled={!hasSel} onClick={() => apply({ bold: true })}>
          B
        </button>
        <button disabled={!hasSel} onClick={() => apply({ italic: true })}>
          I
        </button>
        <button disabled={!hasSel} onClick={() => apply({ underline: true })}>
          U
        </button>
        {!writeMode && (
        <>
        <input
          type="color"
          disabled={!hasSel}
          title={t('font.color')}
          value={markColor}
          // ダイアログを開いた時点で表示色を適用（同色確定の Enter でも
          // change が出ないため）。別色を選べば change で上書き適用される。
          onFocus={() => hasSel && apply({ color: markColor })}
          onChange={(e) => {
            setMarkColor(e.currentTarget.value);
            apply({ color: e.currentTarget.value });
          }}
        />
        <select
          disabled={!hasSel}
          value=""
          title={t('chain.size')}
          onChange={(e) => {
            if (e.currentTarget.value)
              apply({ fontSize: Number(e.currentTarget.value) });
          }}
        >
          <option value="">—</option>
          {FONT_SIZES_MM.map((s) => (
            <option key={s} value={s}>
              {s}mm
            </option>
          ))}
        </select>
        <span
          className="chain-marks-font"
          style={{ pointerEvents: hasSel ? undefined : 'none', opacity: hasSel ? 1 : 0.5 }}
        >
          <FontPick
            value=""
            onPick={(s) => apply({ fontFamily: s })}
            t={t}
            placeholder={t('chain.markFont')}
          />
        </span>
        <input
          className="chain-marks-link"
          type="url"
          disabled={!hasSel}
          placeholder={t('chain.markLink')}
          onKeyDown={(e) => {
            const v = e.currentTarget.value.trim();
            if (e.key === 'Enter' && v) {
              // スキーム省略は https 補完（PDFのリンク注釈化に必要）
              apply({ link: /^[a-z]+:/i.test(v) ? v : `https://${v}` });
              e.currentTarget.value = '';
            }
          }}
        />
        </>
        )}
        {/* 書式解除は執筆モードでも必要 — B/I/U を戻せないと詰む */}
        <button
          disabled={!hasSel}
          onClick={() => onClearMarks(sel.s, sel.e)}
        >
          {t('chain.markClear')}
        </button>
      </div>
      {areaData && (
        <div className="chain-font">
          {/* 書体は執筆モードでは畳む（v0.8）— 本文書体は文書設定の
              「既定フォント」が全エリアへ一括適用する。1連鎖が複数
              ページへ跨ぐのに連鎖先頭エリアだけを変える選択肢は
              誤適用のもと。組版モードでは従来どおりエリア単位で編集可 */}
          {!writeMode && (
          <label>
            {t('chain.font')}
            <FontPick
              value={areaData.fontFamily}
              onPick={(s) => onAreaData({ fontFamily: s })}
              t={t}
            />
          </label>
          )}
          {/* 字サイズは文書設定の升目仕様（縦×横）が自動決定するため
              執筆モードでは畳む（v0.6）— 組版モードでは従来どおり編集可 */}
          {!writeMode && (
          <label>
            {t('chain.size')}
            <select
              value={areaData.fontSize}
              onChange={(e) =>
                onAreaData({ fontSize: Number(e.currentTarget.value) })
              }
            >
              {FONT_SIZES_MM.map((s) => (
                <option key={s} value={s}>
                  {s}mm
                </option>
              ))}
            </select>
          </label>
          )}
          <label>
            {t('font.color')}
            <input
              type="color"
              value={areaData.color ?? '#222222'}
              onChange={(e) => onAreaData({ color: e.currentTarget.value })}
            />
          </label>
          {/* エリア全体の B/I/U は組版モードの仕事 — 執筆モードでは畳む */}
          {!writeMode && (
          <>
          <label>
            B
            <input
              type="checkbox"
              checked={!!areaData.bold}
              onChange={(e) => onAreaData({ bold: e.currentTarget.checked })}
            />
          </label>
          <label>
            I
            <input
              type="checkbox"
              checked={!!areaData.italic}
              onChange={(e) => onAreaData({ italic: e.currentTarget.checked })}
            />
          </label>
          <label>
            U
            <input
              type="checkbox"
              checked={!!areaData.underline}
              onChange={(e) =>
                onAreaData({ underline: e.currentTarget.checked })
              }
            />
          </label>
          </>
          )}
          {/* エリア単位リンクも組版モードの仕事 — 執筆モードでは畳む */}
          {!writeMode && (
          <label>
            {t('chain.areaLink')}
            <input
              type="url"
              className="chain-area-link"
              value={areaData.link ?? ''}
              placeholder="https://…"
              onChange={(e) =>
                onAreaData({ link: e.currentTarget.value || undefined })
              }
              onBlur={(e) => {
                const v = e.currentTarget.value.trim();
                if (v && !/^[a-z]+:/i.test(v))
                  onAreaData({ link: `https://${v}` });
              }}
            />
          </label>
          )}
        </div>
      )}
      <footer className="chain-links">
        {chain.areas.length > 1
          ? chain.areas.length > 10
            ? // 長大な連鎖は途中を省略 — ドックを埋め尽くさない
              `${chain.areas.slice(0, 8).join(' → ')} → … → ${
                chain.areas[chain.areas.length - 1]
              }（${chain.areas.length}）`
            : `${chain.areas.join(' → ')}`
          : t('chain.nolink')}
      </footer>
    </aside>
  );
}
