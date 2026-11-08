// 左メニューペイン — sethera の縦レール相当。折りたたみ可能。
// 収録: 言語切替 / ファイル（新規/開く/保存）/ Undo-Redo / ルーラー /
//       リンクモード / シェイプ / 画像 / ページ操作 / 印刷 / テーマ切替

import type { TFunc } from './i18n';
import { tf } from './i18n';

export type Theme = 'standard' | 'light' | 'dark' | 'quiet';
export type ShapeTool = 'rect' | 'ellipse' | 'line' | 'curve';

const THEMES: { value: Theme; key: string }[] = [
  { value: 'standard', key: 'theme.standard' },
  { value: 'light', key: 'theme.light' },
  { value: 'dark', key: 'theme.dark' },
  { value: 'quiet', key: 'theme.quiet' },
];

export function MenuPane({
  collapsed,
  onToggle,
  onNew,
  onOpen,
  onSave,
  saveLabel,
  onSaveAs,
  onExportText,
  onImportText,
  onImportZip,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  rulerOn,
  onRuler,
  onFit,
  linkMode,
  onLinkMode,
  shapeTool,
  onShapeTool,
  onImage,
  onAddPage,
  onDeletePage,
  onPrint,
  theme,
  onTheme,
  onLang,
  lang,
  writeMode,
  onMode,
  spread,
  onToggleSpread,
  onAbout,
  t,
}: {
  collapsed: boolean;
  onToggle: () => void;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  /** デスクトップ版は上書き保存なので「保存」表記へ切替 */
  saveLabel?: string;
  /** デスクトップ版のみ — 名前を付けて保存項目を追加する */
  onSaveAs?: () => void;
  /** 投稿用テキスト出力（v0.3）— 連鎖テキストを .txt で書き出す */
  onExportText: () => void;
  /** v0.7: .txt を連鎖テキストへ読み込む */
  onImportText: () => void;
  /** v0.9: 青空文庫 ZIP（txt＋同梱画像）を読み込む */
  onImportZip: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  rulerOn: boolean;
  onRuler: () => void;
  onFit: () => void;
  linkMode: boolean;
  onLinkMode: () => void;
  shapeTool: ShapeTool | null;
  onShapeTool: (t: ShapeTool | null) => void;
  onImage: () => void;
  onAddPage: () => void;
  onDeletePage: () => void;
  onPrint: () => void;
  theme: Theme;
  onTheme: (t: Theme) => void;
  onLang: () => void;
  lang: 'ja' | 'en';
  /** 執筆モード中はレイアウト系のツール項目を畳む（v0.2） */
  writeMode: boolean;
  onMode: () => void;
  /** v0.6: 見開き表示（組版モードのみ） */
  spread: boolean;
  onToggleSpread: () => void;
  /** v0.11: About オーバーレイを開く */
  onAbout: () => void;
  t: TFunc;
}) {
  const item = (
    ic: string,
    label: string,
    onClick: () => void,
    opts: { on?: boolean; title?: string; enIc?: string } = {},
  ) => (
    <button
      key={label}
      className={`m-item${opts.on ? ' on' : ''}`}
      title={opts.title ?? label}
      onClick={onClick}
    >
      <span className="m-ic">{lang === 'en' ? (opts.enIc ?? ic) : ic}</span>
      {!collapsed && <span className="m-label">{label}</span>}
    </button>
  );

  const nextTheme =
    THEMES[(THEMES.findIndex((t0) => t0.value === theme) + 1) % THEMES.length];

  return (
    <nav className={collapsed ? 'left-menu collapsed' : 'left-menu'}>
      <button
        className="m-item m-toggle"
        onClick={onToggle}
        title={collapsed ? t('menu.open') : t('menu.fold')}
      >
        <span className="m-ic">≡</span>
        {!collapsed && (
          <span className="m-label">Kusuma Plava</span>
        )}
      </button>
      {item('執', t('menu.mode'), onMode, {
        on: writeMode,
        title: t('menu.modeTip'),
        enIc: 'W',
      })}
      {/* 言語切替は日本語専用プロダクトのため廃止（en辞書・onLang/lang
          配管は残置 — 英語アイコン enIc 分岐などがまだ参照する） */}
      {item('新', t('menu.new'), onNew, { enIc: 'N' })}
      {item('開', t('menu.openDoc'), onOpen, { enIc: 'O' })}
      {item('存', saveLabel ?? t('menu.save'), onSave, {
        title: t('menu.saveTip'),
        enIc: 'S',
      })}
      {onSaveAs &&
        item('名', t('menu.save'), onSaveAs, {
          title: t('menu.saveAsTip'),
          enIc: 'A',
        })}
      {item('読', t('menu.importText'), onImportText, { enIc: 'T' })}
      {/* v0.9: 青空文庫 ZIP — txt ＋同梱画像の一括取り込み */}
      {item('青', t('menu.importZip'), onImportZip, { enIc: 'Z' })}
      {item('出', t('menu.exportText'), onExportText, {
        title: t('menu.exportTextTip'),
        enIc: 'T',
      })}
      {/* v0.9: 画像は執筆モードでも差し込める（現ページの版面へ直接
          配置）— 大文書で組版への切替が重いためゲートから出した */}
      {item('画', t('menu.image'), onImage, { enIc: 'I' })}
      <div className="m-sep" />
      {canUndo &&
        item('消', t('menu.undo'), onUndo, { title: 'Ctrl+Z', enIc: '↶' })}
      {canRedo &&
        item('戻', t('menu.redo'), onRedo, { title: 'Ctrl+Y', enIc: '↷' })}
      {!writeMode &&
        item('尺', t('menu.ruler'), onRuler, { on: rulerOn, enIc: 'R' })}
      {item('全', t('menu.fit'), onFit, {
        title: t('menu.fitTip'),
        enIc: 'F',
      })}
      {/* レイアウト編集系（リンク・画像・シェイプ）は組版モードのみ */}
      {!writeMode && (
        <>
          <div className="m-sep" />
          {item('見', t('menu.spread'), onToggleSpread, {
            on: spread,
            title: t('menu.spreadTip'),
            enIc: 'S',
          })}
          {item('鎖', t('menu.link'), onLinkMode, {
            on: linkMode,
            title: t('menu.linkTip'),
            enIc: 'L',
          })}
          <div className="m-sep" />
          {item('□', t('menu.rect'), () => onShapeTool(shapeTool === 'rect' ? null : 'rect'), {
            on: shapeTool === 'rect',
            title: t('menu.rectTip'),
          })}
          {item('◯', t('menu.ellipse'), () => onShapeTool(shapeTool === 'ellipse' ? null : 'ellipse'), {
            on: shapeTool === 'ellipse',
            title: t('menu.ellipseTip'),
          })}
          {item('／', t('menu.line'), () => onShapeTool(shapeTool === 'line' ? null : 'line'), {
            on: shapeTool === 'line',
            title: t('menu.lineTip'),
          })}
          {item('〜', t('menu.curve'), () => onShapeTool(shapeTool === 'curve' ? null : 'curve'), {
            on: shapeTool === 'curve',
            title: t('menu.curveTip'),
          })}
        </>
      )}
      <div className="m-sep" />
      {/* v0.9: ページの追加・削除は執筆モードでは自動管理 —
          あふれで自動追加、末尾の空の自動ページは自動削除 */}
      {!writeMode && (
        <>
          {item('頁', t('menu.addPage'), onAddPage, { enIc: 'P' })}
          {item('消', t('menu.delPage'), onDeletePage, {
            title: t('menu.delPageTip'),
            enIc: 'D',
          })}
        </>
      )}
      {item('印', t('menu.print'), onPrint, { enIc: '⎙' })}
      <div className="m-sep" />
      {collapsed ? (
        item('題', t('menu.theme'), () => onTheme(nextTheme.value), {
          title: tf(t, 'menu.themeTip', t(nextTheme.key)),
          enIc: '◑',
        })
      ) : (
        <label className="m-item m-theme">
          <span className="m-ic">{lang === 'en' ? '◑' : '題'}</span>
          <select
            value={theme}
            onChange={(e) => onTheme(e.currentTarget.value as Theme)}
          >
            {THEMES.map((th) => (
              <option key={th.value} value={th.value}>
                {t(th.key)}
              </option>
            ))}
          </select>
        </label>
      )}
      {/* v0.11: About — バージョン表記はオーバーレイ側へ一本化
          （メニューの m-ver は撤去） */}
      {item('説', t('menu.about'), onAbout, { enIc: '?' })}
    </nav>
  );
}
