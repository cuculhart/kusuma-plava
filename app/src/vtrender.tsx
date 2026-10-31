// 縦書き描画の共有部品 — 組版単位（inimbal VUnit）→ JSX。
// 編集画面（App.tsx）と印刷展開（Printout.tsx）で同じ分割・同じ見た目にする。
//   - ruby 単位 → <ruby>親字<rt>ヨミ</rt></ruby>（vertical-rl で親字の右へ）
//   - tcy → .tcy（text-combine-upright: 半角ラン ≤4字を1セルへ収める）
//   - rc  → .rc（回転半角を強制1em進行 = 1セル。計測との一致を保つ）
//   - brk → '\n'（white-space: pre-wrap で段送り）

import type { CSSProperties, ReactNode } from 'react';
import type { VUnit } from 'inimbal';

export interface VStyle {
  css: CSSProperties;
  /** リンク先 — 指定時は <a> で包む（印刷/PDF 用。編集画面は未指定） */
  link?: string;
  /** title 属性（リンクのツールチップ等） */
  title?: string;
}

/**
 * units を装飾 span・ruby の列へ展開する。
 * styleOf(u.start) で単位ごとの解決済みスタイルを引く。
 * v0.1 の簡約: ラン境界（部分装飾）にまたがる単位は先頭ランの
 * 装飾に寄せる — ルビをラン途中で分断しないための割り切り。
 */
export function vunitSpans(
  units: VUnit[],
  styleOf: (rawStart: number) => VStyle,
): ReactNode[] {
  const out: ReactNode[] = [];
  for (const u of units) {
    if (u.kind === 'brk') {
      out.push('\n');
      continue;
    }
    const s = styleOf(u.start);
    const inner =
      u.kind === 'ruby' ? (
        <ruby>
          {u.text}
          <rt>{u.yomi}</rt>
        </ruby>
      ) : u.tcy ? (
        <span className="tcy">{u.text}</span>
      ) : u.rc ? (
        <span className="rc">{u.text}</span>
      ) : (
        u.text
      );
    out.push(
      s.link ? (
        <a
          key={u.start}
          href={s.link}
          target="_blank"
          rel="noreferrer"
          title={s.title}
          style={s.css}
        >
          {inner}
        </a>
      ) : (
        <span key={u.start} title={s.title} style={s.css}>
          {inner}
        </span>
      ),
    );
  }
  return out;
}
