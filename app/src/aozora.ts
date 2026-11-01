// 青空文庫注記パーサ — ［＃…］ 注記を text と TextMarks へ分解する。
// v0.8 設計: 連鎖テキストは公式 txt のまま保持し、描画
// （レイアウト）側で変換する — パース結果から組版する。
// raw ⇔ 変換後の位置マップを持ち、テキスト欄キャレット同期や
// 手動マーク（生座標）の変換にも使う。
//
// 対応注記（sample/shayo.txt 実データで網羅）:
//   - 対象［＃「対象」に傍点］       → 直前テキストへ boten mark
//   - 対象［＃「対象」は大/中/小見出し］ → 直前テキストへ fontSize mark
//   - ［＃○字下げ］（行頭）          → 全角スペース○字へ置換
//   - ［＃ここから○字下げ］…［＃ここで字下げ終わり］
//                                   → ブロック内各行頭に全角スペース○字
//   - ［＃］                        → 説明文としてそのまま残す
//   - 上記以外（※外字注記含む）      → 除去して件数を dropped で報告
// 前方参照型は対象文字列と直前テキストを照合し、ズレた注記は
// そのまま残す安全側（dropped には数えない）。

import type { TextMark } from 'inimbal';

export interface AozoraResult {
  text: string;
  marks: TextMark[];
  /** 処理した注記の件数 */
  handled: number;
  /** 未対応で除去した注記の件数 */
  dropped: number;
  /** 生テキスト位置 → 変換後テキスト位置 */
  toParsed: (p: number) => number;
  /** 変換後テキスト位置 → 生テキスト位置（先の注記へ吸着） */
  toRaw: (p: number) => number;
}

/** 全角数字を半角へ */
const fw = (s: string) =>
  s.replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10));

const ANNOTATION = /［＃([^］]*)］/g;
const FW_BOTEN = /^「(.+)」に.*傍点$/;
const FW_HEADING = /^「(.+)」は[大中小]見出し$/;
const LINE_INDENT = /^［＃([０-９0-9]+)字下げ］/;
const BLOCK_OPEN = /^［＃ここから([０-９0-9]+)字下げ］$/;
const BLOCK_CLOSE = /^［＃ここで字下げ終わり］$/;
const SP = '　';

/** 生テキスト上の差し替え — raw[rawS,rawE) が insLen 文字へ */
interface Edit {
  rawS: number;
  rawE: number;
  parsedS: number;
  insLen: number;
}

/**
 * 青空文庫テキストを組版用表現へ変換する。
 * opts.headingFs = 見出しへ適用する fontSize（mm。
 * 呼び出し側で版面の字サイズ×比率を渡す）
 */
export function parseAozora(
  src: string,
  opts: { headingFs?: number } = {},
): AozoraResult {
  const headingFs = opts.headingFs ?? 6;
  const marks: TextMark[] = [];
  const edits: Edit[] = [];
  let handled = 0;
  let dropped = 0;
  const outLines: string[] = [];
  let indent = 0; // ブロック字下げ中の字下げ幅
  let rawOff = 0; // 生テキストでの行頭位置
  let offset = 0; // 変換後テキストでの現在位置

  for (const line of src.split('\n')) {
    const lineRaw = rawOff;
    // ブロック字下げは行単位の注記行として現れる
    const bo = line.match(BLOCK_OPEN);
    if (bo) {
      indent = +fw(bo[1]);
      handled++;
      edits.push({
        rawS: lineRaw,
        rawE: lineRaw + line.length,
        parsedS: offset,
        insLen: 0,
      });
      rawOff += line.length + 1;
      continue;
    }
    if (BLOCK_CLOSE.test(line)) {
      indent = 0;
      handled++;
      edits.push({
        rawS: lineRaw,
        rawE: lineRaw + line.length,
        parsedS: offset,
        insLen: 0,
      });
      rawOff += line.length + 1;
      continue;
    }
    let body = line;
    // body の index → 生行 index の補正（字下げで注記除去+空白挿入
    // するため、body 上の注記位置は生行とずれる）
    let shift = 0;
    const li = body.match(LINE_INDENT);
    if (li) {
      const n = +fw(li[1]);
      body = SP.repeat(n) + body.slice(li[0].length);
      shift = li[0].length - n;
      handled++;
      // offset は body の emit で進む（挿入スペースも含む）ため
      // ここでは記録だけ — 足すと二重計上になる
      edits.push({
        rawS: lineRaw,
        rawE: lineRaw + li[0].length,
        parsedS: offset,
        insLen: n,
      });
    } else if (indent > 0 && body !== '') {
      body = SP.repeat(indent) + body;
      shift = -indent;
      edits.push({
        rawS: lineRaw,
        rawE: lineRaw,
        parsedS: offset,
        insLen: indent,
      });
    }

    // 行内の注記を順に処理（marks は変換後座標で記録）
    let out = '';
    let i = 0;
    for (const m of body.matchAll(ANNOTATION)) {
      const at = m.index!;
      const note = m[1];
      out += body.slice(i, at);
      offset += at - i;
      i = at + m[0].length;
      const b = note.match(FW_BOTEN);
      const h = note.match(FW_HEADING);
      if (b || h) {
        const t = (b ?? h)![1];
        if (out.endsWith(t)) {
          const s = offset - t.length;
          marks.push({
            start: s,
            end: offset,
            attrs: b ? { boten: true } : { fontSize: headingFs },
          });
          handled++;
          edits.push({
            rawS: lineRaw + at + shift,
            rawE: lineRaw + at + m[0].length + shift,
            parsedS: offset,
            insLen: 0,
          });
        } else {
          out += m[0]; // 対象ズレの注記はそのまま残す
          offset += m[0].length;
        }
      } else if (note === '') {
        out += m[0]; // ［＃］ 自体は説明文として残す
        offset += m[0].length;
      } else {
        dropped++; // 未対応注記は除去
        edits.push({
          rawS: lineRaw + at + shift,
          rawE: lineRaw + at + m[0].length + shift,
          parsedS: offset,
          insLen: 0,
        });
      }
    }
    out += body.slice(i);
    offset += body.length - i;
    outLines.push(out);
    rawOff += line.length + 1;
    offset += 1; // \n 分
  }

  const toParsed = (p: number) => {
    let q = p;
    for (const e of edits) {
      if (e.rawE <= p) q += e.insLen - (e.rawE - e.rawS);
      else if (e.rawS <= p) q = e.parsedS + e.insLen;
      else break;
    }
    return q;
  };
  const toRaw = (q: number) => {
    let p = q;
    for (const e of edits) {
      if (e.parsedS + e.insLen <= q) p -= e.insLen - (e.rawE - e.rawS);
      else if (e.parsedS <= q) p = e.rawS;
      else break;
    }
    return p;
  };

  return { text: outLines.join('\n'), marks, handled, dropped, toParsed, toRaw };
}
