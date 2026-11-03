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

  it('［＃…］ が無い文書はそのまま通る（ルビ記法は marks へ変換）', () => {
    const src = 'ただの本文。\n漢字のまま';
    const r = parseAozora(src);
    expect(r.text).toBe(src);
    expect(r.marks).toEqual([]);
    expect(r.handled + r.dropped).toBe(0);
  });
});

describe('parseAozora — ルビの marks 化（v0.10）', () => {
  it('｜親字《ヨミ》: 記法を除去し親字へ ruby mark', () => {
    const r = parseAozora('彼は｜漢字《かんじ》を読む');
    expect(r.text).toBe('彼は漢字を読む');
    expect(r.marks).toEqual([
      { start: 2, end: 4, attrs: { ruby: 'かんじ' } },
    ]);
  });

  it('暗黙ルビ 親字《ヨミ》と糖衣 (- -) も marks へ', () => {
    const r = parseAozora('運命《さだめ》と出会う');
    expect(r.text).toBe('運命と出会う');
    expect(r.marks).toEqual([
      { start: 0, end: 2, attrs: { ruby: 'さだめ' } },
    ]);
    const s = parseAozora('運命(-さだめ-)に賭ける');
    expect(s.text).toBe('運命に賭ける');
    expect(s.marks).toEqual([
      { start: 0, end: 2, attrs: { ruby: 'さだめ' } },
    ]);
  });

  it('位置マップ: 記法ぶんの変位を編集記録で吸収', () => {
    const r = parseAozora('｜漢字《かんじ》の本');
    expect(r.text).toBe('漢字の本');
    // 生の「の」(index 8) → 変換後 index 2、逆マップも一致
    expect(r.toParsed(8)).toBe(2);
    expect(r.toRaw(2)).toBe(8);
  });
});

describe('parseAozora — 改ブレイク・空行ポリシー（v0.10）', () => {
  it('［＃改ページ］は breaks へ記録、注記行は除去', () => {
    const r = parseAozora('前。\n［＃改ページ］\n後。');
    expect(r.text).toBe('前。\n後。');
    expect(r.breaks).toEqual([{ pos: 3, kind: 'page' }]);
    expect(r.handled).toBe(1);
  });

  it('周辺の空行を畳む（前後どちらも）', () => {
    const r = parseAozora('前。\n\n［＃改丁］\n\n\n後。');
    expect(r.text).toBe('前。\n後。');
    expect(r.breaks).toEqual([{ pos: 3, kind: 'page' }]);
  });

  it('改段は col 種別で記録する', () => {
    const r = parseAozora('［＃改段］');
    expect(r.breaks).toEqual([{ pos: 0, kind: 'col' }]);
  });

  it('同じ位置の連続ブレイクは1つに畳む', () => {
    const r = parseAozora('［＃改ページ］\n［＃改ページ］\n後。');
    expect(r.breaks).toHaveLength(1);
  });

  it('collapseNl: 連続する空行を全て畳む', () => {
    const r = parseAozora('一\n\n二\n\n\n三', { collapseNl: true });
    expect(r.text).toBe('一\n二\n三');
  });

  it('collapseNl なし: 空行は空段として残る', () => {
    const r = parseAozora('一\n\n二');
    expect(r.text).toBe('一\n\n二');
  });
});

describe('parseAozora — 画像注記（v0.9）', () => {
  it('標準形: 説明・ファイル名・横×縦を抽出し注記は除去', () => {
    const r = parseAozora('前。\n［＃庭の図（fig01.png、横400×縦300）入る］\n後。');
    expect(r.text).toBe('前。\n後。');
    expect(r.images).toEqual([
      { pos: 3, alt: '庭の図', file: 'fig01.png', w: 400, h: 300 },
    ]);
    expect(r.handled).toBe(1);
    expect(r.dropped).toBe(0);
  });

  it('旧式（サイズ省略）: w/h=0 で記録', () => {
    const r = parseAozora('［＃挿絵（fig.png）入る］');
    expect(r.text).toBe('');
    expect(r.images).toEqual([
      { pos: 0, alt: '挿絵', file: 'fig.png', w: 0, h: 0 },
    ]);
  });

  it('キャプション付きの図: 説明は原文のまま alt へ', () => {
    const r = parseAozora(
      '［＃「表題」のキャプション付きの図（fig2.jpg、横100×縦80）入る］',
    );
    expect(r.images).toEqual([
      {
        pos: 0,
        alt: '「表題」のキャプション付きの図',
        file: 'fig2.jpg',
        w: 100,
        h: 80,
      },
    ]);
  });

  it('全角数字の横×縦も読める', () => {
    const r = parseAozora('［＃地図（map.png、横４００×縦３００）入る］');
    expect(r.images[0]).toMatchObject({ w: 400, h: 300 });
  });
});

describe('parseAozora — キャプション注記（v0.9）', () => {
  it('前方参照型: 直前の対象へ小字 fontSize mark', () => {
    const r = parseAozora('図一の説明［＃「図一の説明」はキャプション］', {
      captionFs: 3,
    });
    expect(r.text).toBe('図一の説明');
    expect(r.marks).toEqual([
      { start: 0, end: 5, attrs: { fontSize: 3 } },
    ]);
    expect(r.handled).toBe(1);
    expect(r.dropped).toBe(0);
  });

  it('開始/終了型: 囲まれた範囲へ小字 fontSize mark', () => {
    const r = parseAozora(
      '前［＃キャプション］図の説明［＃キャプション終わり］後',
      { captionFs: 3 },
    );
    expect(r.text).toBe('前図の説明後');
    expect(r.marks).toEqual([
      { start: 1, end: 5, attrs: { fontSize: 3 } },
    ]);
  });

  it('複数行型: 注記行を畳んで囲まれた範囲へ mark', () => {
    const r = parseAozora(
      '前。\n［＃ここからキャプション］\n図の説明\n［＃ここでキャプション終わり］\n後。',
      { captionFs: 3 },
    );
    expect(r.text).toBe('前。\n図の説明\n後。');
    // 範囲はブロック行末の改行まで含む（行ごと小字の帯として扱う）
    expect(r.marks).toEqual([
      { start: 3, end: 8, attrs: { fontSize: 3 } },
    ]);
    expect(r.handled).toBe(2);
  });

  it('閉じない開始注記は文書末までを範囲とみなす', () => {
    const r = parseAozora('［＃キャプション］残り全部', { captionFs: 3 });
    expect(r.marks).toEqual([
      { start: 0, end: 4, attrs: { fontSize: 3 } },
    ]);
  });
});

describe('parseAozora — 凹凸字下げ・地付き/地寄せ（v0.12）', () => {
  it('ここから○字下げ、折り返して●字下げ: 行頭はスペース・折返しは mark', () => {
    const r = parseAozora(
      '前。\n［＃ここから２字下げ、折り返して３字下げ］\n去年\n一昨年\n［＃ここで字下げ終わり］\n後。',
    );
    expect(r.text).toBe('前。\n　　去年\n　　一昨年\n後。');
    expect(r.marks).toEqual([
      { start: 3, end: 14, attrs: { hangIndent: 3 } },
    ]);
    expect(r.handled).toBe(2);
    expect(r.dropped).toBe(0);
  });

  it('ここから改行天付き、折り返して○字下げ: 行頭 indent なし', () => {
    const r = parseAozora(
      '［＃ここから改行天付き、折り返して１字下げ］\n一\n二\n［＃ここで字下げ終わり］',
    );
    expect(r.text).toBe('一\n二');
    expect(r.marks).toEqual([
      { start: 0, end: 4, attrs: { hangIndent: 1 } },
    ]);
    expect(r.handled).toBe(2);
  });

  it('ここから折り返して○字下げ（省略形）も同じく受理', () => {
    const r = parseAozora(
      '［＃ここから折り返して１字下げ］\nあ\n［＃ここで字下げ終わり］',
    );
    expect(r.text).toBe('あ');
    // ブロック mark は閉じ注記の位置＝前行の改行まで含む
    expect(r.marks).toEqual([
      { start: 0, end: 2, attrs: { hangIndent: 1 } },
    ]);
    expect(r.handled).toBe(2);
  });

  it('凹凸ブロックの切替 — ［＃ここから○字下げ］で前の折返しを閉じる', () => {
    const r = parseAozora(
      '［＃ここから改行天付き、折り返して１字下げ］\nあ\n［＃ここから２字下げ］\nい\n［＃ここで字下げ終わり］',
    );
    expect(r.text).toBe('あ\n　　い');
    expect(r.marks).toEqual([
      { start: 0, end: 2, attrs: { hangIndent: 1 } },
    ]);
  });

  it('［＃地付き］行頭: その行へ bottomLift 0 の mark', () => {
    const r = parseAozora('前。\n［＃地付き］（この日記終り）');
    expect(r.text).toBe('前。\n（この日記終り）');
    expect(r.marks).toEqual([
      { start: 3, end: 11, attrs: { bottomLift: 0 } },
    ]);
    expect(r.handled).toBe(1);
  });

  it('［＃地付き］行中: 残りを別行へ分断して下端揃え', () => {
    const r = parseAozora(
      '二人はそれぎり黙って風呂へはいった。［＃地付き］（掲載誌不詳）',
    );
    expect(r.text).toBe(
      '二人はそれぎり黙って風呂へはいった。\n（掲載誌不詳）',
    );
    expect(r.marks).toEqual([
      { start: 19, end: 26, attrs: { bottomLift: 0 } },
    ]);
    expect(r.handled).toBe(1);
  });

  it('［＃地から○字上げ］: 上げ幅を bottomLift へ', () => {
    const r = parseAozora('［＃地から２字上げ］長谷川辰之助');
    expect(r.text).toBe('長谷川辰之助');
    expect(r.marks).toEqual([
      { start: 0, end: 6, attrs: { bottomLift: 2 } },
    ]);
  });

  it('ブロック地付き: ［＃ここから地付き］…［＃ここで地付き終わり］', () => {
    const r = parseAozora(
      '［＃ここから地付き］\nあ\nい\n［＃ここで地付き終わり］',
    );
    expect(r.text).toBe('あ\nい');
    expect(r.marks).toEqual([
      { start: 0, end: 4, attrs: { bottomLift: 0 } },
    ]);
    expect(r.handled).toBe(2);
  });

  it('ブロック地寄せ: ［＃ここから地から○字上げ］…［＃ここで字上げ終わり］', () => {
    const r = parseAozora(
      '［＃ここから地から１字上げ］\nあ\n［＃ここで字上げ終わり］',
    );
    expect(r.marks).toEqual([
      { start: 0, end: 2, attrs: { bottomLift: 1 } },
    ]);
  });

  it('天付きは既定扱いで受理（mark は付かない）', () => {
    const r = parseAozora('［＃天付き］本文');
    expect(r.text).toBe('本文');
    expect(r.marks).toEqual([]);
    expect(r.handled).toBe(1);
    const b = parseAozora(
      '［＃ここから天付き］\nあ\n［＃ここで天付き終わり］',
    );
    expect(b.text).toBe('あ');
    expect(b.marks).toEqual([]);
    expect(b.handled).toBe(2);
  });

  it('閉じない地付きブロックは文書末までを範囲とみなす', () => {
    const r = parseAozora('［＃ここから地付き］\n末まで');
    expect(r.marks).toEqual([
      { start: 0, end: 3, attrs: { bottomLift: 0 } },
    ]);
  });
});
