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
  /** 傍点 — よみがな扱いでルビ欄へ「・」を出す
      （CSS text-emphasis だと 1em セル内へ収まり升目へ重なる） */
  boten?: boolean;
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
  /** vseg 内に配置されるときは区間高（px）を渡す — 話区切り単位の
      天地中央寄せに使う。未指定（vflow 無しのフォールバック）では
      区切りは通常のインライン進行のまま出る */
  segH?: number,
): ReactNode[] {
  const out: ReactNode[] = [];
  for (const u of units) {
    if (u.kind === 'brk') {
      out.push('\n');
      continue;
    }
    const s = styleOf(u.start);
    // 話区切り — 区切り印だけの段は区間の天地中央へ置く
    // （vseg は position:absolute なのでそのまま重ねられる。
    //   字レーンは段ピッチ左側の1em — .vc の translateX と同じ位置）
    if (u.kind === 'sep' && segH === undefined) {
      // vseg 無しの経路 — 字ごとの通常単位としてそのまま出す
      for (const [i, ch] of [...u.text].entries())
        out.push(
          <span
            key={`${u.start}.${i}`}
            className="vc"
            title={s.title}
            style={s.css}
          >
            {ch}
          </span>,
        );
      continue;
    }
    if (u.kind === 'sep' && segH !== undefined) {
      out.push(
        <span
          key={u.start}
          className="vsep"
          title={s.title}
          style={{
            ...s.css,
            position: 'absolute',
            left: 0,
            top: 0,
            width: '1em',
            height: '100%',
            display: 'flex',
            // flexDirection: column は書字モードのブロック軸に従う —
            // vertical-rl を継承すると横並びになるので明示する
            writingMode: 'horizontal-tb',
            flexDirection: 'column',
            justifyContent: 'center',
            textAlign: 'center',
            pointerEvents: 'none',
          }}
        >
          {[...u.text].map((ch, i) => (
            <span
              key={i}
              style={{
                display: 'block',
                blockSize: '1em',
                lineHeight: '1em',
              }}
            >
              {ch}
            </span>
          ))}
        </span>,
      );
      continue;
    }
    // 傍点はよみがな扱い — 1字ごとに .vr+<ruby><rt>・</rt> として
    // ルビ欄へ点を出す（1字=1セルの通常ルビ単位と同じ構造・同じ
    // 組版。単位を丸ごと不可分にすると段の折返しがずれるため、
    // 字ごとの要素に分解して通常字と同じ折返しにする）
    if (s.boten && u.kind !== 'ruby') {
      for (const [i, ch] of [...u.text].entries()) {
        const inner = (
          <ruby>
            <span className="vc">{ch}</span>
            <rt>・</rt>
          </ruby>
        );
        const css = {
          ...s.css,
          textEmphasis: undefined,
          inlineSize: '1em',
        } as CSSProperties;
        out.push(
          s.link ? (
            <a
              key={`${u.start}.${i}`}
              className="vr"
              href={s.link}
              target="_blank"
              rel="noreferrer"
              title={s.title}
              style={css}
            >
              {inner}
            </a>
          ) : (
            <span
              key={`${u.start}.${i}`}
              className="vr"
              title={s.title}
              style={css}
            >
              {inner}
            </span>
          ),
        );
      }
      continue;
    }
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
