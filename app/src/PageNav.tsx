// ページナビゲーション部品 — フローティング・折りたたみ可。
// 先頭/前/次 + 現在ページ表示 + 番号ジャンプ。移動のみ（追加/削除は左メニュー）。

import { useState } from 'react';
import type { TFunc } from './i18n';

export function PageNav({
  current,
  total,
  collapsed,
  onToggle,
  onGo,
  t,
}: {
  /** 表示中ページ（0-based index。-1 なら gap/圏外） */
  current: number;
  total: number;
  collapsed: boolean;
  onToggle: () => void;
  /** 0-based index へ移動 */
  onGo: (index: number) => void;
  t: TFunc;
}) {
  const [jump, setJump] = useState('');
  const shown = current >= 0 ? current + 1 : 1;
  const go = (i: number) => onGo(Math.min(total - 1, Math.max(0, i)));

  if (collapsed) {
    return (
      <button
        className="page-nav collapsed"
        onClick={onToggle}
        title={t('nav.open')}
      >
        p.{shown}/{total}
      </button>
    );
  }
  return (
    <div className="page-nav">
      <button onClick={() => go(0)} title={t('nav.first')}>
        ≪
      </button>
      <button onClick={() => go(current - 1)} title={t('nav.prev')}>
        ＜
      </button>
      <span className="pn-cur">
        <input
          type="number"
          min={1}
          max={total}
          value={jump || shown}
          onChange={(e) => setJump(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const v = parseInt(jump, 10);
              if (v >= 1 && v <= total) go(v - 1);
              setJump('');
            }
          }}
          onBlur={() => setJump('')}
        />
        {' / '}
        {total}
      </span>
      <button onClick={() => go(current + 1)} title={t('nav.next')}>
        ＞
      </button>
      <button className="pn-fold" onClick={onToggle} title={t('nav.fold')}>
        −
      </button>
    </div>
  );
}
