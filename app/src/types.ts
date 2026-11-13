// アプリ共有の型・定数

import type { Engine, WorldObject } from '@kimetron/core';
import type { WritingMode } from 'inimbal';

export const MM_PX = 96 / 25.4; // 1mm = 96/25.4 px (96dpi 実寸)

export const PAGE_KIND = 'page';
export const TEXT_KIND = 'textarea';
export const IMG_KIND = 'image';

export interface ImageData {
  /** 画像ソース（dataURL。書庫化・印刷でそのまま使える）。
      空文字 = 未割当のプレースホルダ枠（青空画像注記由来 — v0.9） */
  url: string;
  /** 高さ/幅 のアスペクト比（配置時点の値） */
  aspect: number;
  /** mm サイズ編集で縦横を連動させるか */
  lock: boolean;
  /** プレースホルダ情報 — 青空文庫の画像注記
      `［＃説明（file、横○×縦○）入る］` から生成した空枠の印。
      url 空の間は枠内に alt を描き、選択中の画像貼り付け/読込や
      枠上への配置ドロップでその枠へ充填する。
      空枠は注記と常に同期する（App.tsx の同期エフェクト —
      注記が消えた未割当枠は自動削除、注記が増えたぶんは自動生成）。
      充填後も注記の出自として残る（alt 転用） */
  placeholder?: {
    /** 説明文（「…」のキャプション付きの図 等の原文） */
    alt: string;
    /** 注記内のファイル名（割当の目安。実体は txt に含まれない） */
    file: string;
    /** 出自の連鎖 id — 空枠↔注記の対応付けに使う */
    chain: string;
    /** 生成時点の変換後テキスト上の注記位置（枠の並び順用） */
    pos: number;
    /** 注記頁に収まらず次頁へ送られた — このときだけ自身の
        帯を立てる（注記頁では注記ゾーンが塞ぐため帯は不要。
        帯が画像に追従すると組版→アンカー→帯と揺れて振動する） */
    nextPage?: boolean;
    /** v0.13 撤去後の残存フィールド — キャプション対応付けは
        廃止したが、保存済み文書のデータ互換のため型は残す
        （新規には付与しない） */
    caption?: string;
    capFs?: number;
  };
  /** v0.9: 回り込みしない（青空注記由来の画像は注記に回り込み
      指定が無いためブロック扱い — テキストは画像の縦帯を全幅で
      よける。アプリで差し込んだ画像は false/未設定で回り込む） */
  noWrap?: boolean;
  /** v1.2: キャプション欄 — メモとして doc へ保持するだけ
      （レンダリングはしない。将来の組版へ繋ぐ下地） */
  caption?: string;
}

/** テキストエリアの内側パディング（mm）— 計測・描画で共用 */
export const TEXT_PAD_MM = 1;
/** 行高さ係数（fontSize に対する倍率）— 計測・描画で共用 */
export const LINE_HEIGHT = 1.4;

/** 升目グリッド枠の升目数 — cells = 1段の字数（縦）、cols = 段数（横） */
/** v0.9: 版面マージン — 天・地・ノド・小口（mm）。ノドは綴じ側で
    ページの左右で反転するため inside/outside で保持する */
export interface PageMargins {
  top: number;
  bottom: number;
  inside: number;
  outside: number;
}

export interface GenkoGrid {
  cells: number;
  cols: number;
  /** 段数（1〜3、欠落=1段） — v0.6 */
  columns?: number;
  /** 段間（mm、欠落=7mm） — v0.6 */
  gapMm?: number;
}

export interface TextAreaData {
  /** フォントサイズ（mm） */
  fontSize: number;
  /** フォントファミリ（CSS 名） */
  fontFamily: string;
  /** 文字色 */
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** 縦揃え（単独エリアのみ有効 — 連鎖エリアは常に top） */
  valign?: 'top' | 'middle' | 'bottom';
  /** 横揃え（単独エリアのみ有効 — 連鎖エリアは常に left） */
  halign?: 'left' | 'center' | 'right';
  /** エリア全体の URL リンク（印刷/PDF で <a> 化） */
  link?: string;
  /** 組方向。省略時は 'horizontal' 扱い（旧書庫との後方互換）。
      新規エリアは生成時に 'vertical-rl' を明示して持つ */
  writing?: WritingMode;
  /** buildWritingDoc が版面を覆って自動生成したエリアの印（出所の記録。
      用紙変更時の追従判定自体は版面との矩形一致で行う — App.tsx の
      refitWritingAreas 参照。ユーザーが手で作ったエリアには付かない） */
  auto?: boolean;
  /** 升目グリッド枠の印 — buildWritingDoc/400字詰プリセットが生成する
      cells×cols の原稿用紙枠。枠の内寸はちょうど升目分で、用紙変更時に
      字サイズ・中央寄せ位置を再計算して追従する（refitWritingAreas 参照） */
  genko?: GenkoGrid;
  /** 段組の段番号 — 上段=0 から下へ増える（v0.6。欠落=単段の旧枠） */
  col?: number;
}

/** アプリ既定フォント — Noto Serif JP 優先、無い環境は OS の明朝系へ落ちる
    （CSS フォントスタックとして保存・計測・印刷でそのまま使う） */
export const DEFAULT_FONT_FAMILY =
  "'Noto Serif JP', 'Yu Mincho', 'Hiragino Mincho ProN', serif";

export const DEFAULT_TEXT_DATA: TextAreaData = {
  fontSize: 4,
  fontFamily: DEFAULT_FONT_FAMILY,
  color: '#222222',
};

/** 升目グリッド線の既定色 — styles.css の rgba(120,140,160) と同色 */
export const DEFAULT_GRID_COLOR = '#788ca0';
/** v0.9: 升目マスの背景色（塗り）既定 — 白・透過0%=用紙色のまま */
export const DEFAULT_GRID_BG = '#ffffff';
/** 升目線（升目枠 / ルビ欄）の基準濃さ — 文書設定の透過値に乗算する。
    透過 100% で従来の見た目（0.45 / 0.18）を再現する */
export const GRID_CELL_ALPHA = 0.45;
export const GRID_LANE_ALPHA = 0.18;

/** v1.1: 升目デザイン — masu=升目（既定）/ tate=段罫のみ
    （字の横線を抜く）/ none=罫なし */
export type GenkoStyle = 'masu' | 'tate' | 'none';

/** v1.1: 会話「」色分けの既定色 — 白い紙でも暗い紙でも読める中間の水色 */
export const DEFAULT_DIALOG_COLOR = '#0f8f7a';

/** v1.2: 傍点の種別 — TextAttrs.boten は CSS text-emphasis 値
    （true = 旧マーク互換の既定 sesame）。縦組はよみがな扱いで
    ルビ欄へ字形を出すため対応表が要る */
export const BOTEN_RT: Record<string, string> = {
  sesame: '・', // 傍点・黒ゴマ（既定）
  'open sesame': '◦', // 白ゴマ
  'filled circle': '●', // 黒丸
  'open circle': '○', // 白丸
  'open double-circle': '◎', // 二重丸
  'filled double-circle': '◉', // 蛇の目
  "'×'": '×', // ばってん
};
/** TextAttrs.boten → CSS text-emphasis 値（横組・印刷用） */
export const botenCss = (b?: true | string): string | undefined =>
  b === true ? 'sesame' : b || undefined;
/** TextAttrs.boten → 縦組のルビ欄へ出す字形 */
export const botenRt = (b?: true | string): string | undefined =>
  b ? (BOTEN_RT[b === true ? 'sesame' : b] ?? '・') : undefined;

/** 文書設定の升目線色+濃さ → CSS 変数（--grid-line/--lane-line）用の
    rgba() 文字列。color が #rrggbb と解釈できない値は既定色へ畳む */
export function gridLineCss(color: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})/.exec(color);
  const [r, g, b] = m
    ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
    : [120, 140, 160];
  const a = Math.min(1, Math.max(0, alpha));
  return `rgba(${r},${g},${b},${a})`;
}

export const FONT_SIZES_MM = [3, 4, 5, 7, 9];
export const FONT_FAMILIES = [
  { value: "'Noto Serif JP'", label: 'Noto Serif JP' },
  { value: 'sans-serif', label: 'Sans-serif' },
  { value: 'serif', label: 'Serif' },
  { value: 'monospace', label: 'Monospace' },
];

/** ドラッグ/リサイズ中のライブ矩形。
    kimetron dom の objectFrame と同じプレビュー規則をモデル側へ適用する。 */
export function liveRect(
  engine: Engine,
  o: WorldObject,
): { x: number; y: number; w: number; h: number } {
  const rr =
    engine.resize && engine.resize.id === o.id
      ? { ...o, ...engine.resize.rect }
      : o;
  const d =
    engine.dragDelta && engine.selectedIds.has(o.id)
      ? engine.dragDelta
      : { x: 0, y: 0 };
  return { x: rr.x + d.x, y: rr.y + d.y, w: rr.w, h: rr.h };
}
