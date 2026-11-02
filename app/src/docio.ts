// 独自書庫形式 — .chkpf（cucul hart kusuma plava format。
// zip: doc.json + img/ バイナリ。旧称 .slm — 読込は両対応）
// 画像オブジェクトの dataURL は書庫化時に img/N.ext へ分離し、
// data.url を 'asset:img/N.ext' 参照に置き換える。

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { WorldObject } from '@kimetron/core';
import type { Chain, PageModel } from 'inimbal';
import {
  DEFAULT_GRID_COLOR,
  IMG_KIND,
  type GenkoGrid,
  type ImageData,
  type PageMargins,
} from './types';

export const ARCHIVE_FORMAT = 'silim-murlun/1';

const okMm = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 80;

/** 版面マージンの検証 — 新形式 margins（天地・ノド・小口）を優先、
    旧形式 marginMm（四方共通）は四辺へ展開して引き継ぐ */
function unpackMargins(doc: ArchiveDoc): PageMargins | undefined {
  const m = doc.margins;
  if (
    m &&
    okMm(m.top) &&
    okMm(m.bottom) &&
    okMm(m.inside) &&
    okMm(m.outside)
  )
    return {
      top: m.top,
      bottom: m.bottom,
      inside: m.inside,
      outside: m.outside,
    };
  const u = doc.marginMm;
  if (okMm(u)) return { top: u, bottom: u, inside: u, outside: u };
  return undefined;
}
export const ARCHIVE_EXT = '.chkpf';

interface ArchiveDoc {
  format: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  paper: PageModel['spec'];
  pages: PageModel['pages'];
  // テキストエリアの組方向は objects[].data.writing として保存される
  // （TextAreaData.writing）。欠落 = 'horizontal' 扱いで後方互換 —
  // 書庫フォーマット自体の変更はない
  objects: WorldObject[];
  chains: Chain[];
  footer: boolean;
  pageOpacity: number;
  docFont?: string;
  docColor?: string;
  /** ページ番号（ノンブル）を印刷に出すか（v0.3。欠落=false） */
  pageNum?: boolean;
  /** 升目を印刷に出すか（v0.3。欠落=true — 旧書庫は WYSIWYG 印刷だった） */
  gridPrint?: boolean;
  /** 1ページあたりの升目数（v0.5 — cells=1段の字数・cols=段数。
      欠落=20×20。data.genko を持つ升目枠エリアがこの仕様に追従する） */
  genko?: GenkoGrid;
  /** 升目線の色（#rrggbb）と濃さ 0〜1（v0.6。
      欠落=DEFAULT_GRID_COLOR・1 — 従来の薄いグレー） */
  gridColor?: string;
  gridAlpha?: number;
  /** 升目マスの背景色（#rrggbb）と濃さ 0〜1（v0.9。
      欠落=#ffffff・0 — 用紙色のまま） */
  gridBg?: string;
  gridBgAlpha?: number;
  /** v0.9: 用紙色（#rrggbb）。欠落=#ffffff */
  paperColor?: string;
  /** 柱 — 天余白へ出す走り書き（v0.7。欠落・空=出さない） */
  hashira?: string;
  /** v0.9: 版面マージン（天・地・ノド・小口・mm）。欠落=20mm既定 */
  margins?: PageMargins;
  /** 旧フィールド — 四方共通マージン。margins への移行用 */
  marginMm?: number;
}

const EXT_OF_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

const MIME_OF_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

function base64ToU8(b64: string): Uint8Array {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

function u8ToBase64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) {
    s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** ドキュメント → zip バイナリ */
export function packArchive(input: {
  spec: PageModel['spec'];
  pages: PageModel['pages'];
  objects: WorldObject[];
  chains: Chain[];
  footer: boolean;
  title: string;
  createdAt: string;
  pageOpacity: number;
  docFont?: string;
  docColor?: string;
  pageNum?: boolean;
  gridPrint?: boolean;
  genko?: GenkoGrid;
  gridColor?: string;
  gridAlpha?: number;
  gridBg?: string;
  gridBgAlpha?: number;
  paperColor?: string;
  hashira?: string;
  margins?: PageMargins;
}): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  let imgN = 0;
  const objects = input.objects.map((o) => {
    if (o.kind !== IMG_KIND) return o;
    const d = o.data as ImageData;
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(d.url);
    if (!m) return o;
    const path = `img/${imgN++}.${EXT_OF_MIME[m[1]] ?? 'bin'}`;
    files[path] = base64ToU8(m[2]);
    return { ...o, data: { ...d, url: `asset:${path}` } };
  });
  const doc: ArchiveDoc = {
    format: ARCHIVE_FORMAT,
    title: input.title,
    createdAt: input.createdAt,
    updatedAt: new Date().toISOString(),
    paper: input.spec,
    pages: input.pages,
    objects,
    chains: input.chains,
    footer: input.footer,
    pageOpacity: input.pageOpacity,
    docFont: input.docFont,
    docColor: input.docColor,
    pageNum: input.pageNum,
    gridPrint: input.gridPrint,
    genko: input.genko,
    gridColor: input.gridColor,
    gridAlpha: input.gridAlpha,
    gridBg: input.gridBg,
    gridBgAlpha: input.gridBgAlpha,
    paperColor: input.paperColor,
    // 空文字は書き出さない（unpack 側は欠落=空として畳む）
    hashira: input.hashira || undefined,
    margins: input.margins,
  };
  files['doc.json'] = strToU8(JSON.stringify(doc));
  return zipSync(files);
}

/** zip バイナリ → ドキュメント。形式不正なら throw。 */
export function unpackArchive(bytes: Uint8Array): {
  model: PageModel;
  objects: WorldObject[];
  chains: Chain[];
  footer: boolean;
  title: string;
  createdAt: string;
  pageOpacity: number;
  docFont?: string;
  docColor?: string;
  pageNum: boolean;
  gridPrint: boolean;
  /** v0.5: 升目仕様。欠落・不正値は undefined（呼び出し側が 20×20 へ畳む） */
  genko?: GenkoGrid;
  /** v0.6: 升目線の色と濃さ。欠落・不正値は既定（薄いグレー・濃さ1） */
  gridColor: string;
  gridAlpha: number;
  /** v0.9: 升目マスの背景色+濃さ。欠落=#ffffff・0 */
  gridBg?: string;
  gridBgAlpha?: number;
  /** v0.9: 用紙色。欠落=#ffffff */
  paperColor?: string;
  /** v0.7: 柱 — 天余白へ出す走り書き。欠落・非文字列は空（出さない） */
  hashira: string;
  margins?: PageMargins;
} {
  const files = unzipSync(bytes);
  const raw = files['doc.json'];
  if (!raw) throw new Error('doc.json が書庫にありません');
  const doc = JSON.parse(strFromU8(raw)) as ArchiveDoc;
  if (doc.format !== ARCHIVE_FORMAT) {
    throw new Error(`未対応の書庫形式: ${doc.format}`);
  }
  const objects = (doc.objects ?? []).map((o) => {
    if (o.kind !== IMG_KIND) return o;
    const d = o.data as ImageData;
    const m = /^asset:(.+)$/.exec(d.url);
    if (!m || !files[m[1]]) return o;
    const ext = m[1].split('.').pop() ?? '';
    const mime = MIME_OF_EXT[ext] ?? 'application/octet-stream';
    return {
      ...o,
      data: { ...d, url: `data:${mime};base64,${u8ToBase64(files[m[1]])}` },
    };
  });
  return {
    model: { spec: doc.paper, pages: doc.pages ?? [] },
    objects,
    chains: doc.chains ?? [],
    footer: doc.footer !== false,
    title: doc.title ?? '',
    createdAt: doc.createdAt ?? '',
    pageOpacity: doc.pageOpacity ?? 100,
    docFont: doc.docFont,
    docColor:
      typeof doc.docColor === 'string' &&
      /^#[0-9a-fA-F]{6}$/.test(doc.docColor)
        ? doc.docColor
        : undefined,
    // v0.3 追加項目 — 欠落時は v0.2 までの既定挙動を再現する
    // （ページ番号なし / 升目は印刷に出る）
    pageNum: doc.pageNum === true,
    gridPrint: doc.gridPrint !== false,
    // v0.5: 升目仕様 — 1〜100 の整数以外（旧書庫の欠落含む）は捨てる
    genko:
      doc.genko &&
      Number.isInteger(doc.genko.cells) &&
      Number.isInteger(doc.genko.cols) &&
      doc.genko.cells >= 1 &&
      doc.genko.cells <= 100 &&
      doc.genko.cols >= 1 &&
      doc.genko.cols <= 100
        ? {
            cells: doc.genko.cells,
            cols: doc.genko.cols,
            // v0.6: 段数1〜3・段間mm — 欠落・不正は既定(1段/7mm)へ
            ...(Number.isInteger(doc.genko.columns ?? 0) &&
            (doc.genko.columns ?? 0) >= 1 &&
            (doc.genko.columns ?? 0) <= 3
              ? { columns: doc.genko.columns }
              : {}),
            ...(typeof doc.genko.gapMm === 'number' &&
            doc.genko.gapMm >= 0 &&
            doc.genko.gapMm <= 40
              ? { gapMm: doc.genko.gapMm }
              : {}),
          }
        : undefined,
    // v0.6: 升目線の色+濃さ — #rrggbb と 0〜1 の有限数以外は既定へ畳む
    gridColor:
      typeof doc.gridColor === 'string' &&
      /^#[0-9a-fA-F]{6}$/.test(doc.gridColor)
        ? doc.gridColor
        : DEFAULT_GRID_COLOR,
    gridAlpha:
      typeof doc.gridAlpha === 'number' &&
      Number.isFinite(doc.gridAlpha) &&
      doc.gridAlpha >= 0 &&
      doc.gridAlpha <= 1
        ? doc.gridAlpha
        : 1,
    gridBg:
      typeof doc.gridBg === 'string' &&
      /^#[0-9a-fA-F]{6}$/.test(doc.gridBg)
        ? doc.gridBg
        : undefined,
    gridBgAlpha:
      typeof doc.gridBgAlpha === 'number' &&
      Number.isFinite(doc.gridBgAlpha) &&
      doc.gridBgAlpha >= 0 &&
      doc.gridBgAlpha <= 1
        ? doc.gridBgAlpha
        : undefined,
    paperColor:
      typeof doc.paperColor === 'string' &&
      /^#[0-9a-fA-F]{6}$/.test(doc.paperColor)
        ? doc.paperColor
        : undefined,
    // v0.7: 柱 — 文字列以外（旧書庫の欠落含む）は空 = 出さない
    hashira: typeof doc.hashira === 'string' ? doc.hashira : '',
    margins: unpackMargins(doc),
  };
}
