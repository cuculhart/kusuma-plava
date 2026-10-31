// テキスト計測: canvas measureText による実寸（96dpi）計測。
// spike index.html の fitText を inimbal の TextMeasurer IF に移植。
// 英単語は空白で折り返し、日本語等は文字単位で強制切断。
// slices の join === text を保つため、常に「収まる接頭辞長」を返す。
// box.marks（部分装飾）があるとラン境界で ctx.font を切替え、
// 行高さは行内の最大 fontSize で計る。

import { sliceRuns, type TextAttrs } from 'inimbal';
import type { TextMeasurer } from 'inimbal';
import { LINE_HEIGHT, MM_PX } from './types';

function fontStr(a: TextAttrs): string {
  const px = (a.fontSize ?? 4) * MM_PX;
  return `${a.italic ? 'italic ' : ''}${a.bold ? 'bold ' : ''}${px}px ${a.fontFamily ?? 'sans-serif'}`;
}

export function createCanvasMeasurer(): TextMeasurer {
  const ctx = document.createElement('canvas').getContext('2d')!;
  return {
    fit(text, box) {
      const base: TextAttrs = {
        fontSize: box.fontSize ?? 4,
        fontFamily: box.fontFamily ?? 'sans-serif',
        bold: box.bold,
        italic: box.italic,
      };
      // ラン境界（text 先頭基準）。marks は chain 座標なので textOffset で変換
      const segs = sliceRuns(text, box.marks, box.textOffset ?? 0, base).map(
        (r) => ({ text: r.text, attrs: r.attrs }),
      );
      const rb: { s: number; e: number; attrs: TextAttrs }[] = [];
      {
        let a = 0;
        for (const r of segs) {
          rb.push({ s: a, e: a + r.text.length, attrs: r.attrs });
          a += r.text.length;
        }
      }
      const runAt = (i: number) => {
        for (const r of rb) if (i < r.e) return r;
        return rb[rb.length - 1];
      };
      const widthOf = (s: number, e: number) => {
        let w = 0;
        for (const r of rb) {
          if (r.e <= s) continue;
          if (r.s >= e) break;
          ctx.font = fontStr(r.attrs);
          w += ctx.measureText(
            text.slice(Math.max(s, r.s), Math.min(e, r.e)),
          ).width;
        }
        return w;
      };
      const maxPxIn = (s: number, e: number) => {
        let m = base.fontSize! * MM_PX;
        for (const r of rb) {
          if (r.e <= s) continue;
          if (r.s >= e) break;
          m = Math.max(m, (r.attrs.fontSize ?? 4) * MM_PX);
        }
        return m;
      };

      const maxW = box.width * MM_PX;
      const maxH = box.height * MM_PX;
      let pos = 0;
      let lineStart = 0;
      let usedH = 0;
      let lineMaxPx = 0;
      while (pos < text.length) {
        const ch = text[pos];
        const rpx = (runAt(pos).attrs.fontSize ?? 4) * MM_PX;
        if (ch === '\n') {
          const lh = Math.max(lineMaxPx, rpx) * LINE_HEIGHT;
          // 2行目以降が高さに入らないなら手前で切る（1行目は必ず計上）
          if (usedH > 0 && usedH + lh > maxH) {
            pos = lineStart;
            break;
          }
          usedH += lh;
          lineMaxPx = 0;
          pos++;
          lineStart = pos;
          continue;
        }
        if (widthOf(lineStart, pos + 1) <= maxW) {
          lineMaxPx = Math.max(lineMaxPx, rpx);
          pos++;
          continue;
        }
        if (pos === lineStart) {
          lineMaxPx = Math.max(lineMaxPx, rpx);
          pos++; // 1字でも幅超過 → 強制進行
          continue;
        }
        // 直前の空白で切る（空白は前行末へ残す）
        const sp = text.lastIndexOf(' ', pos);
        const breakPos = sp >= lineStart ? sp + 1 : pos;
        const lh = maxPxIn(lineStart, breakPos) * LINE_HEIGHT;
        if (usedH > 0 && usedH + lh > maxH) {
          pos = lineStart;
          break;
        }
        usedH += lh;
        pos = breakPos;
        lineStart = pos;
        lineMaxPx = 0;
      }
      return pos;
    },
  };
}
