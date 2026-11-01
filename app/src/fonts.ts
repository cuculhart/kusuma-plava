// フォント選択肢 — sethera-piece 方式: 推奨プリセット（フォール
// バックスタック付き）＋カスタム名の自由入力。システム列挙には
// 頼らない（queryLocalFonts が環境で不安定なため）。カスタム書体
// は未所持でも末尾の既定スタックへフォールバックして読める。

import { DEFAULT_FONT_FAMILY } from './types';

export const FONT_PRESETS: { key: string; label: string; stack: string }[] =
  [
    { key: 'mincho', label: '明朝', stack: DEFAULT_FONT_FAMILY },
    {
      key: 'gothic',
      label: 'ゴシック',
      stack:
        "'Noto Sans JP', 'Yu Gothic', 'Hiragino Kaku Gothic ProN', sans-serif",
    },
    {
      key: 'kyokasho',
      label: '教科書体',
      stack:
        "'UD Digi Kyokasho NP-R', 'UD デジタル 教科書体 NP-R', 'UD Digi Kyokasho N-R', 'Yu Gothic', sans-serif",
    },
    {
      key: 'maru',
      label: '丸ゴシック',
      stack:
        "'Zen Maru Gothic', 'Hiragino Maru Gothic ProN', 'Yu Gothic', sans-serif",
    },
  ];

/** 選択値 → 保存用 font-family 値。プリセットはスタック、カスタム名は
    先頭に置いて既定スタックをフォールバックとして連結する */
export function fontStackFor(pick: string): string {
  const known = FONT_PRESETS.find(
    (f) => f.stack === pick || f.key === pick,
  );
  if (known) return known.stack;
  const name = pick.replace(/'/g, '').trim();
  return `'${name}', ${DEFAULT_FONT_FAMILY}`;
}

/** 保存値 → カスタム入力欄へ出すファミリ名（スタックの先頭成分） */
export function firstFamily(spec: string): string {
  return spec.split(',')[0].replace(/'/g, '').trim();
}

/** プリセットでない書体指定が環境に未インストールか —
    document.fonts.check で判定。未対応環境では false（警告しない） */
export function missingFont(spec: string): boolean {
  if (typeof document === 'undefined' || !document.fonts?.check)
    return false;
  if (FONT_PRESETS.some((f) => f.stack === spec)) return false;
  return !document.fonts.check(`12px "${firstFamily(spec)}"`);
}
