import { describe, expect, it } from 'vitest';
import {
  fitVertical,
  isEndKinsoku,
  isHeadKinsoku,
  RUBY_LANE_RATIO,
  tokenizeVertical,
} from '../src/tategaki';
import type { TextMark } from '../src/chain';

// テスト用ボックス: fontSize=4mm 基準。
// pitch = 4 × 1.6 = 6.4mm / 段、cap = height mm / 4mm セル
const box = (w: number, h: number, fontSize = 4) => ({
  id: 'a',
  width: w,
  height: h,
  fontSize,
  writing: 'vertical-rl' as const,
});

describe('tokenizeVertical — 組版単位の分解', () => {
  it('平文は1字1単位。raw の総和は text.length と一致', () => {
    const u = tokenizeVertical('あいうえお');
    expect(u).toHaveLength(5);
    expect(u.every((x) => x.kind === 'char' && x.cells === 1)).toBe(true);
    expect(u.reduce((n, x) => n + x.raw, 0)).toBe(5);
  });

  it('暗黙ルビ: 直前の漢字連続のみが親字（かなは含まない）', () => {
    const u = tokenizeVertical('彼の漢字《かんじ》を見る');
    const r = u.find((x) => x.kind === 'ruby');
    expect(r).toMatchObject({ text: '漢字', yomi: 'かんじ', cells: 2 });
    // ｜《》とヨミを含めた raw が正しく消費される
    expect(u.reduce((n, x) => n + x.raw, 0)).toBe('彼の漢字《かんじ》を見る'.length);
  });

  it('明示ルビ: ｜フレーズ《ヨミ》 はかな交じり・造語も親字にできる', () => {
    const u = tokenizeVertical('｜少年的な謎の生き物《フラクトギャルソン》');
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({
      kind: 'ruby',
      text: '少年的な謎の生き物',
      yomi: 'フラクトギャルソン',
      cells: 9,
    });
  });

  it('糖衣: 漢字(-よみ-) と [-親字-] (-よみ-) を正規ルビへ畳む', () => {
    const a = tokenizeVertical('運命(-さだめ-)と未来');
    expect(a[0]).toMatchObject({ kind: 'ruby', text: '運命', yomi: 'さだめ' });
    const b = tokenizeVertical('[-未来-] (-みらい-)を信じる');
    expect(b[0]).toMatchObject({ kind: 'ruby', text: '未来', yomi: 'みらい' });
  });

  it('半角英数ラン: ≤4字は tcy の1セル、長いランは1字1セルの rc', () => {
    const u = tokenizeVertical('AB型とFMR-Note機');
    expect(u[0]).toMatchObject({ tcy: true, cells: 1, text: 'AB', raw: 2 });
    const run = u.filter((x) => x.rc);
    expect(run).toHaveLength(8); // FMR-Note = 8字（>4 → rc 分解）
    expect(u.reduce((n, x) => n + x.raw, 0)).toBe('AB型とFMR-Note機'.length);
  });

  it('改行は brk 単位（セルを消費しない）', () => {
    const u = tokenizeVertical('あ\nい');
    expect(u[1]).toMatchObject({ kind: 'brk', cells: 0 });
  });
});

describe('fitVertical — 単位カウントの収容計算', () => {
  // pitch 6.4mm × 2段、cap 10セル（40mm）
  const two = () => box(12.8, 40);

  it('段数×字詰めで切る。残りは次エリアへ', () => {
    expect(fitVertical('あ'.repeat(25), two())).toBe(20);
    expect(fitVertical('あ'.repeat(15), two())).toBe(15);
  });

  it('\\n は段送り — 段を1つ消費する', () => {
    // col0: あいうえお + \n → col1: かきくけこ
    expect(fitVertical('あいうえお\nかきくけこ', two())).toBe(11);
    // 段数を使い切ると打ち切り（\n 自体は消費する）
    expect(fitVertical('あ\nい\nうえ', two())).toBe(4);
  });

  it('ルビはヨミを数えず親字数だけセルを消費する（不可分単位）', () => {
    // ｜運命《さだめ》 = raw 8 / 2セル — 5セルで全文(raw 11)収まる
    expect(fitVertical('｜運命《さだめ》と歩む', box(6.4, 40))).toBe(11);
    // cap 1セルしかない段には入らない → 強制配置して消費
    expect(fitVertical('｜運命《さだめ》', box(6.4, 4))).toBe(8);
  });

  it('縦中横（≤4字ラン）は1セルとして数える', () => {
    // 'あいABうえ' = ABが1セルで計5セル → 段1本にちょうど収まる（raw 6）
    expect(fitVertical('あいABうえおかきくけこさし', box(6.4, 20))).toBe(6);
  });

  it('marks のラン fontSize で単位の占有高が変わる', () => {
    const marks: TextMark[] = [{ start: 0, end: 10, attrs: { fontSize: 8 } }];
    // 8mm 字は1字2セル分 → 10セル段1本に5字
    const b = { ...box(6.4, 40), marks };
    expect(fitVertical('あ'.repeat(10), b)).toBe(5);
  });
});

describe('fitVertical — 禁則の境界調整（最大2単位前倒し）', () => {
  // cap 5セル（20mm）× 2段
  const two = () => box(12.8, 20);

  it('行頭禁則: 句点が段頭に来ないよう前の字を送る', () => {
    // col0 は「あいうえお」で満杯 → 「。」を次段頭にしないため「お。」を送る
    // col0=あいうえ(4) / col1=お。かき(4) → 8字
    expect(fitVertical('あいうえお。かき', two())).toBe(8);
  });

  it('行末禁則: 開き括弧は段末に残さず次段へ送る', () => {
    // col0「あいうえお」満杯・次が「『」…ではなく「『」が段末になった場合を検証:
    // col0=あいうえ(4)? — 「お『かき」では「お」まで5字目、『は次段頭へ
    expect(fitVertical('あいうえ『かきくけこさしすせそ', two())).toBe(9);
  });

  it('連続する禁則は最大2単位まで前倒し', () => {
    // col0 満杯後「。」が2つ続く — 「お」だけ前倒しで送り、
    // 「お。。かき」が次段へ（行頭回避は先頭1字分）
    expect(fitVertical('あいうえお。。かき', two())).toBe(9);
  });

  it('小さい仮名も行頭禁則 — 段頭に来ない', () => {
    expect(isHeadKinsoku('っ')).toBe(true);
    // col0=あいうえ(4) / col1=おっかきく(5) → 9字
    expect(fitVertical('あいうえおっかきく', two())).toBe(9);
  });
});

describe('禁則テーブル', () => {
  it('行頭禁則: 句読点・閉じ括弧・繰返し・半角記号', () => {
    for (const ch of '。、・！？)]」』〜々ー…') {
      expect(isHeadKinsoku(ch), ch).toBe(true);
    }
    for (const ch of 'abcあ「（') {
      expect(isHeadKinsoku(ch), ch).toBe(false);
    }
  });

  it('行末禁則: 開き括弧のみ', () => {
    for (const ch of '（「『［｛〈《([{') {
      expect(isEndKinsoku(ch), ch).toBe(true);
    }
    for (const ch of 'あ。、') {
      expect(isEndKinsoku(ch), ch).toBe(false);
    }
  });

  it('RUBY_LANE_RATIO は段ピッチ係数（0.6）', () => {
    expect(RUBY_LANE_RATIO).toBe(0.6);
  });
});
