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
//   - box.obstacles = 回しこみ障害（エリアローカル mm）— 交差する段は
//     縦範囲をセル境界へスナップして除き、上下両区間へ配分（段内分割）

import type { AreaBox, TextMark } from './chain';

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
  kind: 'char' | 'ruby' | 'brk' | 'sep';
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
 * 縦書き本文を組版単位へ分解する遅延ジェネレータ — tokenizeVertical の
 * 逐次版。レイアウト側が箱を満たした時点で打ち切れるよう、要求された
 * 分だけ単位を生成する（残り全文を先読みしない — 大文書の fit 高速化）
 *
 * marks + textOffset を渡すと TextAttrs.ruby 付きマークが不可分の
 * ruby 単位になる（v0.10: ルビの TextMark 化 — 記法はパース時に
 * marks へ変換されるため、こちらが正規経路。marks は chain 座標で、
 * text の先頭が chain 内 textOffset に対応する想定 — layoutVertical の
 * box.marks/box.textOffset と同じ規約）。marks が無い・範囲外の
 * テキストは従来どおり記法テキストからの解釈へフォールバックする。
 */
export function* tokenizeUnits(
  text: string,
  marks?: TextMark[],
  textOffset = 0,
): Generator<VUnit, void, void> {
  // marks 由来のルビ（text ローカル座標へ変換・開始位置で整列）
  const rm = (marks ?? [])
    .filter(
      (m) =>
        m.attrs.ruby !== undefined &&
        m.end > textOffset &&
        m.start < textOffset + text.length,
    )
    .map((m) => ({
      s: Math.max(0, m.start - textOffset),
      e: Math.min(text.length, m.end - textOffset),
      yomi: m.attrs.ruby!,
    }))
    .sort((a, b) => a.s - b.s);
  let ri = 0; // i は単調増加 — マーク側も前から消費する
  let i = 0;
  while (i < text.length) {
    while (ri < rm.length && rm[ri].s < i) ri++;
    const r = rm[ri];
    if (r && r.s === i && r.e > r.s) {
      const base = text.slice(r.s, r.e);
      yield {
        kind: 'ruby',
        start: i,
        raw: r.e - r.s,
        cells: base.length,
        text: base,
        yomi: r.yomi,
      };
      i = r.e;
      continue;
    }

    const rest = text.slice(i);
    let m: RegExpMatchArray | null;
    // 話区切り — 段落が区切り印（＊◇※）のみで構成される場合は
    // 不可分の sep 単位にする。直後の \n（または文末）までが対象で、
    // 描画側が区間の天地中央へ置く（書籍の区切りの慣例）。
    // 段落途中の区切り印（先頭が \n/文頭でない）は通常字のまま
    if (
      (i === 0 || text[i - 1] === '\n') &&
      (m = rest.match(/^([＊◇※]+)(?=\n|$)/))
    ) {
      const run = m[1];
      yield {
        kind: 'sep',
        start: i,
        raw: run.length,
        cells: run.length,
        text: run,
      };
      i += run.length;
      continue;
    }
    const ruby = (base: string, yomi: string, raw: number): VUnit => ({
      kind: 'ruby',
      start: i,
      raw,
      cells: base.length,
      text: base,
      yomi,
    });
    if ((m = rest.match(RE_SUGAR_EX))) {
      yield ruby(m[1], m[2], m[0].length);
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(RE_SUGAR_IM))) {
      yield ruby(m[1], m[2], m[0].length);
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(RE_RUBY_EX))) {
      yield ruby(m[1], m[2], m[0].length);
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(RE_RUBY_IM))) {
      yield ruby(m[1], m[2], m[0].length);
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(HALF_RUN))) {
      const run = m[0];
      if (run.length <= 4) {
        // ≤4字は縦中横 — 不可分の1セル
        yield {
          kind: 'char',
          start: i,
          raw: run.length,
          cells: 1,
          text: run,
          tcy: true,
        };
      } else {
        // 長いランは1字1セルの回転表示へ分解
        for (let j = 0; j < run.length; j++) {
          yield {
            kind: 'char',
            start: i + j,
            raw: 1,
            cells: 1,
            text: run[j],
            rc: true,
          };
        }
      }
      i += run.length;
      continue;
    }
    const ch = rest[0];
    if (ch === '\n') {
      yield { kind: 'brk', start: i, raw: 1, cells: 0, text: '\n' };
    } else {
      yield {
        kind: 'char',
        start: i,
        raw: 1,
        cells: 1,
        text: ch,
        ...(HALF_CH.test(ch) ? { rc: true } : {}),
      };
    }
    i += 1;
  }
}

/**
 * 縦書き本文を組版単位へ分解する。
 * ルビ記法（｜親字《ヨミ》/親字《ヨミ》）と糖衣（(-ヨミ-)/[-親字-] (-ヨミ-)）は
 * 不可分単位、半角英数ランは tcy/rc、それ以外は1字1単位。
 * 返す units の raw を順に足すと text.length と一致する。
 */
export function tokenizeVertical(
  text: string,
  marks?: TextMark[],
  textOffset = 0,
): VUnit[] {
  return [...tokenizeUnits(text, marks, textOffset)];
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
  // v0.10: 語中の半角記号を段頭にしない — ハイフン語や数値+単位が
  // 段境界で分断されるのを抑える（日本-1・50%・C# 等）
  ...'-+/#%_',
]);
// 行末禁則: 開き括弧（全半角）と、語中で段末に残したくないハイフン
const END_KINSOKU = new Set([...'（〔［｛〈《「『〘〚([{', '-']);

/** 段頭に来られない字か（行頭禁則） */
export const isHeadKinsoku = (ch: string) => HEAD_KINSOKU.has(ch);
/** 段末に来られない字か（行末禁則） */
export const isEndKinsoku = (ch: string) => END_KINSOKU.has(ch);

/** 縦版レイアウトの配置区間 — 1段内の自由区間と、そこへ割り当てた
    組版単位の範囲（回しこみの段内分割で1段が複数区間を持ち得る）。 */
export interface VSeg {
  /** 段 index（右端=0、段ピッチ幅ずつ左へ進む） */
  col: number;
  /** 区間の上端（エリア内寸ローカル mm。セル境界スナップ済） */
  y: number;
  /** 区間の高さ（mm） */
  h: number;
  /** この区間へ入る組版単位の範囲 — tokenizeVertical(text) の [u0, u1) */
  u0: number;
  u1: number;
}

/** layoutVertical() の返り値 — 段×区間への単位割当計画（案B: fit が
    分割位置を返し、描画側がその通り区間を絶対配置する方式。
    CSS writing-mode の自由折返しには障害を教えられないため、
    計測と描画の一致は計画の受け渡しで保証する） */
export interface VFlow {
  /** 段ピッチ（mm）= fontSize × (1 + RUBY_LANE_RATIO) */
  pitch: number;
  /** 収容できた接頭辞の文字数（fitVertical の返り値と同じ） */
  chars: number;
  /** 配置区間（組版順 — 段昇順・段内は上から下へ） */
  segs: VSeg[];
}

/**
 * 縦版レイアウト計画 — text を box へ流し込み、段×自由区間への
 * 単位割当を返す。単位カウント方式で measureText 不要:
 * 1単位 = そのランの fontSize 分だけ区間を下へ進み、段はピッチ幅ずつ
 * 右から左へ消費する。\n = 段送り（段の残り区間は使わない）。
 *
 * box.obstacles（エリア内寸ローカル mm）と x 区間が交差する段は、
 * 障害の縦範囲をセル境界へスナップして除いた自由区間へ配分する
 * — 障害の上・下両区間を使う段内分割（spike/runaround.html 検証済）。
 * 区間端でも禁則の境界調整が働く（前倒しは当該区間の範囲内に留める）。
 * 障害が無いとき各区間は段全体 — fitVertical の従来挙動と同一。
 */
export function layoutVertical(text: string, box: AreaBox): VFlow {
  const baseFs = box.fontSize ?? 4;
  const pitch = baseFs * (1 + RUBY_LANE_RATIO);
  const cols = Math.floor((box.width + 1e-6) / pitch);
  const cap = Math.floor((box.height + 1e-6) / baseFs) * baseFs; // 段の収容高（mm）
  const flow: VFlow = { pitch, chars: 0, segs: [] };
  if (cols <= 0 || cap <= 0) return flow;

  // 部分装飾によるラン別 fontSize — marks は chain 座標なので
  // textOffset で変換。問い合わせは消費単位だけなので、残り全文を
  // sliceRuns でラン化せず fontSize を持つマークから直接引く
  // （後勝ち: マーク配列の後方ほど優先 — sliceRuns と同じ規則）
  const off = box.textOffset ?? 0;
  const fsMarks = (box.marks ?? [])
    .filter(
      (m) =>
        m.attrs.fontSize !== undefined &&
        m.end > off &&
        m.start < off + text.length,
    )
    .map((m) => ({
      s: Math.max(0, m.start - off),
      e: Math.min(text.length, m.end - off),
      fs: m.attrs.fontSize!,
    }));
  const fsAt = (p: number) => {
    let fs = baseFs;
    for (const m of fsMarks) if (m.s <= p && p < m.e) fs = m.fs;
    return fs;
  };

  // 単位は装飾ランにまたがって切らない（ルビの記法がラン境界で
  // 壊れないよう描画側と同じ分割を使う）。箱が満たされた時点で
  // 打ち切れるよう遅延トークン化する — fit が残り全文をスキャン
  // しない（大文書の連鎖レイアウトで支配的コストだった）
  const gen = tokenizeUnits(text, box.marks, off);
  const units: VUnit[] = []; // 消費分だけ逐次実体化
  const unitAt = (k: number): VUnit | undefined => {
    while (units.length <= k) {
      const n = gen.next();
      if (n.done) return undefined;
      units.push(n.value);
    }
    return units[k];
  };
  const unitH = (u: VUnit) => u.cells * fsAt(u.start);

  // 段（右から col 番目 = x 区間 [width-(col+1)pitch, width-col·pitch)）の
  // 自由縦区間。x が重なる障害矩形は縦範囲を切り抜く — 上端は floor・
  // 下端は ceil のセル境界スナップで自由区間側へ丸める。
  const obstacles = box.obstacles ?? [];
  const freeIntervals = (col: number): { y: number; h: number }[] => {
    let iv = [{ y: 0, h: cap }];
    if (!obstacles.length) return iv;
    const xR = box.width - col * pitch;
    const xL = xR - pitch;
    for (const o of obstacles) {
      if (!(o.x < xR && o.x + o.w > xL)) continue;
      const top = Math.floor(o.y / baseFs) * baseFs;
      const bot = Math.ceil((o.y + o.h) / baseFs) * baseFs;
      const next: { y: number; h: number }[] = [];
      for (const s of iv) {
        const e = s.y + s.h;
        if (top >= e || bot <= s.y) {
          next.push(s);
          continue;
        }
        if (top > s.y) next.push({ y: s.y, h: Math.min(top, e) - s.y });
        if (bot < e)
          next.push({ y: Math.max(bot, s.y), h: e - Math.max(bot, s.y) });
      }
      iv = next;
    }
    return iv.filter((s) => s.h > 1e-9);
  };

  let u = 0;
  for (let col = 0; col < cols && unitAt(u); col++) {
    for (const seg of freeIntervals(col)) {
      if (!unitAt(u)) break;
      const u0 = u; // 現区間の先頭単位 index（禁則の前倒し範囲）
      let used = 0;
      let colBrk = false; // brk = 段送り → この段の残り区間は使わない
      while (unitAt(u)) {
        const un = unitAt(u)!;
        if (un.kind === 'brk') {
          // \n = 段送り — 段を1つ消費して次段へ
          u++;
          colBrk = true;
          break;
        }
        const h = unitH(un);
        if (used + h <= seg.h + 1e-9) {
          used += h;
          u++;
          continue;
        }
        if (used === 0) {
          // 空区間にも収まらない単位（巨大字等）は強制配置して区間を進める
          u++;
        } else {
          // 区間が満杯 → 禁則の境界調整。次単位が行頭禁則または現単位が
          // 行末禁則なら、境界を最大2単位前倒しして次区間へ送る
          let pull = 0;
          while (pull < 2 && u - pull - 1 >= u0) {
            const last = unitAt(u - pull - 1)!;
            const next = unitAt(u - pull)!;
            if (
              !isHeadKinsoku(next.text[0]) &&
              !isEndKinsoku(last.text[last.text.length - 1])
            )
              break;
            pull++;
          }
          u -= pull;
        }
        break;
      }
      const u1 = u - (colBrk ? 1 : 0);
      if (u1 > u0) flow.segs.push({ col, y: seg.y, h: seg.h, u0, u1 });
      if (colBrk) break;
    }
  }
  let n = 0;
  for (let i = 0; i < u; i++) n += units[i].raw;
  flow.chars = n;
  return flow;
}

/**
 * 縦版 fit() — text を box へ流し込み、収まる接頭辞の文字数を返す。
 * layoutVertical() の計画から文字数だけを取り出す薄いラッパ。
 * box.writing が 'vertical-rl' でない場合の呼出は想定外（横版を使うこと）。
 */
export function fitVertical(text: string, box: AreaBox): number {
  return layoutVertical(text, box).chars;
}
