import { useState } from 'react';
import { firstFamily, FONT_PRESETS, fontStackFor, missingFont } from './fonts';
import type { TFunc } from './i18n';

/** フォント選択UI — sethera-piece 方式（文書既定・エリア・
    選択範囲マーク共通）。推奨プリセット＋「カスタム…」自由入力。
    保存値は常に font-family スタック文字列（カスタム名は
    既定スタックをフォールバックに連結） */
export function FontPick({
  value,
  onPick,
  t,
  placeholder,
}: {
  /** 現在値（スタック or カスタム名）。'' は未選択の表示用 */
  value: string;
  onPick: (stack: string) => void;
  t: TFunc;
  /** 先頭に出す未選択オプションのラベル（一括適用セレクト等） */
  placeholder?: string;
}) {
  const isCustom =
    !!value && !FONT_PRESETS.some((f) => f.stack === value);
  // セレクトの表示モード。null=値から導出（カスタム選択直後の
  // 未入力状態を保持するためのローカルモード）
  const [mode, setMode] = useState<string | null>(null);
  const [draft, setDraft] = useState(isCustom ? firstFamily(value) : '');
  const selValue = mode ?? (isCustom ? '__custom' : value);
  const customOpen = selValue === '__custom';
  const commit = () => {
    const v = draft.trim();
    if (v && fontStackFor(v) !== value) onPick(fontStackFor(v));
  };
  const missing =
    customOpen && draft.trim() !== '' && missingFont(draft);

  return (
    <>
      <select
        value={selValue}
        onChange={(e) => {
          const v = e.currentTarget.value;
          setMode(v === '__custom' ? '__custom' : null);
          if (v === '__custom') {
            if (isCustom) setDraft(firstFamily(value));
            return;
          }
          if (v !== '') onPick(v);
        }}
      >
        {placeholder !== undefined && (
          <option value="">{placeholder}</option>
        )}
        {FONT_PRESETS.map((f) => (
          <option key={f.key} value={f.stack} style={{ fontFamily: f.stack }}>
            {f.label}
          </option>
        ))}
        <option value="__custom">{t('font.custom')}</option>
      </select>
      {customOpen && (
        <>
          <input
            value={draft}
            placeholder={t('font.customPh')}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
            }}
          />
          {missing && (
            <span className="dim" title={t('font.missing')}>
              ⚠
            </span>
          )}
        </>
      )}
    </>
  );
}
