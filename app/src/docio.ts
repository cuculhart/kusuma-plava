// 独自書庫形式 — .slm（zip: doc.json + img/ バイナリ）
// 画像オブジェクトの dataURL は書庫化時に img/N.ext へ分離し、
// data.url を 'asset:img/N.ext' 参照に置き換える。

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { WorldObject } from '@kimetron/core';
import type { Chain, PageModel } from 'inimbal';
import { IMG_KIND, type ImageData } from './types';

export const ARCHIVE_FORMAT = 'silim-murlun/1';
export const ARCHIVE_EXT = '.slm';

interface ArchiveDoc {
  format: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  paper: PageModel['spec'];
  pages: PageModel['pages'];
  objects: WorldObject[];
  chains: Chain[];
  footer: boolean;
  pageOpacity: number;
  docFont?: string;
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
  };
}
