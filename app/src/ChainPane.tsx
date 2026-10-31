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
import { fontOptions, useSysFonts } from './useSysFonts';

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
  chains,
  onPickChain,
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
  /** 連鎖タブ（複数連鎖時の切替 + 連鎖別字数）。未指定なら非表示 */
  chains?: Chain[];
  onPickChain?: (chainId: string) => void;
  t: TFunc;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  // 選択範囲はボタン押下でフォーカスが外れても保持するため state で記憶
  const [sel, setSel] = useState<{ s: number; e: number }>({ s: 0, e: 0 });
  const [markColor, setMarkColor] = useState('#222222');
  const sysFonts = useSysFonts();

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
  };

  const hasSel = sel.e > sel.s;
  const apply = (attrs: Partial<TextAttrs>) =>
    hasSel && onApplyMark(sel.s, sel.e, attrs);
  // 既定3種 + インストール済みフォント（queryLocalFonts が取れた場合）
  const fonts = fontOptions(sysFonts);

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

  // 字数 — 原稿用紙換算は 400字=1枚（作家の共通言語）。
  // サロゲート対を1字に数えるためコードポイントで数える
  const total = [...chain.text].length;
  const selCount = hasSel
    ? [...chain.text.slice(sel.s, sel.e)].length
    : 0;
  const sheets = (total / 400).toFixed(1);

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
        <button onClick={onClose} title={t('chain.close')}>
          ×
        </button>
      </header>
      <textarea
        ref={taRef}
        className="chain-text"
        value={chain.text}
        spellCheck={false}
        placeholder={t('chain.placeholder')}
        onChange={onTextChange}
        onSelect={syncSel}
      />
      {/* 執筆ツール — 話区切り / 字下げ / 字数 */}
      <div className="chain-tools">
        <button title={t('write.breakTip')} onClick={() => insertBreak('＊')}>
          ＊
        </button>
        <button title={t('write.breakTip')} onClick={() => insertBreak('◇')}>
          ◇
        </button>
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
        </span>
      </div>
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
        <select
          className="chain-marks-font"
          disabled={!hasSel}
          value=""
          title={t('chain.markFont')}
          onChange={(e) => {
            if (e.currentTarget.value)
              apply({ fontFamily: e.currentTarget.value });
          }}
        >
          <option value="">{t('chain.markFont')}</option>
          {fonts.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
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
        <button
          disabled={!hasSel}
          onClick={() => onClearMarks(sel.s, sel.e)}
        >
          {t('chain.markClear')}
        </button>
      </div>
      {areaData && (
        <div className="chain-font">
          <label>
            {t('chain.font')}
            <select
              className="chain-font-family"
              value={areaData.fontFamily}
              onChange={(e) =>
                onAreaData({ fontFamily: e.currentTarget.value })
              }
            >
              {[...new Set([areaData.fontFamily, ...fonts])].map(
                (f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ),
              )}
            </select>
          </label>
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
          <label>
            {t('font.color')}
            <input
              type="color"
              value={areaData.color ?? '#222222'}
              onChange={(e) => onAreaData({ color: e.currentTarget.value })}
            />
          </label>
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
        </div>
      )}
      <footer className="chain-links">
        {chain.areas.length > 1
          ? `${chain.areas.join(' → ')}`
          : t('chain.nolink')}
      </footer>
    </aside>
  );
}
