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
//   - ［＃ここから○字下げ、折り返して●字下げ］
//     ［＃ここから改行天付き、折り返して○字下げ］
//     ［＃ここから折り返して○字下げ］（省略形）
//                                   → 改行行頭は全角スペース、折返し
//     （継続）行は hangIndent mark で組版へ伝える（v0.12）
//   - ［＃地付き］/［＃地から○字上げ］（行頭・行中）と
//     ［＃ここから地付き］/［＃ここから地から○字上げ］（ブロック）
//                                   → bottomLift mark で組版へ伝える。
//     行中の注記は残りを別行へ分断（v0.12）
//   - ［＃天付き］・［＃ここから天付き］…［＃ここで天付き終わり］
//                                   → 既定動作なので受け付けるだけ
//   - ［＃説明（file、横○×縦○）入る］ → images[] へ記録（v0.9。
//     サイズ省略の旧式 `（file）入る` も同じ。text からは除去し
//     位置だけ残す — 画像実体は txt に含まれないため呼び出し側が
//     注記位置へ空枠を生成し、ユーザーが画像を割り当てる）
//   - 対象［＃「対象」はキャプション］  → 直前テキストへ小字 fontSize mark
//   - ［＃キャプション］…［＃キャプション終わり］
//     ［＃ここからキャプション］…［＃ここでキャプション終わり］
//                                   → 囲まれた範囲へ小字 fontSize mark
//   - ［＃］                        → 説明文としてそのまま残す
//   - 上記以外（※外字注記含む）      → 除去して件数を dropped で報告
// 前方参照型は対象文字列と直前テキストを照合し、ズレた注記は
// そのまま残す安全側（dropped には数えない）。

import type { TextMark } from 'inimbal';

/** 画像注記 `［＃説明（file、横○×縦○）入る］` の解釈結果。
    画像実体は txt に含まれない — 注記位置へ空枠（placeholder）を
    生成しユーザーが画像を割り当てる前提の情報だけ持つ（v0.9） */
export interface AozoraImage {
  /** 変換後テキスト上の注記位置（注記は text から除去される） */
  pos: number;
  /** 説明文（「…」のキャプション付きの図 等の原文そのまま） */
  alt: string;
  /** 注記内のファイル名（fig作品ID_通番.png 等） */
  file: string;
  /** 注記の横×縦（px）。サイズ省略の旧式は 0 */
  w: number;
  h: number;
}

export interface AozoraResult {
  text: string;
  marks: TextMark[];
  /** 画像注記の解釈結果（text 上の位置＋説明・ファイル名・px サイズ） */
  images: AozoraImage[];
  /** 改丁/改ページ/改段 注記のブレイク位置（変換後座標）—
      layoutChain へ渡しスライスをその位置で打ち切らせる（v0.10） */
  breaks: { pos: number; kind: 'page' | 'col' }[];
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
const FW_CAPTION = /^「(.+)」はキャプション$/;
const LINE_INDENT = /^［＃([０-９0-9]+)字下げ］/;
const BLOCK_OPEN = /^［＃ここから([０-９0-9]+)字下げ］$/;
const BLOCK_CLOSE = /^［＃ここで字下げ終わり］$/;
// 凹凸字下げ（v0.12 — layout_2#jisage_kakushu）— 改行行頭と折返し行で
// 字下げ量が違うブロック。正式形は
//   ［＃ここから○字下げ、折り返して●字下げ］
//   ［＃ここから改行天付き、折り返して○字下げ］
// で、折返し側は「何字分下げるか」の絶対指定。計画の
// ［＃ここから折り返して○字下げ］ は改行天付き形の省略形として
// 受け付ける。m[1]=改行行頭字下げ（省略=0）、m[2]=折返し字下げ
const BLOCK_OPEN_HANG =
  /^［＃ここから(?:([０-９0-9]+)字下げ、|(?:改行)?天付き、)?折り返して([０-９0-9]+)字下げ］$/;
// 地付き・地寄せブロック — ［＃ここから地付き］/［＃ここから地から○字
// 上げ］ … ［＃ここで地付き終わり］/［＃ここで字上げ終わり］
const CHI_BLOCK_OPEN = /^［＃ここから地付き］$/;
const CHIAGE_BLOCK_OPEN = /^［＃ここから地から([０-９0-9]+)字上げ］$/;
const CHI_BLOCK_CLOSE = /^［＃ここで(?:地付き|字上げ)終わり］$/;
// 天付きブロック — 既定動作なので受け付けるだけ（明示指定で意味を
// 持つのは地付き等との併記時）
const TEN_BLOCK_OPEN = /^［＃ここから天付き］$/;
const TEN_BLOCK_CLOSE = /^［＃ここで天付き終わり］$/;
// 行内の地付き・地寄せ — ［＃地付き］/［＃地から○字上げ］。行頭なら
// その行、行中なら残りを別行へ分けて下端揃えにする
const LINE_CHIAGE = /^地から([０-９0-9]+)字上げ$/;
const CAP_BLOCK_OPEN = /^［＃ここからキャプション］$/;
const CAP_BLOCK_CLOSE = /^［＃ここでキャプション終わり］$/;
// 画像注記 — `説明（…）入る`。括弧内は ファイル名 or
// ファイル名、横○×縦○（全角数字あり）
const IMAGE_NOTE = /^(.+)（([^（）]*)）入る$/;
const IMG_SIZE = /横([０-９0-9]+)×縦([０-９0-9]+)/;
// 明示ブレイク — 独立行のみ（行内に出ても区切り扱いしない）。
// 改丁・改ページ・改見開き = 次エリア頭、改段 = 次の段
const BREAK_NOTE = /^［＃改(丁|ページ|見開き|段)］$/;
// ルビ記法 — トークン化（tategaki.ts）と同じ4系統をパース時に
// marks へ変換する。先勝ちのオルタネーション順 = 判定順と同じ
const KANJI = '[\\u4E00-\\u9FFF\\u3005\\u3006\\u30F6\\uF900-\\uFAFF]';
const RUBY_ANY = new RegExp(
  '\\[-([^\\[\\]-]{1,40})-\\] ?\\(-([^\\n-]{1,50})-\\)' +
    '|(' +
    KANJI +
    '+)\\(-([^\\n-]{1,50})-\\)' +
    '|｜([^\\n《》]{1,40})《([^《》\\n]{1,50})》' +
    '|(' +
    KANJI +
    '+)《([^《》\\n]{1,50})》',
  'g',
);
const SP = '　';
const DIVIDER = /^[-—─━＿_＝=]{10,}\s*$/;
const ABOUT = /^【[^】]*について】/;

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
 * opts.captionFs = キャプションへ適用する fontSize（mm。
 * 呼び出し側で版面の字サイズ×0.8 程度を渡す）
 */
export function parseAozora(
  src: string,
  opts: {
    headingFs?: number;
    captionFs?: number;
    /** 空行を畳む — ソースの空行（\n\n 連続）を組版から除く。
        青空本文の見栄え用空行を抑制するオプション（v0.10） */
    collapseNl?: boolean;
  } = {},
): AozoraResult {
  const headingFs = opts.headingFs ?? 6;
  const captionFs = opts.captionFs ?? 3.2;
  const collapseNl = opts.collapseNl ?? false;
  const marks: TextMark[] = [];
  const images: AozoraImage[] = [];
  const breaks: AozoraResult['breaks'] = [];
  const edits: Edit[] = [];
  let handled = 0;
  let dropped = 0;
  const outLines: string[] = [];
  let indent = 0; // ブロック字下げ中の字下げ幅
  let capS: number | null = null; // 開始注記待ちのキャプション開始位置
  // v0.12: 折り返し字下げ — 継続行の字下げはパース時点で折返し位置が
  // 分からないため marks（hangIndent）で組版へ伝える。改行行頭側は
  // 従来どおり全角スペース挿入で処理する
  let hang = 0; // 凹凸字下げブロックの継続行（折返し）字下げ幅
  let hangS: number | null = null; // ブロック開始位置（変換後座標）
  // 地付き・地寄せブロック — 範囲を bottomLift mark で組版へ伝える
  let chiLift = 0; // ブロックの「地からの上げ幅」（0=地付き）
  let chiS: number | null = null;
  // 行内の ［＃地付き］/［＃地から○字上げ］ — 対象は注記から行末
  // までなので、行を畳む時点で範囲を確定する
  let lineChi: { s: number; lift: number } | null = null;
  const closeHang = () => {
    if (hangS != null && hang > 0 && offset > hangS)
      marks.push({ start: hangS, end: offset, attrs: { hangIndent: hang } });
    hangS = null;
    hang = 0;
  };
  const closeChi = () => {
    if (chiS != null && offset > chiS)
      marks.push({ start: chiS, end: offset, attrs: { bottomLift: chiLift } });
    chiS = null;
  };
  let pendingBreak = false; // 改ブレイク注記直後 — 続く空行を畳む
  let rawOff = 0; // 生テキストでの行頭位置
  let offset = 0; // 変換後テキストでの現在位置

  // 【テキスト中に現れる記号について】等、区切り線で囲まれた
  // 先頭凡例は組版対象外 — 行番号を先に求めて行ループで落とす
  // （ソースを削ると生位置がずれるため、行スキップで raw 対応を保つ。
  // 閉じ区切りが無いときは触らない — 誤って本文を食わない）
  const preambleLines = new Set<number>();
  {
    const ls = src.split('\n');
    for (let i = 0; i < ls.length; i++)
      if (DIVIDER.test(ls[i]) && ABOUT.test(ls[i + 1] ?? '')) {
        let k = i + 2;
        while (k < ls.length && !DIVIDER.test(ls[k])) k++;
        if (k < ls.length) {
          for (let j = i; j <= k; j++) preambleLines.add(j);
          i = k;
        }
      }
  }

  const srcLines = src.split('\n');
  for (let ln = 0; ln < srcLines.length; ln++) {
    const line = srcLines[ln];
    const lineRaw = rawOff;
    if (preambleLines.has(ln)) {
      edits.push({
        rawS: lineRaw,
        rawE: lineRaw + line.length,
        parsedS: offset,
        insLen: 0,
      });
      rawOff += line.length + 1;
      continue;
    }
    // 改ブレイク — 直前の空行を畳んでブレイク位置を記録する。
    // 続く空行も pendingBreak で畳む（注記周辺の見栄え用空行の対処）
    const bm = line.match(BREAK_NOTE);
    if (bm) {
      handled++;
      let popped = 0;
      while (outLines.length && outLines[outLines.length - 1] === '') {
        outLines.pop();
        offset -= 1;
        popped++;
      }
      if (!breaks.length || breaks[breaks.length - 1].pos !== offset)
        breaks.push({
          pos: offset,
          kind: bm[1] === '段' ? 'col' : 'page',
        });
      pendingBreak = true;
      // rawS を畳んだ空行の \n ぶん遡らせて位置マップを保つ
      edits.push({
        rawS: lineRaw - popped,
        rawE: lineRaw + line.length,
        parsedS: offset,
        insLen: 0,
      });
      rawOff += line.length + 1;
      continue;
    }
    // ブロック字下げ・複数行キャプションは行単位の注記行として現れる
    const bo = line.match(BLOCK_OPEN);
    if (bo) {
      closeHang();
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
      closeHang();
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
    // 凹凸字下げ（v0.12）— 改行行頭は indent（全角スペース挿入）、
    // 折返し行は hang（marks 経由で組版が継続行へ適用）
    const hb = line.match(BLOCK_OPEN_HANG);
    if (hb) {
      closeHang();
      indent = hb[1] ? +fw(hb[1]) : 0;
      hang = +fw(hb[2]);
      hangS = offset;
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
    // 地付き・地寄せブロック — 範囲を bottomLift mark で組版へ伝える
    const cbk = line.match(CHI_BLOCK_OPEN) ?? line.match(CHIAGE_BLOCK_OPEN);
    if (cbk) {
      closeChi();
      chiLift = cbk[1] ? +fw(cbk[1]) : 0;
      chiS = offset;
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
    if (CHI_BLOCK_CLOSE.test(line)) {
      closeChi();
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
    // 天付きブロック — 既定動作（上端揃え）なので受け付けるだけ
    if (TEN_BLOCK_OPEN.test(line) || TEN_BLOCK_CLOSE.test(line)) {
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
    // 複数行キャプション — 注記行ごと畳み、囲まれた範囲へ小字 mark
    if (CAP_BLOCK_OPEN.test(line)) {
      capS = offset;
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
    if (CAP_BLOCK_CLOSE.test(line)) {
      if (capS != null) {
        marks.push({
          start: capS,
          end: offset,
          attrs: { fontSize: captionFs },
        });
        capS = null;
      }
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
    // 本文断片の emit — ルビ記法を marks へ変換しつつ out へ足す
    // （記法文字は除去・親字のみ残る。rawBase = 断片先頭の生行
    // index、shift 補正済み）。残す側の注記（対象ズレ等）は
    // emit を通さず verbatim で足す — ［＃］内の《》を拾わない
    const emit = (seg: string, rawBase: number) => {
      let j = 0;
      for (const rm of seg.matchAll(RUBY_ANY)) {
        const base = rm[1] ?? rm[3] ?? rm[5] ?? rm[7];
        const yomi = rm[2] ?? rm[4] ?? rm[6] ?? rm[8];
        out += seg.slice(j, rm.index);
        offset += rm.index! - j;
        const bs = offset;
        out += base;
        offset += base.length;
        marks.push({ start: bs, end: offset, attrs: { ruby: yomi } });
        edits.push({
          rawS: rawBase + rm.index!,
          rawE: rawBase + rm.index! + rm[0].length,
          parsedS: bs,
          insLen: base.length,
        });
        j = rm.index! + rm[0].length;
      }
      out += seg.slice(j);
      offset += seg.length - j;
    };
    for (const m of body.matchAll(ANNOTATION)) {
      const at = m.index!;
      const note = m[1];
      emit(body.slice(i, at), lineRaw + i + shift);
      i = at + m[0].length;
      const b = note.match(FW_BOTEN);
      const h = note.match(FW_HEADING);
      const cb = note.match(FW_CAPTION);
      const im = note.match(IMAGE_NOTE);
      const chm = note.match(LINE_CHIAGE);
      if (b || h || cb) {
        const t = (b ?? h ?? cb)![1];
        if (out.endsWith(t)) {
          const s = offset - t.length;
          marks.push({
            start: s,
            end: offset,
            attrs: b
              ? { boten: true }
              : { fontSize: h ? headingFs : captionFs },
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
      } else if (
        note === 'キャプション' ||
        note === 'ここからキャプション'
      ) {
        // 開始/終了型キャプション — 終了注記で範囲を確定する
        capS = offset;
        handled++;
        edits.push({
          rawS: lineRaw + at + shift,
          rawE: lineRaw + at + m[0].length + shift,
          parsedS: offset,
          insLen: 0,
        });
      } else if (
        note === 'キャプション終わり' ||
        note === 'ここでキャプション終わり'
      ) {
        if (capS != null) {
          marks.push({
            start: capS,
            end: offset,
            attrs: { fontSize: captionFs },
          });
          capS = null;
        }
        handled++;
        edits.push({
          rawS: lineRaw + at + shift,
          rawE: lineRaw + at + m[0].length + shift,
          parsedS: offset,
          insLen: 0,
        });
      } else if (im) {
        // 画像注記 — text から除去し位置だけ images[] へ。
        // 説明・ファイル名・横×縦(px)を抽出（省略形は w/h=0）
        const inner = im[2];
        const cut = inner.indexOf('、');
        const file = (cut < 0 ? inner : inner.slice(0, cut)).trim();
        const sz = cut < 0 ? null : inner.slice(cut + 1).match(IMG_SIZE);
        images.push({
          pos: offset,
          alt: im[1],
          file,
          w: sz ? +fw(sz[1]) : 0,
          h: sz ? +fw(sz[2]) : 0,
        });
        handled++;
        edits.push({
          rawS: lineRaw + at + shift,
          rawE: lineRaw + at + m[0].length + shift,
          parsedS: offset,
          insLen: 0,
        });
      } else if (note === '地付き' || chm || note === '天付き') {
        // v0.12: 行内の地付き・地寄せ・天付き — 対象は注記から行末。
        // 行中なら残りを改行で分断して下端揃えの行にする（XHTML で
        // <div class="chitsuki_N"> に分かれるのと同じ構造）。
        // 注記以降に本文が無い・天付き（=既定）は mark 不要
        const rest = body.slice(i).replace(/［＃[^］]*］/g, '');
        if (note === '天付き' || rest.trim() === '') {
          handled++;
          edits.push({
            rawS: lineRaw + at + shift,
            rawE: lineRaw + at + m[0].length + shift,
            parsedS: offset,
            insLen: 0,
          });
        } else {
          // 先行する pending mark があればこの注記の手前で確定する
          if (lineChi && offset > lineChi.s)
            marks.push({
              start: lineChi.s,
              end: offset,
              attrs: { bottomLift: lineChi.lift },
            });
          const mid = out.trim() !== ''; // 行中の注記 → 残りを別行へ
          if (mid) {
            out += '\n';
            offset += 1;
          }
          lineChi = { s: offset, lift: chm ? +fw(chm[1]) : 0 };
          handled++;
          edits.push({
            rawS: lineRaw + at + shift,
            rawE: lineRaw + at + m[0].length + shift,
            parsedS: mid ? offset - 1 : offset,
            insLen: mid ? 1 : 0,
          });
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
    emit(body.slice(i), lineRaw + i + shift);
    // 行内の地付き・地寄せは行末で範囲を確定する（対象は注記〜行末）
    if (lineChi && offset > lineChi.s)
      marks.push({
        start: lineChi.s,
        end: offset,
        attrs: { bottomLift: lineChi.lift },
      });
    lineChi = null;
    // 注記だけの行は除去後に空行として残ると \n が丸ごと1段を
    // 消費して空段が出る — 行ごと畳む（raw 位置は保つ）
    const noteOnly =
      out === '' &&
      line.includes('［＃') &&
      line.replace(/［＃[^］]*］/g, '').trim() === '';
    // 空行 — 改ブレイク直後 or 空行圧縮オプション時は畳む。
    // 畳む行も \n 分の edit を残して位置マップのずれを抑える
    const foldBlank = out === '' && (pendingBreak || collapseNl);
    if (!noteOnly && !foldBlank) {
      outLines.push(out);
      offset += 1; // \n 分
    } else if (out === '') {
      edits.push({
        rawS: lineRaw,
        rawE: lineRaw + line.length + 1,
        parsedS: offset,
        insLen: 0,
      });
    }
    if (out !== '') pendingBreak = false;
    rawOff += line.length + 1;
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

  const text = outLines.join('\n');
  // 閉じられなかった開始注記は文書末までを範囲とみなす
  if (capS != null)
    marks.push({ start: capS, end: text.length, attrs: { fontSize: captionFs } });
  if (hangS != null && hang > 0)
    marks.push({ start: hangS, end: text.length, attrs: { hangIndent: hang } });
  if (chiS != null)
    marks.push({ start: chiS, end: text.length, attrs: { bottomLift: chiLift } });
  return { text, marks, images, breaks, handled, dropped, toParsed, toRaw };
}
