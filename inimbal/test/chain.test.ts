import { describe, expect, it } from 'vitest';
import {
  adjustMarksForEdit,
  applyMark,
  canLink,
  chainOf,
  clearMarksIn,
  insertArea,
  layoutChain,
  linkChains,
  pruneChains,
  removeArea,
  sliceRuns,
  unlinkAt,
  type Chain,
} from '../src/chain';

// テスト用計測: 幅 = 1行あたり文字数、高さ = 行数。
// 「収まる接頭辞長」を返す契約だけを検証する。
const meas = {
  fit: (t: string, b: { width: number; height: number }) =>
    Math.min(t.length, Math.floor(b.width) * Math.max(1, Math.floor(b.height))),
};

describe('layoutChain', () => {
  it('貪欲配分 — fit→rest→次エリア、残りは overflow', () => {
    const r = layoutChain(
      'abcdefghij',
      [
        { id: 'a', width: 3, height: 2 },
        { id: 'b', width: 3, height: 1 },
      ],
      meas,
    );
    expect(r.slices).toEqual([
      { areaId: 'a', text: 'abcdef', offset: 0 },
      { areaId: 'b', text: 'ghi', offset: 6 },
    ]);
    expect(r.overflow).toBe('j');
  });

  it('slices は chain text の厳密な分割（join === text）', () => {
    const text = 'hello world — 途中で切れても全体は保存される';
    const r = layoutChain(text, [{ id: 'a', width: 5, height: 1 }], meas);
    expect(r.slices[0].text + r.overflow).toBe(text);
  });

  it('空エリア列なら全文が overflow', () => {
    const r = layoutChain('abc', [], meas);
    expect(r.slices).toEqual([]);
    expect(r.overflow).toBe('abc');
  });
});

describe('link — 一方通行・線形のみ', () => {
  const two: Chain[] = [
    { id: 'c1', areas: ['a1', 'a2'], text: 'x' },
    { id: 'c2', areas: ['b1'], text: 'y' },
  ];

  it('末尾 → 別連鎖の先頭のみ可', () => {
    expect(canLink(two, 'a2', 'b1')).toBe(true);
    expect(canLink(two, 'a1', 'b1')).toBe(false); // 末尾でない
    expect(canLink(two, 'a2', 'a1')).toBe(false); // 同一連鎖（循環）
    expect(canLink(two, 'zz', 'b1')).toBe(false); // 未所属
  });

  it('linkChains: 連鎖が結合しテキストが連結される', () => {
    const out = linkChains(two, 'a2', 'b1');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('c1');
    expect(out[0].areas).toEqual(['a1', 'a2', 'b1']);
    expect(out[0].text).toBe('x\ny');
    expect(chainOf(out, 'b1')!.id).toBe('c1');
  });

  it('1→複数 は出せない: 併合後は中間エリアから接続不可', () => {
    const three: Chain[] = [
      ...two,
      { id: 'c3', areas: ['d1'], text: 'z' },
    ];
    const linked = linkChains(three, 'a2', 'b1'); // [a1,a2,b1]
    expect(canLink(linked, 'a2', 'd1')).toBe(false); // a2 はもう末尾ではない
    expect(canLink(linked, 'b1', 'd1')).toBe(true); // 新末尾からは可
  });

  it('複数→1 は出せない: 併合済みの先頭は受け付けない', () => {
    const three: Chain[] = [
      ...two,
      { id: 'c3', areas: ['d1'], text: 'z' },
    ];
    const linked = linkChains(three, 'a2', 'b1'); // [a1,a2,b1]
    // b1 は連鎖の中間。別連鎖の末尾から指しても不可
    expect(canLink(linked, 'd1', 'b1')).toBe(false);
  });

  it('循環は出せない: 1→2→…→末尾から先頭へは繋げない', () => {
    const linked = linkChains(two, 'a2', 'b1'); // [a1,a2,b1]
    // 末尾 b1 → 先頭 a1 は同一連鎖なので不可
    expect(canLink(linked, 'b1', 'a1')).toBe(false);
  });

  it('不可なら chains は無変更', () => {
    expect(linkChains(two, 'a1', 'b1')).toBe(two);
  });
});

describe('unlinkAt — 切断時の巻き戻し', () => {
  it('テキストは全量 head 側に残り、tail は空の新連鎖', () => {
    const out = unlinkAt(
      [{ id: 'c', areas: ['a', 'b', 'c'], text: 'xyz' }],
      'c',
      0,
      'c2',
    );
    expect(out).toEqual([
      { id: 'c', areas: ['a'], text: 'xyz' },
      { id: 'c2', areas: ['b', 'c'], text: '', marks: [] },
    ]);
  });

  it('範囲外 index なら無変更', () => {
    const cs: Chain[] = [{ id: 'c', areas: ['a'], text: 'x' }];
    expect(unlinkAt(cs, 'c', 0, 'c2')).toBe(cs);
  });
});

describe('途中挿入・削除', () => {
  it('insertArea: 連鎖途中にエリアを挿入、テキスト不変', () => {
    const cs = insertArea(
      [{ id: 'c', areas: ['a', 'b'], text: 't' }],
      'c',
      1,
      'n',
    );
    expect(cs[0].areas).toEqual(['a', 'n', 'b']);
    expect(cs[0].text).toBe('t');
  });

  it('removeArea: エリアを外す。テキストは残る。空連鎖は消える', () => {
    let cs: Chain[] = [{ id: 'c', areas: ['a', 'b'], text: 't' }];
    cs = removeArea(cs, 'a');
    expect(cs[0].areas).toEqual(['b']);
    expect(cs[0].text).toBe('t');
    cs = removeArea(cs, 'b');
    expect(cs).toHaveLength(0);
  });

  it('pruneChains: 存在しないエリアを全連鎖から除去', () => {
    const cs: Chain[] = [
      { id: 'c1', areas: ['a', 'b', 'c'], text: 't1' },
      { id: 'c2', areas: ['d'], text: 't2' },
    ];
    const out = pruneChains(cs, (id) => id !== 'b' && id !== 'd');
    expect(out).toEqual([{ id: 'c1', areas: ['a', 'c'], text: 't1' }]);
  });
});

describe('部分装飾マーク', () => {
  const mk = (
    start: number,
    end: number,
    attrs: import('../src/chain').TextAttrs = { bold: true },
  ) => ({
    start,
    end,
    attrs,
  });

  it('applyMark: 範囲へマーク追加。空・逆順は正規化/無視', () => {
    expect(applyMark(undefined, 2, 5, { bold: true })).toEqual([
      mk(2, 5),
    ]);
    expect(applyMark([mk(0, 3)], 8, 4, { italic: true })).toEqual([
      mk(0, 3),
      { start: 4, end: 8, attrs: { italic: true } },
    ]);
    expect(applyMark([mk(0, 3)], 5, 5, { bold: true })).toEqual([mk(0, 3)]);
  });

  it('clearMarksIn: 交差マークを除去・跨ぎマークは分割', () => {
    const ms = [mk(0, 4), mk(3, 8, { italic: true }), mk(10, 12)];
    // [3,6) を消す → mk(0,4) は [0,3) へ縮小、mk(3,8) は [6,8) へ残る
    expect(clearMarksIn(ms, 3, 6)).toEqual([
      mk(0, 3),
      { start: 6, end: 8, attrs: { italic: true } },
      mk(10, 12),
    ]);
  });

  it('adjustMarksForEdit: 挿入で後続シフト・削除で交差部縮小', () => {
    const ms = [mk(2, 5), mk(8, 10)];
    // pos3 に "XX" 挿入 → 前者は [2,3)+[3,5)…内部に挿入なのでそのまま?
    // 仕様: 挿入点がマーク内部 → マークは拡張しない（開始<=p・終了>=delEnd で p 側へ寄る）
    const ins = adjustMarksForEdit(ms, 'abcdefghij', 'abcXXdefghij');
    // delStart=3, delEnd=3, insLen=2 → delta=+2
    // mk(2,5): start<=3→2, end>=3→7 に拡張（挿入分を内包）
    expect(ins).toEqual([mk(2, 7), mk(10, 12)]);
    // pos4-5("ef")削除 → mk(2,5) は [2,4) へ縮小、mk(8,10) → [6,8)
    const del = adjustMarksForEdit(ms, 'abcdefghij', 'abcdghij');
    expect(del).toEqual([mk(2, 4), mk(6, 8)]);
  });

  it('adjustMarksForEdit: 編集で完全に消えたマークは落ちる', () => {
    const ms = [mk(2, 5)];
    // pos1-8 を "Z" に置換 → マークは [1,1) 空で消える
    expect(
      adjustMarksForEdit(ms, 'abcdefghij', 'aZij'),
    ).toEqual([]);
  });

  it('linkChains: to 側マークを継ぎ目分シフトして引き継ぐ', () => {
    const cs: Chain[] = [
      { id: 'c1', areas: ['a'], text: 'abc', marks: [mk(0, 2)] },
      {
        id: 'c2',
        areas: ['b'],
        text: 'de',
        marks: [{ start: 0, end: 1, attrs: { italic: true } }],
      },
    ];
    const out = linkChains(cs, 'a', 'b');
    // joinTexts で '\n' が1字入る → offset=4
    expect(out[0].text).toBe('abc\nde');
    expect(out[0].marks).toEqual([
      mk(0, 2),
      { start: 4, end: 5, attrs: { italic: true } },
    ]);
  });

  it('linkChains: 空テキスト側は継ぎ改行なしでオフセット0相当', () => {
    const cs: Chain[] = [
      { id: 'c1', areas: ['a'], text: 'abc', marks: [mk(0, 2)] },
      { id: 'c2', areas: ['b'], text: '', marks: [mk(0, 0)] },
    ];
    const out = linkChains(cs, 'a', 'b');
    expect(out[0].text).toBe('abc');
  });

  it('unlinkAt: テキストは head へ残りマーク維持・tail は空', () => {
    const cs: Chain[] = [
      { id: 'c', areas: ['a', 'b'], text: 'abcdef', marks: [mk(0, 6)] },
    ];
    const out = unlinkAt(cs, 'c', 0, 'c2');
    expect(out[0].text).toBe('abcdef');
    expect(out[0].marks).toEqual([mk(0, 6)]);
    expect(out[1].text).toBe('');
    expect(out[1].marks).toEqual([]);
  });

  it('sliceRuns: マークなしは base のみ1ラン', () => {
    expect(sliceRuns('abc', undefined, 0, { fontSize: 4 })).toEqual([
      { text: 'abc', attrs: { fontSize: 4 } },
    ]);
  });

  it('sliceRuns: 範囲をまたぐマークを境界で分割・後勝ちマージ', () => {
    const runs = sliceRuns(
      'abcdef',
      [mk(1, 4), { start: 3, end: 5, attrs: { color: '#f00' } }],
      0,
      { fontSize: 4 },
    );
    expect(runs).toEqual([
      { text: 'a', attrs: { fontSize: 4 } },
      { text: 'bc', attrs: { fontSize: 4, bold: true } },
      { text: 'd', attrs: { fontSize: 4, bold: true, color: '#f00' } },
      { text: 'e', attrs: { fontSize: 4, color: '#f00' } },
      { text: 'f', attrs: { fontSize: 4 } },
    ]);
  });

  it('sliceRuns: offset 付き（スライスが連鎖途中）で正しく切れる', () => {
    // chain text "0123456789", slice は offset=5 の "56789"
    const runs = sliceRuns('56789', [mk(6, 8)], 5, { fontSize: 4 });
    expect(runs).toEqual([
      { text: '5', attrs: { fontSize: 4 } },
      { text: '67', attrs: { fontSize: 4, bold: true } },
      { text: '89', attrs: { fontSize: 4 } },
    ]);
  });

  it('layoutChain: marks を計測へ textOffset 付きで渡す', () => {
    const seen: { off?: number; len?: number }[] = [];
    const m = {
      fit: (t: string, b: { textOffset?: number; marks?: unknown[] }) => {
        seen.push({ off: b.textOffset, len: b.marks?.length });
        return Math.min(t.length, 3);
      },
    };
    layoutChain(
      'abcdefgh',
      [{ id: 'a', width: 3, height: 1 }, { id: 'b', width: 3, height: 1 }],
      m,
      [mk(0, 4)],
    );
    expect(seen).toEqual([
      { off: 0, len: 1 },
      { off: 3, len: 1 },
    ]);
  });
});
