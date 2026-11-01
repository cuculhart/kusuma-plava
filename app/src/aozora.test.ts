import { describe, expect, it } from 'vitest';
import { parseAozora } from './aozora';

describe('parseAozora — 青空注記 → text + marks', () => {
  it('傍点: 直前の対象へ boten mark、注記は除去', () => {
    const r = parseAozora('絶対に［＃「絶対に」に傍点］そうです。');
    expect(r.text).toBe('絶対にそうです。');
    expect(r.marks).toEqual([
      { start: 0, end: 3, attrs: { boten: true } },
    ]);
    expect(r.handled).toBe(1);
    expect(r.dropped).toBe(0);
  });

  it('中見出し: 直前の対象へ fontSize mark', () => {
    const r = parseAozora('二［＃「二」は中見出し］', { headingFs: 5.2 });
    expect(r.text).toBe('二');
    expect(r.marks).toEqual([
      { start: 0, end: 1, attrs: { fontSize: 5.2 } },
    ]);
  });

  it('対象がズレた前方参照型はそのまま残す', () => {
    const r = parseAozora('別の文［＃「絶対に」に傍点］');
    expect(r.text).toBe('別の文［＃「絶対に」に傍点］');
    expect(r.marks).toEqual([]);
  });

  it('1行字下げ: 行頭へ全角スペース', () => {
    const r = parseAozora('［＃５字下げ］二');
    expect(r.text).toBe('　　　　　二');
  });

  it('ブロック字下げ: 各行頭へ全角スペース', () => {
    const r = parseAozora(
      '前の行\n［＃ここから２字下げ］\n去年\n一昨年\n［＃ここで字下げ終わり］\n後の行',
    );
    expect(r.text).toBe('前の行\n　　去年\n　　一昨年\n後の行');
  });

  it('外字 ※［＃…］ は ※ だけ残る', () => {
    const r = parseAozora('姑※［＃「女＋章」、第4水準2-5-75］《しゅうとめ》');
    expect(r.text).toBe('姑※《しゅうとめ》');
    expect(r.dropped).toBe(1);
  });

  it('空の ［＃］ は説明文として残す', () => {
    const r = parseAozora('［＃］：入力者注');
    expect(r.text).toBe('［＃］：入力者注');
  });

  it('複数注記: marks 位置が除去後の text 座標で正しい', () => {
    const r = parseAozora(
      '思わぬ［＃「思わぬ」に傍点］人たちと遊びたい。\nいつも［＃「いつも」に傍点］',
    );
    expect(r.text).toBe('思わぬ人たちと遊びたい。\nいつも');
    expect(r.marks).toEqual([
      { start: 0, end: 3, attrs: { boten: true } },
      { start: 13, end: 16, attrs: { boten: true } },
    ]);
  });

  it('字下げ+見出しの複合: marks・位置マップが正しい', () => {
    const r = parseAozora('［＃５字下げ］二［＃「二」は中見出し］', {
      headingFs: 5.2,
    });
    expect(r.text).toBe('　　　　　二');
    // 二 は変換後 index 5（スペース5字分ズレていたバグの回帰）
    expect(r.marks).toEqual([
      { start: 5, end: 6, attrs: { fontSize: 5.2 } },
    ]);
    expect(r.toParsed(7)).toBe(5); // 生の「二」→ 変換後
    expect(r.toRaw(5)).toBe(7); // 逆マップ
  });

  it('［＃…］ が無い文書はそのまま通る', () => {
    const src = 'ただの本文。\n｜漢字《かんじ》のルビ';
    const r = parseAozora(src);
    expect(r.text).toBe(src);
    expect(r.marks).toEqual([]);
    expect(r.handled + r.dropped).toBe(0);
  });
});
