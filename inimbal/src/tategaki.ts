// 縦書き組版 stratum — inimbal の縦版 fit() と組版単位の分解。
// Kimetron 非依存の純粋モデル（DOM/Canvas 計測を持ち込まない）。
//
// モデル（spike/runaround.html 検証済み）:
//   - 和文は em 正方形近似: 1字 = 1セル（fontSize mm）ずつ段を下へ進む
//   - 段は box 右端から左へピッチ幅ずつ消費
//     （pitch = 字セル + ルビ欄 = fontSize × (1 + RUBY_LANE_RATIO)）
//   - \n = 段送り（横書きの行送りに相当）
//   - ルビ記法は不可分単位（ヨミは主線の進行幅に含めない）
//   - 半角英数ランは ≤4字なら縦中横で1セル、それ以外は1字1セル
//   - 禁則は境界調整のみ: 分割点で次単位が行頭禁則・現単位が行末禁則なら
//     最大2単位前倒し（実務ルール — 計測ではなく境界ルール）

import { sliceRuns, type AreaBox, type TextAttrs } from './chain';

/** ルビ欄の幅 — 字セルに対する比率。段ピッチ = fontSize × (1 + これ) */
export const RUBY_LANE_RATIO = 0.6;

// 暗黙ルビの親字に使う漢字類（々・〆・ヶ・拡張A 含む — spike 準拠）
const KANJI = '[\\u4E00-\\u9FFF\\u3005\\u3006\\u30F6\\uF900-\\uFAFF]';
// 半角ラン: 先頭は英数字、継続は記号も許す（spike 準拠）
const HALF_RUN = /^[A-Za-z0-9][A-Za-z0-9\-+._#%/]*/;
const HALF_CH = /[A-Za-z0-9\-+._#%/]/;

// ルビ記法 — なろう式 ｜親字《ヨミ》 が正規形、(- -) は入力糖衣
const RE_SUGAR_EX = /^\[-([^\[\]-]{1,40})-\] ?\(-([^\n-]{1,50})-\)/;
const RE_SUGAR_IM = new RegExp('^(' + KANJI + '+)\\(-([^\\n-]{1,50})-\\)');
const RE_RUBY_EX = /^｜([^\n《》]{1,40})《([^《》\n]{1,50})》/;
const RE_RUBY_IM = new RegExp('^(' + KANJI + '+)《([^《》\\n]{1,50})》');

/** 縦組版の組版単位。text 先頭基準の raw/text で厳密に分割する */
export interface VUnit {
  kind: 'char' | 'ruby' | 'brk';
  /** 原文での開始位置（スライス先頭基準） */
  start: number;
  /** 原文での長さ（UTF-16 コードユニット） */
  raw: number;
  /** 占有セル数（char=1、ruby=親字数、brk=0） */
  cells: number;
  /** 表示テキスト（char=1字 or 縦中横まとめ、ruby=親字、brk='\n'） */
  text: string;
  /** kind='ruby' のヨミガナ */
  yomi?: string;
  /** kind='char': 縦中横（半角ラン ≤4字を1セルへ収める） */
  tcy?: boolean;
  /** kind='char': 回転半角（.rc で強制1em進行） */
  rc?: boolean;
}

/**
 * 縦書き本文を組版単位へ分解する。
 * ルビ記法（｜親字《ヨミ》/親字《ヨミ》）と糖衣（(-ヨミ-)/[-親字-] (-ヨミ-)）は
 * 不可分単位、半角英数ランは tcy/rc、それ以外は1字1単位。
 * 返す units の raw を順に足すと text.length と一致する。
 */
export function tokenizeVertical(text: string): VUnit[] {
  const units: VUnit[] = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m: RegExpMatchArray | null;
    const ruby = (base: string, yomi: string, raw: number) => {
      units.push({
        kind: 'ruby',
        start: i,
        raw,
        cells: base.length,
        text: base,
        yomi,
      });
      i += raw;
    };
    if ((m = rest.match(RE_SUGAR_EX))) {
      ruby(m[1], m[2], m[0].length);
      continue;
    }
    if ((m = rest.match(RE_SUGAR_IM))) {
      ruby(m[1], m[2], m[0].length);
      continue;
    }
    if ((m = rest.match(RE_RUBY_EX))) {
      ruby(m[1], m[2], m[0].length);
      continue;
    }
    if ((m = rest.match(RE_RUBY_IM))) {
      ruby(m[1], m[2], m[0].length);
      continue;
    }
    if ((m = rest.match(HALF_RUN))) {
      const run = m[0];
      if (run.length <= 4) {
        // ≤4字は縦中横 — 不可分の1セル
        units.push({
          kind: 'char',
          start: i,
          raw: run.length,
          cells: 1,
          text: run,
          tcy: true,
        });
      } else {
        // 長いランは1字1セルの回転表示へ分解
        for (let j = 0; j < run.length; j++) {
          units.push({
            kind: 'char',
            start: i + j,
            raw: 1,
            cells: 1,
            text: run[j],
            rc: true,
          });
        }
      }
      i += run.length;
      continue;
    }
    const ch = rest[0];
    if (ch === '\n') {
      units.push({ kind: 'brk', start: i, raw: 1, cells: 0, text: '\n' });
    } else {
      units.push({
        kind: 'char',
        start: i,
        raw: 1,
        cells: 1,
        text: ch,
        ...(HALF_CH.test(ch) ? { rc: true } : {}),
      });
    }
    i += 1;
  }
  return units;
}

// 糖衣のグローバル版（投稿用テキスト出力の正規化用 — v0.3）。
// 変換順序は tokenizeVertical の判定順と同じ（明示糖衣 → 暗黙糖衣）。
const RE_SUGAR_EX_G =
  /\[-([^\[\]-]{1,40})-\] ?\(-([^\n-]{1,50})-\)/g;
const RE_SUGAR_IM_G = new RegExp(
  '(' + KANJI + '+)\\(-([^\\n-]{1,50})-\\)',
  'g',
);

/** 入力糖衣を正規形 ｜親字《ヨミ》 へ正規化する（v0.3 投稿用テキスト出力）。
    `[-親字-] (-ヨミ-)` / `親字(-ヨミ-)` → `｜親字《ヨミ》`。
    正規形の ｜《》 ルビとその他の本文はそのまま保持する。 */
export function normalizeRuby(text: string): string {
  return text
    .replace(RE_SUGAR_EX_G, '｜$1《$2》')
    .replace(RE_SUGAR_IM_G, '｜$1《$2》');
}

// ── 禁則（境界ルールのみ — 実務ルール。計測ではなく分割点の前倒し） ──
// 行頭禁則: 句読点・中点・コロン類・感嘆疑問・閉じ括弧・長音繰返し・
//           省略記号・小さい仮名。半角の , . : ; ! ? ) も含む
const HEAD_KINSOKU = new Set([
  ...'。、・：；！？!?:;,.)]}〕］｝〉》」』〙〛〜ゝゞ々ヽヾー…‥',
  ...'ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ',
]);
// 行末禁則: 開き括弧（全半角）
const END_KINSOKU = new Set([...'（〔［｛〈《「『〘〚([{']);

/** 段頭に来られない字か（行頭禁則） */
export const isHeadKinsoku = (ch: string) => HEAD_KINSOKU.has(ch);
/** 段末に来られない字か（行末禁則） */
export const isEndKinsoku = (ch: string) => END_KINSOKU.has(ch);

/**
 * 縦版 fit() — text を box へ流し込み、収まる接頭辞の文字数を返す。
 * 単位カウント方式で measureText 不要: 1単位 = そのランの fontSize 分だけ
 * 段を下へ進み、段はピッチ幅ずつ右から左へ消費する。
 * box.writing が 'vertical-rl' でない場合の呼出は想定外（横版を使うこと）。
 */
export function fitVertical(text: string, box: AreaBox): number {
  const baseFs = box.fontSize ?? 4;
  const pitch = baseFs * (1 + RUBY_LANE_RATIO);
  const cols = Math.floor((box.width + 1e-6) / pitch);
  const cap = Math.floor((box.height + 1e-6) / baseFs) * baseFs; // 段の収容高（mm）
  if (cols <= 0 || cap <= 0) return 0;

  // TODO(v0.3): box.obstacles — 段ごとの障害矩形交差で空き区間を計算する
  //   回しこみ。フィールドは AreaBox に予約済み（spike/runaround.html 参照）。

  // 部分装飾によるラン別 fontSize — marks は chain 座標なので textOffset で変換
  const base: TextAttrs = {
    fontSize: baseFs,
    fontFamily: box.fontFamily,
    bold: box.bold,
    italic: box.italic,
  };
  const runs = sliceRuns(text, box.marks, box.textOffset ?? 0, base);
  const rb: { s: number; e: number; fs: number }[] = [];
  {
    let a = 0;
    for (const r of runs) {
      rb.push({ s: a, e: a + r.text.length, fs: r.attrs.fontSize ?? baseFs });
      a += r.text.length;
    }
  }
  const fsAt = (p: number) => {
    for (const r of rb) if (p < r.e) return r.fs;
    return baseFs;
  };

  // 単位は装飾ランにまたがって切らない（ルビの記法がラン境界で
  // 壊れないよう全文を先にトークン化 — 描画側も同じ分割を使う）
  const units = tokenizeVertical(text);
  const unitH = (u: VUnit) => u.cells * fsAt(u.start);

  let u = 0;
  let col = 0;
  let used = 0;
  let colStart = 0; // 現段の先頭単位 index（禁則の前倒し範囲）
  while (u < units.length && col < cols) {
    const un = units[u];
    if (un.kind === 'brk') {
      // \n = 段送り — 段を1つ消費して次段へ
      u++;
      col++;
      used = 0;
      colStart = u;
      continue;
    }
    const h = unitH(un);
    if (used + h <= cap + 1e-9) {
      used += h;
      u++;
      continue;
    }
    if (used === 0) {
      // 空段にも収まらない単位（巨大字等）は強制配置して段を進める
      u++;
      col++;
      used = 0;
      colStart = u;
      continue;
    }
    // 段が満杯 → 禁則の境界調整。次単位が行頭禁則または現単位が
    // 行末禁則なら、境界を最大2単位前倒しして次段へ送る
    let pull = 0;
    while (pull < 2 && u - pull - 1 >= colStart) {
      const last = units[u - pull - 1];
      const next = units[u - pull];
      if (
        !isHeadKinsoku(next.text[0]) &&
        !isEndKinsoku(last.text[last.text.length - 1])
      )
        break;
      pull++;
    }
    u -= pull;
    col++;
    used = 0;
    colStart = u;
  }
  let n = 0;
  for (let i = 0; i < u; i++) n += units[i].raw;
  return n;
}
