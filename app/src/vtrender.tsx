// 縦書き描画の共有部品 — 組版単位（inimbal VUnit）→ JSX。
// 編集画面（App.tsx）と印刷展開（Printout.tsx）で同じ分割・同じ見た目にする。
//   - 通常字 → .vc（inline-block + inline-size:1em = 強制1セル進行。
//     縦送り量 vmtx が 1em を超える書体でも fitVertical の計測と一致）
//   - ruby 単位 → .vr で包んだ <ruby>親字<rt>ヨミ</rt></ruby>
//     （親字は1字ずつ .vc、全体の進行は親字数 em に固定）
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
    // 進行をフォントの縦送り量（vmtx/vhea）非依存に固定し、
    // fitVertical の単位計測（1単位 = u.cells セル）と一致させる:
    //   - 通常字 → .vc（inline-block + inline-size:1em = 1セル）
    //   - ruby   → .vr（inline-block + inline-size = 親字数 em。
    //     長いヨミはルビ欄へ張り出してよいが隣の単位を押し出さない）
    //   - tcy/rc → 内側の既存クラスが既に1セル進行を固定
    const cls =
      u.kind === 'ruby' ? 'vr' : u.tcy || u.rc ? undefined : 'vc';
    const css =
      u.kind === 'ruby'
        ? { ...s.css, inlineSize: `${u.cells}em` }
        : s.css;
    const inner =
      u.kind === 'ruby' ? (
        <ruby>
          {[...u.text].map((ch, i) => (
            <span key={i} className="vc">
              {ch}
            </span>
          ))}
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
          className={cls}
          href={s.link}
          target="_blank"
          rel="noreferrer"
          title={s.title}
          style={css}
        >
          {inner}
        </a>
      ) : (
        <span key={u.start} className={cls} title={s.title} style={css}>
          {inner}
        </span>
      ),
    );
  }
  return out;
}
