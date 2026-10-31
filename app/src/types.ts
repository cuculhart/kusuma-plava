// アプリ共有の型・定数

import type { Engine, WorldObject } from '@kimetron/core';
import type { WritingMode } from 'inimbal';

export const MM_PX = 96 / 25.4; // 1mm = 96/25.4 px (96dpi 実寸)

export const PAGE_KIND = 'page';
export const TEXT_KIND = 'textarea';
export const IMG_KIND = 'image';

export interface ImageData {
  /** 画像ソース（dataURL。書庫化・印刷でそのまま使える） */
  url: string;
  /** 高さ/幅 のアスペクト比（配置時点の値） */
  aspect: number;
  /** mm サイズ編集で縦横を連動させるか */
  lock: boolean;
}

/** テキストエリアの内側パディング（mm）— 計測・描画で共用 */
export const TEXT_PAD_MM = 1;
/** 行高さ係数（fontSize に対する倍率）— 計測・描画で共用 */
export const LINE_HEIGHT = 1.4;

/** 升目グリッド枠の升目数 — cells = 1段の字数（縦）、cols = 段数（横） */
export interface GenkoGrid {
  cells: number;
  cols: number;
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
