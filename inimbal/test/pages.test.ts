import { describe, expect, it } from 'vitest';
import {
  addPage,
  applyStackShift,
  applyVerticalShift,
  createPages,
  deletePage,
  insertPage,
  pageIndexAtY,
  pagePitch,
  pagePitchAlong,
  pageRectAt,
  pageRects,
  paperDims,
  remapRectAxis,
  setPaper,
  PAGE_GAP_MM,
  PAGE_ORIGIN_X,
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

describe('pageRects — 横積み(axis x)は右→左', () => {
  it('page0 が最右で縦積みと同じ帯、以降は左へ等間隔', () => {
    const m = createPages(A4L, 3); // A4横 297×210
    const ph = pagePitchAlong(m.spec, 'x'); // 297+12
    const r = pageRects(m.spec, m.pages, 'x');
    expect(r.map((p) => p.x)).toEqual([
      PAGE_ORIGIN_X,
      PAGE_ORIGIN_X - ph,
      PAGE_ORIGIN_X - 2 * ph,
    ]);
    expect(r.every((p) => p.y === PAGE_ORIGIN_Y)).toBe(true);
    expect(r.map((p) => p.index)).toEqual([0, 1, 2]);
    // page0 の帯は縦積みと一致（モード切替で先頭ページが跳ばない）
    const ry = pageRects(m.spec, m.pages, 'y');
    expect(r[0].x).toBe(ry[0].x);
    expect(r[0].y).toBe(ry[0].y);
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

describe('insertPage — 挿入箇所以下を1ページ分ずらす', () => {
  it('スロットが +1 され、新枠が挿入位置に置かれる', () => {
    const m = createPages(A4P, 3);
    const res = insertPage(m, 1, 'pX'); // 1↔2 の間に挟む
    const r = pageRects(m.spec, res.pages);
    expect(r.map((p) => p.id)).toEqual(['p1', 'pX', 'p2', 'p3']);
    expect(res.page.slot).toBe(1);
    expect(res.delta).toBe(pagePitch(A4P));
    expect(res.axis).toBe('y');
    // threshold = 挿入位置の枠上辺
    expect(res.threshold).toBe(PAGE_ORIGIN_Y + pagePitch(A4P));
  });

  it('threshold 以降の全オブジェクトが delta ずれる（リンクは id 参照で不壊）', () => {
    const m = createPages(A4P, 3);
    const res = insertPage(m, 1);
    const objects = [
      { id: 'above', x: 30, y: 30 },                    // ページ1上 — 不動
      { id: 'onTop', x: 30, y: res.threshold },         // 旧ページ2の上辺 — 下へ
      { id: 'below', x: 30, y: res.threshold + 400 },   // さらに下 — 下へ
    ];
    const moved = applyStackShift(objects, res.axis, res.threshold, res.delta);
    expect(moved[0].y).toBe(30);
    expect(moved[1].y).toBe(res.threshold + res.delta);
    expect(moved[2].y).toBe(res.threshold + 400 + res.delta);
    // ずらした後の onTop は新ページ(slot2)の上辺に一致
    const r = pageRects(m.spec, res.pages);
    expect(moved[1].y).toBe(r[2].y);
    // 互換ラッパー applyVerticalShift と同じ結果
    expect(applyVerticalShift(objects, res.threshold, res.delta)).toEqual(moved);
  });

  it('末尾への挿入はずらし不要（addPage と同じ）', () => {
    const m = createPages(A4P, 2);
    const res = insertPage(m, 2);
    expect(res.threshold).toBe(Infinity);
    expect(res.delta).toBe(0);
    expect(pageRects(m.spec, res.pages)).toHaveLength(3);
  });

  it('横積み(axis x)では右辺より左のオブジェクトが左へずれる', () => {
    const m = createPages(A4L, 3);
    const res = insertPage(m, 1, 'pX', 'x');
    const r = pageRects(m.spec, res.pages, 'x');
    expect(r.map((p) => p.id)).toEqual(['p1', 'pX', 'p2', 'p3']);
    const ph = pagePitchAlong(m.spec, 'x');
    expect(res.delta).toBe(-ph);
    // threshold = 挿入位置の枠の右辺（旧ページ2の右端）
    const oldRight = pageRectAt(m.spec, 1, 'x');
    expect(res.threshold).toBe(oldRight.x + oldRight.w);
    const objects = [
      { id: 'earlier', x: res.threshold + 50, y: 30 }, // 右の前ページ — 不動
      { id: 'edge', x: res.threshold, y: 30 },          // 境界 — 左へ
      { id: 'later', x: res.threshold - 100, y: 30 },   // 左の後ページ — 左へ
    ];
    const moved = applyStackShift(objects, res.axis, res.threshold, res.delta);
    expect(moved[0].x).toBe(res.threshold + 50);
    expect(moved[1].x).toBe(res.threshold - ph);
    expect(moved[2].x).toBe(res.threshold - 100 - ph);
    // ずらした edge は挿入位置の1枚後ろ（slot 2）の右辺に一致
    expect(moved[1].x).toBe(r[2].x + r[2].w);
  });
});

describe('remapRectAxis — 積み軸の往復変換', () => {
  it('page0 上のオブジェクトは不動（両軸で page0 の帯が一致）', () => {
    const o = { x: 60, y: 80, w: 100, h: 50 };
    expect(remapRectAxis(A4L, o, 'y', 'x')).toEqual(o);
    expect(remapRectAxis(A4L, o, 'x', 'y')).toEqual(o);
  });

  it('紙面上のオブジェクトは往復で厳密に戻る', () => {
    // A4横 297×210 — 各スロット中央寄せの升目枠相当矩形
    const frames = [0, 1, 2, 3].map((s) => {
      const p = pageRectAt(A4L, s, 'y');
      return { x: p.x + 40, y: p.y + 30, w: 200, h: 150 };
    });
    for (const f of frames) {
      const h = remapRectAxis(A4L, f, 'y', 'x');
      // 横積みでは同スロットの枠内（中心のページローカル位置を保持）
      const p = pageRectAt(A4L, frames.indexOf(f), 'x');
      const cx = h.x + h.w / 2;
      const cy = h.y + h.h / 2;
      expect(cx).toBeCloseTo(p.x + 40 + f.w / 2, 6);
      expect(cy).toBeCloseTo(p.y + 30 + f.h / 2, 6);
      // 往復で元へ
      expect(remapRectAxis(A4L, h, 'x', 'y')).toEqual(f);
    }
  });

  it('ページ枠そのものも往復で戻る（正準系変換で PAGE オブジェクトも安全）', () => {
    for (const s of [0, 1, 2]) {
      const pv = pageRectAt(A4P, s, 'y');
      const px = pageRectAt(A4P, s, 'x');
      expect(remapRectAxis(A4P, pv, 'y', 'x')).toEqual(px);
      expect(remapRectAxis(A4P, px, 'x', 'y')).toEqual(pv);
    }
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
