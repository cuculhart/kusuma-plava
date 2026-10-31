// インストール済みフォント列挙 — Font Access API（Chromium 限定）。
// queryLocalFonts が無い環境（非 Chromium・非セキュアコンテキスト・
// iframe）や local-fonts 権限拒否・空応答のときは、代表的な和文
// フォントを canvas 計測で当てずっぽう判定した結果へ落ちる。
// それも空なら呼び出し側は既定リストのみになる。

import { useEffect, useState } from 'react';
import { FONT_FAMILIES } from './types';

/** queryLocalFonts が使えない環境でのフォールバック候補 —
    Windows/macOS/Linux で一般的な和文フォント（英日両名を併記）。
    canvas 計測で実在するものだけが残る */
const FONT_CANDIDATES = [
  'Noto Sans JP',
  'Noto Serif JP',
  'Hiragino Sans',
  'Hiragino Kaku Gothic ProN',
  'Hiragino Mincho ProN',
  'Yu Gothic',
  'Yu Gothic UI',
  'Yu Mincho',
  '游ゴシック',
  '游明朝',
  'Meiryo',
  'Meiryo UI',
  'メイリオ',
  'MS Gothic',
  'MS PGothic',
  'MS UI Gothic',
  'MS Mincho',
  'MS PMincho',
  'MS ゴシック',
  'MS Pゴシック',
  'MS 明朝',
  'MS P明朝',
  'BIZ UDPGothic',
  'BIZ UDPMincho',
  'BIZ UDGothic',
  'BIZ UDMincho',
  'UD Digi Kyokasho N-B',
  'UD Digi Kyokasho N-R',
  'UD Digi Kyokasho NK-B',
  'UD Digi Kyokasho NK-R',
  'UD Digi Kyokasho NP-B',
  'UD Digi Kyokasho NP-R',
  'UD デジタル 教科書体 N-B',
  'UD デジタル 教科書体 N-R',
  'UD デジタル 教科書体 NK-B',
  'UD デジタル 教科書体 NK-R',
  'UD デジタル 教科書体 NP-B',
  'UD デジタル 教科書体 NP-R',
  'Osaka',
  'Osaka-Mono',
  'IPAexGothic',
  'IPAexMincho',
  'IPAGothic',
  'IPAMincho',
  'IPAPGothic',
  'IPAPMincho',
  'TakaoGothic',
  'TakaoPGothic',
  'TakaoExGothic',
  'M PLUS 1p',
  'M PLUS Rounded 1c',
  'Sawarabi Gothic',
  'Sawarabi Mincho',
];

/** canvas の measureText でフォント実在判定 — 候補フォント＋汎用
    ファミリで測った幅が「存在しないフォント名」の幅と違えば、その
    フォントはインストール済み（フォールバックと同名解決した場合は
    幅が一致して除外される）。複数の汎用ファミリで照合して誤検出を減らす */
function probeLocalFonts(): string[] {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return [];
    // 幅差が出やすい字列（英字・全角和文の混在）
    const sample = 'mmmmmmmmmmlliあいうえお口⑩';
    const bases = ['serif', 'sans-serif', 'monospace'];
    const widthOf = (family: string, base: string) => {
      ctx.font = `72px '${family}', ${base}`;
      return ctx.measureText(sample).width;
    };
    const missing = bases.map((b) => widthOf('__font_missing__', b));
    return FONT_CANDIDATES.filter((f) =>
      bases.some(
        (b, i) => Math.abs(widthOf(f, b) - missing[i]) > 0.01,
      ),
    );
  } catch {
    return [];
  }
}

export function useSysFonts(): string[] {
  const [sysFonts, setSysFonts] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    const finish = (families: string[]) => {
      if (!cancelled) setSysFonts(families);
    };
    const query = (
      window as { queryLocalFonts?: () => Promise<{ family: string }[]> }
    ).queryLocalFonts;
    if (!query) {
      // Font Access API 非対応 — 計測プローブへ退く
      finish(probeLocalFonts());
      return;
    }
    query
      .call(window)
      .then((faces) => {
        const families = [
          ...new Set(faces.map((f) => f.family)),
        ].sort((a, b) => a.localeCompare(b));
        // 権限拒否等で空応答のときもプローブへ退く
        finish(families.length ? families : probeLocalFonts());
      })
      .catch(() => finish(probeLocalFonts()));
    return () => {
      cancelled = true;
    };
  }, []);
  return sysFonts;
}

/** 既定フォント → 列挙済みシステムフォント → 汎用ファミリの順
    （重複除去）。先頭は FONT_FAMILIES の先頭 = Noto Serif JP */
export function fontOptions(sysFonts: string[]): string[] {
  const [head, ...generics] = FONT_FAMILIES.map((f) => f.value);
  return [...new Set([head, ...sysFonts, ...generics])];
}
