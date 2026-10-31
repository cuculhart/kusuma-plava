// ルーラー — アクティブページ枠の上辺・左辺に直接沿う mm 目盛り。
// ページ枠に貼り付くのでパン/ズームに連動。刻みは5mmグリッドと整合する倍数。

import type { Engine } from '@kimetron/core';

const STEPS = [5, 10, 20, 50, 100, 200, 500];
const H = 18; // ルーラー帯の太さ(px)

export function Rulers({
  engine,
  page,
  cursor,
}: {
  engine: Engine;
  /** アクティブページ枠（world mm） */
  page: { x: number; y: number; w: number; h: number };
  /** カーソル位置（world mm） */
  cursor: { x: number; y: number };
}) {
  const u =
    engine.worldToScreen({ x: 1, y: 0 }).x -
    engine.worldToScreen({ x: 0, y: 0 }).x; // px/mm
  const o = engine.worldToScreen({ x: page.x, y: page.y }); // page左上 px
  const c = engine.worldToScreen(cursor);

  const step = STEPS.find((s) => s * u >= 18) ?? 500;
  const major = step * 5;

  const ticks = (max: number) => {
    const out: { mm: number; px: number; major: boolean }[] = [];
    for (let m = 0; m <= max + 1e-6; m += step) {
      out.push({ mm: m, px: m * u, major: m % major === 0 });
    }
    return out;
  };

  return (
    <>
      <div
        className="ruler-corner"
        style={{ left: o.x - H - 1, top: o.y - H - 1 }}
      />
      <div
        className="ruler ruler-h"
        style={{ left: o.x, top: o.y - H - 1, width: page.w * u }}
      >
        {ticks(page.w).map((t) => (
          <div
            key={t.mm}
            className={t.major ? 'rt major' : 'rt'}
            style={{ left: t.px }}
          >
            {t.major && <span>{t.mm}</span>}
          </div>
        ))}
        <i className="rcur" style={{ left: c.x - o.x }} />
      </div>
      <div
        className="ruler ruler-v"
        style={{ left: o.x - H - 1, top: o.y, height: page.h * u }}
      >
        {ticks(page.h).map((t) => (
          <div
            key={t.mm}
            className={t.major ? 'rt major' : 'rt'}
            style={{ top: t.px }}
          >
            {t.major && <span>{t.mm}</span>}
          </div>
        ))}
        <i className="rcur" style={{ top: c.y - o.y }} />
      </div>
    </>
  );
}
