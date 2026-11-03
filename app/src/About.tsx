// v0.11: About — 「Kusuma Plava について」オーバーレイ。
// アプリ名・コンセプト・バージョン・作者・外部導線をまとめる。
// バージョン表記はここが唯一の表示場所（MenuPane 側は撤去済み）
// — リリース時は APP_VERSION を package.json と揃える。

import type { TFunc } from './i18n';

/** 表示バージョン — リリース時に package.json×3 と揃える同期対象 */
export const APP_VERSION = 'v0.13.0';

/** 配布元トップ — About からの外部導線（cuculhart.com） */
export const APP_URL = 'https://cuculhart.com/';

export function About({
  onClose,
  t,
}: {
  onClose: () => void;
  t: TFunc;
}) {
  return (
    <div className="dlg-backdrop" onClick={onClose}>
      <div className="dlg about" onClick={(e) => e.stopPropagation()}>
        <h1 className="about-name">Kusuma Plava</h1>
        <div className="about-ver">{APP_VERSION}</div>
        <p className="about-body">{t('about.body')}</p>
        <p className="about-author">
          {t('about.author')}{' '}
          <a href={APP_URL} target="_blank" rel="noopener">
            cuculhart.com
          </a>
        </p>
        <div className="btns">
          <button onClick={onClose}>{t('print.close')}</button>
        </div>
      </div>
    </div>
  );
}
