// 印刷展開 — 同一ドキュメント内オーバーレイ。
// ページごとに版面だけを実寸（mm）で並べ、n / 全ページ のフッターを付ける。
// @media print で編集画面を隠し、@page で用紙サイズ・向きを動的設定する。

import {
  catmullRomPolyline,
  renderOrder,
  type WorldObject,
} from '@kimetron/core';
import {
  pageRects,
  paperDims,
  RUBY_LANE_RATIO,
  type PageModel,
  type TextRun,
  type VFlow,
  type VUnit,
} from 'inimbal';
import {
  botenCss,
  botenRt,
  DEFAULT_TEXT_DATA,
  GRID_CELL_ALPHA,
  GRID_LANE_ALPHA,
  gridLineCss,
  IMG_KIND,
  LINE_HEIGHT,
  MM_PX,
  PAGE_KIND,
  TEXT_KIND,
  TEXT_PAD_MM,
  type ImageData,
  type TextAreaData,
} from './types';
import { vunitSpans, type VStyle } from './vtrender';

const intersects = (
  o: WorldObject,
  p: { x: number; y: number; w: number; h: number },
) => o.x < p.x + p.w && o.x + o.w > p.x && o.y < p.y + p.h && o.y + o.h > p.y;

export function Printout({
  model,
  footer,
  pageNum,
  gridPrint,
  gridColor,
  gridAlpha,
  genkoStyle,
  hashiraFor,
  hashiraRect,
  hashiraFont,
  hashiraColor,
  objects,
  sliceRuns,
  unitsFor,
  areaAlone,
  vflowFor,
  onPrint,
  onClose,
  t,
}: {
  model: PageModel;
  footer: boolean;
  /** v0.3: ページ番号（ノンブル）— 版面下端中央に 1 始まりで出す */
  pageNum: boolean;
  /** v0.3: 升目の印刷出し分け — OFF で縦書き升目グリッドを抜く */
  gridPrint: boolean;
  /** v0.6: 升目線の色（#rrggbb）と濃さ 0〜1 — 文書設定 */
  gridColor: string;
  gridAlpha: number;
  /** v1.1: 升目デザイン — masu / tate（段罫のみ）/ none（罫なし） */
  genkoStyle: 'masu' | 'tate' | 'none';
  /** v0.7: 柱 — 天余白へ出す走り書き（空=出さない）。矩形は文書設定の
      升目仕様から App 側で計算済みのページローカル mm、書体は文書既定。
      v0.11: 章ごと版 — 頁 index → 柱文字列の resolver（章境界のある
      頁は章名、無い頁は doc 設定の柱が返る。App 側で解決済み） */
  hashiraFor: (pageIndex: number) => string;
  hashiraRect: { top: number; right: number; height: number; size: number };
  hashiraFont: string;
  /** v0.11: 柱・ノンブルの色 — 文書既定文字色に連動（暗い紙で埋もれない） */
  hashiraColor: string;
  objects: WorldObject[];
  /** テキストエリア → 表示中スライスのラン列（連鎖レイアウト＋装飾解決済み） */
  sliceRuns: (o: WorldObject) => TextRun[];
  /** v0.10: テキストエリア → 表示中スライスの組版単位列（marks 駆動の
      ルビを含む — 編集画面と同じトークン化を App 側で行って渡す） */
  unitsFor: (o: WorldObject) => VUnit[];
  /** 単独（非連鎖）テキストエリアか — 揃えは単独のみ有効 */
  areaAlone: (o: WorldObject) => boolean;
  /** v0.4: 回しこみ — 障害のある縦書きスライスの段×区間計画。
      非 null のとき段区間を絶対配置で描く（編集画面と同じ分割） */
  vflowFor: (o: WorldObject) => VFlow | null;
  onPrint: () => void;
  onClose: () => void;
  t: (key: string) => string;
}) {
  const rects = pageRects(model.spec, model.pages);
  const { spec } = model;
  const content = renderOrder(objects).filter((o) => o.kind !== PAGE_KIND);
  // @page の名前付きサイズに無い判型（B6 等）は mm 実寸へフォールバック
  const dims = paperDims(spec);
  const pageSize = /^(A3|A4|A5|B5)$/.test(spec.size)
    ? `${spec.size} ${spec.landscape ? 'landscape' : 'portrait'}`
    : `${dims.w}mm ${dims.h}mm`;

  return (
    <div className="printout">
      <style>{`@page { size: ${pageSize}; margin: 0; }`}</style>
      <div className="pbar">
        <button onClick={onPrint}>{t('print.exec')}</button>
        <button onClick={onClose}>{t('print.close')}</button>
      </div>
      <div>
        {rects.map((pr) => (
          <div
            key={pr.id}
            className="ppage"
            style={{ width: `${pr.w}mm`, height: `${pr.h}mm` }}
          >
            {content.filter((o) => intersects(o, pr)).map((o) => {
              const left = o.x - pr.x;
              const top = o.y - pr.y;
              if (o.kind === IMG_KIND) {
                const d = o.data as ImageData;
                // v0.9: 未割当のプレースホルダ枠 — 編集画面と同じく
                // 破線枠＋説明文で出す（WYSIWYG。未割当が分かる）
                if (d.placeholder && !d.url)
                  return (
                    <div
                      key={o.id}
                      className="parea img-ph-print"
                      style={{
                        left: `${left}mm`,
                        top: `${top}mm`,
                        width: `${o.w}mm`,
                        height: `${o.h}mm`,
                      }}
                    >
                      <span>
                        {d.placeholder.alt || d.placeholder.file}
                      </span>
                    </div>
                  );
                return (
                  <img
                    key={o.id}
                    className="parea"
                    src={d.url}
                    alt={d.placeholder?.alt ?? ''}
                    style={{
                      left: `${left}mm`,
                      top: `${top}mm`,
                      width: `${o.w}mm`,
                      height: `${o.h}mm`,
                    }}
                  />
                );
              }
              if (o.kind === 'rect' || o.kind === 'ellipse') {
                const wMm = ((o.style?.width ?? 0) / MM_PX).toFixed(2);
                return (
                  <div
                    key={o.id}
                    className="parea"
                    style={{
                      left: `${left}mm`,
                      top: `${top}mm`,
                      width: `${o.w}mm`,
                      height: `${o.h}mm`,
                      background: o.style?.fill,
                      border: o.style?.stroke
                        ? `${wMm}mm ${o.style.dash ? (o.style.dash[0] <= 2 ? 'dotted' : 'dashed') : 'solid'} ${o.style.stroke}`
                        : 'none',
                      borderRadius: o.kind === 'ellipse' ? '50%' : undefined,
                    }}
                  />
                );
              }
              if (o.kind === 'line' || o.kind === 'curve') {
                const wMm = (o.style?.width ?? MM_PX * 0.5) / MM_PX;
                const anchors = o.shape?.points ?? [
                  { fx: 0, fy: 0 },
                  { fx: 1, fy: 1 },
                ];
                // 0サイズの <svg> は描画自体が無効化されるため下限を設ける。
                // viewBox を mm 実寸に合わせ、strokeWidth/dash/端子も mm 換算
                const vw = Math.max(o.w, 0.1);
                const vh = Math.max(o.h, 0.1);
                const col = o.style?.stroke ?? '#333';
                // viewBox ローカル mm に投影 — curve は Catmull-Rom で展開
                const lp = anchors.map((p) => ({
                  x: p.fx * vw,
                  y: p.fy * vh,
                }));
                const pp =
                  o.kind === 'curve' ? catmullRomPolyline(lp) : lp;
                const d = pp
                  .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`)
                  .join(' ');
                const ms = `pmk-${o.id}-s`;
                const me = `pmk-${o.id}-e`;
                // 端子は線幅比例（B6）— 0.5mm 基準サイズを維持しつつ
                // 太線ではマーカーが線の中に埋もれないよう拡大する
                const mk = Math.max(1, wMm / 0.5);
                const cap = (id: string, kind: string) =>
                  kind === 'arrow' ? (
                    <marker
                      id={id}
                      markerUnits="userSpaceOnUse"
                      orient="auto-start-reverse"
                      markerWidth={2.7 * mk}
                      markerHeight={2.2 * mk}
                      viewBox="0 0 2.6 2.1"
                      refX={2.4}
                      refY={1.05}
                    >
                      <path d="M 0 0 L 2.6 1.05 L 0 2.1 z" fill={col} />
                    </marker>
                  ) : (
                    <marker
                      id={id}
                      markerUnits="userSpaceOnUse"
                      orient="auto-start-reverse"
                      markerWidth={2.2 * mk}
                      markerHeight={2.2 * mk}
                      viewBox="0 0 2.1 2.1"
                      refX={1.05}
                      refY={1.05}
                    >
                      <circle cx={1.05} cy={1.05} r={0.8} fill={col} />
                    </marker>
                  );
                return (
                  <svg
                    key={o.id}
                    className="parea"
                    style={{
                      left: `${left}mm`,
                      top: `${top}mm`,
                      width: `${vw}mm`,
                      height: `${vh}mm`,
                      overflow: 'visible',
                    }}
                    viewBox={`0 0 ${vw} ${vh}`}
                    preserveAspectRatio="none"
                  >
                    <defs>
                      {o.style?.capStart && cap(ms, o.style.capStart)}
                      {o.style?.capEnd && cap(me, o.style.capEnd)}
                    </defs>
                    <path
                      d={d}
                      fill="none"
                      stroke={col}
                      strokeWidth={wMm}
                      strokeDasharray={o.style?.dash
                        ?.map((v) => v / MM_PX)
                        .join(' ')}
                      markerStart={
                        o.style?.capStart ? `url(#${ms})` : undefined
                      }
                      markerEnd={o.style?.capEnd ? `url(#${me})` : undefined}
                    />
                  </svg>
                );
              }
              if (o.kind === TEXT_KIND) {
                const d = { ...DEFAULT_TEXT_DATA, ...(o.data as TextAreaData) };
                const alone = areaAlone(o);
                const vertical = d.writing === 'vertical-rl';
                const runs = sliceRuns(o);
                // 縦書き: runs はスライスの厳密な分割なので join で
                // 原文が戻り、fitVertical と同じ分割へトークン化できる。
                // ラン境界にまたがる単位は先頭ランの装飾に寄せる（v0.1 簡約）
                // v0.4: 障害のあるスライスは段×区間計画で絶対配置 —
                // units の区間割当は計画の u0/u1 が指す
                const vflow = vertical ? vflowFor(o) : null;
                const units = vertical ? unitsFor(o) : null;
                const rbs = (() => {
                  let a = 0;
                  return runs.map((r) => {
                    const rb = { s: a, e: a + r.text.length, a: r.attrs };
                    a += r.text.length;
                    return rb;
                  });
                })();
                const vStyleOf = (p: number): VStyle => {
                  const r = rbs.find((x) => p < x.e) ?? rbs[rbs.length - 1];
                  const a = r?.a;
                  return {
                    css: {
                      fontSize: `${a?.fontSize ?? d.fontSize}mm`,
                      fontFamily: a?.fontFamily,
                      color: a?.link ? '#1a56c4' : (a?.color ?? d.color),
                      fontWeight: a?.bold ? 'bold' : undefined,
                      fontStyle: a?.italic ? 'italic' : undefined,
                      textDecoration: a?.bosen
                        ? `underline ${a.bosen}`
                        : a?.underline || a?.link
                          ? 'underline'
                          : undefined,
                      textUnderlinePosition: a?.bosen ? 'right' : undefined,
                      textEmphasis: botenCss(a?.boten),
                    },
                    boten: botenRt(a?.boten),
                    kei: a?.kei,
                    // 印刷は <a> で出す → PDF 書き出しでリンクが生きる
                    link: a?.link,
                    title: a?.link,
                  };
                };
                return (
                  <div
                    key={o.id}
                    className={
                      vertical
                        ? `parea vt${gridPrint ? '' : ' nogrid'}${
                            genkoStyle === 'masu'
                              ? ''
                              : ` gt-${genkoStyle}`
                          }`
                        : 'parea'
                    }
                    style={{
                      left: `${left}mm`,
                      top: `${top}mm`,
                      width: `${o.w}mm`,
                      height: `${o.h}mm`,
                      padding: `${TEXT_PAD_MM}mm`,
                      fontSize: `${d.fontSize}mm`,
                      // 縦書きは段ピッチ（字セル+ルビ欄）。inline 指定は
                      // CSS クラスに勝つため縦のときだけ差し替える
                      lineHeight: vertical ? 'var(--pitch)' : LINE_HEIGHT,
                      fontFamily: d.fontFamily,
                      fontWeight: d.bold ? 'bold' : undefined,
                      fontStyle: d.italic ? 'italic' : undefined,
                      textDecoration: d.underline ? 'underline' : undefined,
                      textAlign: alone ? d.halign : undefined,
                      ...(alone &&
                      (d.valign === 'middle' || d.valign === 'bottom')
                        ? {
                            display: 'flex',
                            flexDirection: 'column' as const,
                            justifyContent:
                              d.valign === 'middle' ? 'center' : 'flex-end',
                          }
                        : {}),
                      ...(vertical
                        ? ({
                            '--cell': `${d.fontSize}mm`,
                            '--lane': `${d.fontSize * RUBY_LANE_RATIO}mm`,
                            '--pitch': `${d.fontSize * (1 + RUBY_LANE_RATIO)}mm`,
                            // v0.6: 升目線の色+濃さ（文書設定）—
                            // キャンバス側と同じ規則で透過を乗算する
                            '--grid-line': gridLineCss(
                              gridColor,
                              gridAlpha * GRID_CELL_ALPHA,
                            ),
                            '--lane-line': gridLineCss(
                              gridColor,
                              gridAlpha * GRID_LANE_ALPHA,
                            ),
                          } as React.CSSProperties)
                        : {}),
                    }}
                  >
                    {vertical
                      ? vflow
                        ? vflow.segs.map((s, i) => (
                            <div
                              key={i}
                              className="vseg"
                              style={{
                                // .parea は position:absolute — 絶対配置の
                                // 基準は padding box なので内側余白ぶん
                                // TEXT_PAD を足して内容箱ローカルへ揃える。
                                // v0.12: padTop（折返し字下げ・地付き）は
                                // 区間を縮め、hang（ぶら下げ）は下端の
                                // はみ出しを clip しないよう延ばす
                                top: `${TEXT_PAD_MM + s.y + (s.padTop ?? 0)}mm`,
                                height: `${s.h - (s.padTop ?? 0) + (s.hang ?? 0)}mm`,
                                right: `${TEXT_PAD_MM + s.col * vflow.pitch}mm`,
                                width: `${vflow.pitch}mm`,
                              }}
                            >
                              {vunitSpans(
                                units!.slice(s.u0, s.u1),
                                vStyleOf,
                                s.h,
                              )}
                            </div>
                          ))
                        : vunitSpans(units!, vStyleOf)
                      : runs.map((r, i) => {
                      const span = (
                        <span
                          style={{
                            fontSize: `${r.attrs.fontSize ?? d.fontSize}mm`,
                            fontFamily: r.attrs.fontFamily,
                            color: r.attrs.link
                              ? '#1a56c4'
                              : (r.attrs.color ?? d.color),
                            fontWeight: r.attrs.bold ? 'bold' : undefined,
                            fontStyle: r.attrs.italic ? 'italic' : undefined,
                            textDecoration: r.attrs.bosen
                              ? `underline ${r.attrs.bosen}`
                              : r.attrs.underline || r.attrs.link
                                ? 'underline'
                                : undefined,
                            textEmphasis: botenCss(r.attrs.boten),
                            // v1.2: 罫囲み — ランごとの枠
                            boxShadow: r.attrs.kei
                              ? '0 0 0 1px'
                              : undefined,
                          }}
                        >
                          {r.text}
                        </span>
                      );
                      // 印刷は <a> で出す → PDF 書き出しでリンクが生きる
                      return r.attrs.link ? (
                        <a
                          key={i}
                          href={r.attrs.link}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {span}
                        </a>
                      ) : (
                        <span key={i}>{span}</span>
                      );
                    })}
                  </div>
                );
              }
              return null;
            })}
            {/* v0.9: フッター頁数表記は休眠（UI非表示・既定OFF） —
                残存値で残る旧書庫のゴースト表示を出さないため撤去 */}
            {/* v0.3: ページ番号（ノンブル）— 版面下端中央、1 始まり */}
            {pageNum && (
              <div className="pnum" style={{ color: hashiraColor }}>
                {pr.index + 1}
              </div>
            )}
            {/* v0.7: 柱 — 天余白・升目枠右辺揃えの縦書き（枠の上辺まで）。
                v0.11: 章境界のある頁は章名（hashiraFor） */}
            {hashiraFor(pr.index) !== '' && (
              <div
                className="hashira"
                style={{
                  top: `${hashiraRect.top}mm`,
                  right: `${hashiraRect.right}mm`,
                  fontSize: `${hashiraRect.size}mm`,
                  fontFamily: hashiraFont,
                  color: hashiraColor,
                }}
              >
                {hashiraFor(pr.index)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
