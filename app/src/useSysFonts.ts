// インストール済みフォント列挙 — Font Access API（Chromium 限定）。
// 非対応・権限拒否時は空配列のまま（呼び出し側は既定リストへ落ちる）。

import { useEffect, useState } from 'react';
import { FONT_FAMILIES } from './types';

export function useSysFonts(): string[] {
  const [sysFonts, setSysFonts] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    const query = (
      window as { queryLocalFonts?: () => Promise<{ family: string }[]> }
    ).queryLocalFonts;
    if (!query) return;
    query
      .call(window)
      .then((faces) => {
        if (cancelled) return;
        setSysFonts(
          [...new Set(faces.map((f) => f.family))].sort((a, b) =>
            a.localeCompare(b),
          ),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return sysFonts;
}

/** 既定プリセット + 列挙済みシステムフォント（重複除去） */
export function fontOptions(sysFonts: string[]): string[] {
  return [...new Set([...FONT_FAMILIES.map((f) => f.value), ...sysFonts])];
}
