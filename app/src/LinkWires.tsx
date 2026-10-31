// 連鎖リレーション線 — キャンバス上の SVG オーバーレイ。
// チェーンの隣接エリア同士を右辺中央 → 左辺中央のベジェで結ぶ。
// 線はクリックで選択でき、選択中に Del で巻き戻し切断される。

import type { ReactNode } from 'react';
import type { Engine } from '@kimetron/core';
import type { Chain } from 'inimbal';
import { liveRect } from './types';

export interface LinkSel {
  chainId: string;
  /** 切断位置: areas[index] → areas[index+1] の間 */
  index: number;
}

export function LinkWires({
  engine,
  chains,
  selLink,
  onPick,
}: {
  engine: Engine;
  chains: Chain[];
  selLink: LinkSel | null;
  onPick: (sel: LinkSel) => void;
}) {
  const byId = new Map(engine.doc.objects.map((o) => [o.id, o]));
  const paths: ReactNode[] = [];
  for (const c of chains) {
    for (let i = 0; i < c.areas.length - 1; i++) {
      const a = byId.get(c.areas[i]);
      const b = byId.get(c.areas[i + 1]);
      if (!a || !b) continue;
      const ra = liveRect(engine, a);
      const rb = liveRect(engine, b);
      const p1 = engine.worldToScreen({
        x: ra.x + ra.w,
        y: ra.y + ra.h / 2,
      });
      const p2 = engine.worldToScreen({ x: rb.x, y: rb.y + rb.h / 2 });
      const mx = (p1.x + p2.x) / 2;
      const d = `M${p1.x},${p1.y} C${mx},${p1.y} ${mx},${p2.y} ${p2.x},${p2.y}`;
      const sel = selLink?.chainId === c.id && selLink.index === i;
      paths.push(
        <g key={`${c.id}:${i}`} data-link={`${c.id}:${i}`}>
          <path
            className="wire-hit"
            d={d}
            onClick={(e) => {
              e.stopPropagation();
              onPick({ chainId: c.id, index: i });
            }}
          />
          <path className={sel ? 'wire sel' : 'wire'} d={d} />
        </g>,
      );
    }
  }
  return <svg className="wires">{paths}</svg>;
}
