import { describe, expect, it } from 'vitest';
import {
  addPage,
  applyVerticalShift,
  createPages,
  deletePage,
  insertPage,
  pageIndexAtY,
  pagePitch,
  pageRects,
  paperDims,
  setPaper,
  PAGE_GAP_MM,
  PAGE_ORIGIN_Y,
} from '../src/pages';

const A4P = { size: 'A4' as const, landscape: false };
const A4L = { size: 'A4' as const, landscape: true };
const A3P = { size: 'A3' as const, landscape: false };

describe('paperDims — A4/A3 × 縦/横のみ', () => {
  it('縦横で幅高が入れ替わる', () => {
    expect(paperDims(A4P)).toEqual({ w: 210, h: 297 });
    expect(paperDims(A4L)).toEqual({ w: 297, h: 210 });
    expect(paperDims(A3P)).toEqual({ w: 297, h: 420 });
    expect(paperDims({ size: 'A3', landscape: true })).toEqual({ w: 420, h: 297 });
  });
});

describe('pageRects — ワールド mm 座標で縦に等間隔', () => {
  it('同ピッチで並び、index は表示順の連番', () => {
    const m = createPages(A4P, 3);
    const r = pageRects(m.spec, m.pages);
    const pitch = 297 + PAGE_GAP_MM;
    expect(r.map((p) => p.y)).toEqual([
      PAGE_ORIGIN_Y,
      PAGE_ORIGIN_Y + pitch,
      PAGE_ORIGIN_Y + 2 * pitch,
    ]);
    expect(r.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(r.every((p) => p.w === 210 && p.h === 297)).toBe(true);
  });
});

describe('setPaper — 枠のみ差し替え', () => {
  it('寸法・ピッチが変わり、オブジェクトの mm 座標は不変', () => {
    const m = createPages(A4P, 2);
    // オブジェクトはモデル外（app 側のワールドオブジェクト）
    const objects = [
      { id: 'a', x: 30, y: 30, w: 60, h: 45 },
      { id: 'b', x: 30, y: 340, w: 60, h: 45 },
    ];
    const m2 = setPaper(m, A3P);
    const r = pageRects(m2.spec, m2.pages);
    // 枠は新寸法・新ピッチへ追従
    expect(r[0]).toMatchObject({ w: 297, h: 420 });
    expect(r[1].y).toBe(PAGE_ORIGIN_Y + 420 + PAGE_GAP_MM);
    // オブジェクトは一切動いていない（はみ出し放置でも座標不変）
    expect(objects).toEqual([
      { id: 'a', x: 30, y: 30, w: 60, h: 45 },
      { id: 'b', x: 30, y: 340, w: 60, h: 45 },
    ]);
  });

  it('向き変更も枠だけ差し替わる', () => {
    const m = createPages(A4P, 1);
    const r = pageRects(setPaper(m, A4L).spec, setPaper(m, A4L).pages);
    expect(r[0]).toMatchObject({ w: 297, h: 210 });
  });
});

describe('addPage / deletePage', () => {
  it('追加は末尾のスロットの次へ', () => {
    const m = addPage(createPages(A4P, 2));
    const r = pageRects(m.spec, m.pages);
    expect(r).toHaveLength(3);
    expect(r[2].slot).toBe(2);
    expect(r[2].y).toBe(PAGE_ORIGIN_Y + 2 * pagePitch(A4P));
  });

  it('削除 = 枠だけ消す。スロットは空き、他の枠・オブジェクトは不動', () => {
    const m = createPages(A4P, 3);
    const m2 = deletePage(m, 'p2'); // slot 1 を削除
    const r = pageRects(m2.spec, m2.pages);
    expect(r.map((p) => p.slot)).toEqual([0, 2]); // gap が残る
    // p3 の枠は元の位置のまま
    expect(r[1].id).toBe('p3');
    expect(r[1].y).toBe(PAGE_ORIGIN_Y + 2 * pagePitch(A4P));
    // 表示番号は振り直し（フッター n/total 用）
    expect(r[1].index).toBe(1);
  });
});

describe('insertPage — 挿入箇所以下を1ページ分下へ', () => {
  it('スロットが +1 され、新枠が挿入位置に置かれる', () => {
    const m = createPages(A4P, 3);
    const res = insertPage(m, 1, 'pX'); // 1↔2 の間に挟む
    const r = pageRects(m.spec, res.pages);
    expect(r.map((p) => p.id)).toEqual(['p1', 'pX', 'p2', 'p3']);
    expect(res.page.slot).toBe(1);
    expect(res.dy).toBe(pagePitch(A4P));
    // thresholdY = 挿入位置の枠上辺
    expect(res.thresholdY).toBe(PAGE_ORIGIN_Y + pagePitch(A4P));
  });

  it('thresholdY 以上の全オブジェクトが dy 下がる（リンクは id 参照で不壊）', () => {
    const m = createPages(A4P, 3);
    const res = insertPage(m, 1);
    const objects = [
      { id: 'above', y: 30 },                    // ページ1上 — 不動
      { id: 'onTop', y: res.thresholdY },        // 旧ページ2の上辺 — 下へ
      { id: 'below', y: res.thresholdY + 400 },  // さらに下 — 下へ
    ];
    const moved = applyVerticalShift(objects, res.thresholdY, res.dy);
    expect(moved[0].y).toBe(30);
    expect(moved[1].y).toBe(res.thresholdY + res.dy);
    expect(moved[2].y).toBe(res.thresholdY + 400 + res.dy);
    // ずらした後の onTop は新ページ(slot2)の上辺に一致
    const r = pageRects(m.spec, res.pages);
    expect(moved[1].y).toBe(r[2].y);
  });

  it('末尾への挿入はずらし不要（addPage と同じ）', () => {
    const m = createPages(A4P, 2);
    const res = insertPage(m, 2);
    expect(res.thresholdY).toBe(Infinity);
    expect(res.dy).toBe(0);
    expect(pageRects(m.spec, res.pages)).toHaveLength(3);
  });
});

describe('pageIndexAtY', () => {
  it('ページ内なら表示順 index、gap・枠外なら -1', () => {
    const m = deletePage(createPages(A4P, 3), 'p2'); // slot 1 が空き
    expect(pageIndexAtY(m, 30)).toBe(0);                 // ページ1
    expect(pageIndexAtY(m, PAGE_ORIGIN_Y + pagePitch(A4P) + 5)).toBe(-1); // gap
    expect(pageIndexAtY(m, PAGE_ORIGIN_Y + 2 * pagePitch(A4P) + 5)).toBe(1); // ページ3→index1
  });
});
