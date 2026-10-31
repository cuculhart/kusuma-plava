# Changelog

## [Unreleased]

## [0.8.1] - 2026-10-29

### English

Paste/clipboard and print fixes.

- Fixed: group IDs (`gN`) were numbered from a session-only counter, so
  reopened documents could collide — pasted clones merged into an
  unrelated existing group. New groups now skip IDs already in use,
  and opening a file re-normalizes group IDs per page (same-name
  groups on different pages are split and renumbered, healing
  documents saved with collisions).
- Fixed: Ctrl+V pasted the stale internal copy buffer even after
  copying something else — all paste decisions moved to the `paste`
  event: in-app copies write a marker to the OS clipboard
  (synchronously via the `copy` event), and the marker decides whether
  to paste internal objects, an external image, or nothing.
- Fixed: an extra blank page printed after the last page —
  `page-break-after: always` fired on the final `.ppage`.

### 日本語

コピペ/クリップボード・印刷まわりの修正。

- 修正: グループID（gN）がセッション内連番のみで、再オープン後に
  既存IDと衝突 → ペーストしたクローンが無関係の既存グループに
  混入していた。新規採番は既存IDをスキップし、ファイルオープン時に
  同名グループをページ単位で分割・連番化して汚染を修復
- 修正: 外部で新しくコピーしても Ctrl+V が古い内部バッファを貼って
  いた — ペースト判定を paste イベントに集約し、アプリ内コピーは
  OS クリップボードへマーカーを書き込んで照合する方式に変更
- 修正: 最終ページの後に白紙が1枚出力される —
  最後の `.ppage` で改ページを抑止

## [0.8.0] - 2026-10-29

### English

Usability improvements (paste / scroll / paste position) plus text
links, and remaining defect fixes.

- Clipboard image paste (N-18): Ctrl+V places a clipboard image as a
  new image object at the last click position (aspect ratio measured
  and locked). Text paste intentionally out of scope.
- Floating scroll UI (N-19): ▲▼ buttons at the canvas right edge for
  vertical scrolling — an alternative to middle-button panning.
- Paste at click position (N-20): Ctrl+V now places the copy's
  bounding box top-left at the last canvas click (grid-snapped)
  instead of offset below-right of the source.
- Text links (N-17): apply a URL to a text selection
  (`TextMark.attrs.link`, URL input in the chain pane, Enter to apply)
  or to a whole area (`TextAreaData.link`). On canvas links render
  blue+underline without navigating; print emits real `<a>` elements,
  so "Save as PDF" keeps clickable links. Scheme-less input gets
  `https://` prepended.

### Fixed

- B-8: page tags (p.N with +/× buttons) were invisible — `.ki-obj`'s
  `overflow:hidden` clipped the tag floating above the frame.
  `.ki-obj:has(.page-tag)` now allows `overflow:visible`.
- Ctrl+V keydown called preventDefault, blocking the browser paste
  event entirely — removed so clipboard image paste works.
- Shape fills missing in printed output — Chrome drops backgrounds
  when printing; `print-color-adjust: exact` on the printout keeps
  fills/borders/transparency.

### 日本語

使い勝手の改善（ペースト・スクロール・貼り付け位置）＋
テキストリンク、残不具合の消化。

- クリップボードからの画像貼り付け（N-18）: Ctrl+V で画像を新規
  image オブジェクトとして直近クリック位置へ配置（アスペクト比
  自動算出・ロックON）。テキスト貼り付けは対象外
- 上下スクロールUI（N-19）: キャンバス右端に ▲▼ フローティング
  ボタン（ホイール押し込みパン不慣れ対策）
- ペースト位置をクリック位置へ（N-20）: Ctrl+V の配置先を
  「コピー元の右下」から直近クリック位置へ変更（グリッド吸着）
- テキストのリンク（N-17）: 選択範囲への部分リンク
  （`TextMark.attrs.link`）とエリア全体のリンク
  （`TextAreaData.link`）。編集画面では遷移せず青+下線で表示のみ、
  印刷は `<a>` で出すため「PDF に保存」でリンクが生きる
  （Microsoft Print to PDF 経由ではリンクが落ちます）。
  スキーム省略入力は `https://` を補完
- 修正（B-8）: ページタグ（p.N＋＋/×ボタン）が表示されない —
  `.ki-obj` の `overflow:hidden` で枠の上に出るタグが刈られていた
- 修正: Ctrl+V の keydown で preventDefault していたため
  paste イベントが届かず画像貼り付けが動かなかった
- 修正: 印刷でシェイプの塗りが出ない — Chrome の背景省略を
  `print-color-adjust: exact` で抑止

## [0.7.0] - 2026-10-29

### English

Partial text decoration plus font support. kimetron updated to 1.6.1
(`.ki-obj` border honors `style.dash`).

- Partial text decoration (N-7): a toolbar in the chain pane applies
  B/I/U, text color, size, and font family to the selected text range.
  `Chain.marks` (range-scoped formatting) is new — measurement (per-run
  font switching; line height = max fontSize in the line), rendering,
  and print all work per run. Marks survive text edits and chain
  link/unlink (coordinates are kept). "Clear marks" removes marks in
  the range.
- Document default font: the paper properties pane gains a "Default
  font" field; newly created text areas inherit it. Stored in the
  archive and in undo snapshots.
- Installed font enumeration: `queryLocalFonts` (Chromium) feeds the
  font selects (single/multi selection, mark toolbar, paper props).
  Falls back to the preset list when unavailable or denied.
- Rect/ellipse border line style (N-8): solid/dashed/dotted — the
  border style is honored on canvas (kimetron 1.6.1 `.ki-obj`
  borderStyle mapping) and in print.

### Fixed

- B-1: stray text areas appeared behind the page when navigating —
  after a nav click the page scrolled under the cursor and the second
  click landed on the canvas as a synthesized dblclick. Area-creation
  dblclicks are now suppressed for 700ms after a page switch.
- Mark color tool showed the previously picked color rather than the
  selection's actual color, and confirming with Enter applied nothing.
  The color input now syncs to the effective color at the selection
  and applies its shown value on focus.

### 日本語

テキストの部分装飾＋フォント対応。kimetron は 1.6.1 へ更新
（`.ki-obj` 枠線が `style.dash` に対応）。

- テキストの部分装飾（N-7）: 連鎖ペインのツールバーで選択範囲へ
  B/I/U・文字色・サイズ・書体を適用。`Chain.marks`（範囲指定書式）を
  新設し、計測（ラン単位のフォント切替・行高さ=行内最大 fontSize）・
  描画・印刷をラン対応化。テキスト編集・連鎖結合/切断でマーク座標を
  維持。「装飾を解除」で範囲内マーク除去
- ドキュメント既定フォント: 用紙プロパティに「既定フォント」欄を
  追加。新規作成されるテキストエリアへ自動適用。書庫・Undo
  スナップショットに含まれる
- インストール済みフォントの列挙: `queryLocalFonts`（Chromium）で
  ファミリをセレクト候補化（単一/複数選択・部分装飾・用紙プロパティの
  全フォント欄）。非対応・拒否時は既定リストにフォールバック
- 矩形・楕円の枠線の線種（N-8）: 実線/破線/点線を選択可。
  画面は kimetron 1.6.1 の `.ki-obj` borderStyle 写像、印刷は
  border-style で再現
- 修正（B-1）: ページ送り時に稀に背面へテキストエリアが追加される。
  ナビクリック→スクロールで2クリック目+ダブルクリック判定が
  キャンバスへ着弾していた。ページ切替後 700ms はエリア生成
  ダブルクリックを無効化
- 修正: 部分装飾の色ツールが前回選択色を表示し Enter 確定で
  適用されない不具合 — 選択位置の実効色へ同期し、
  フォーカス時に表示色を適用するよう変更

## [0.6.0] - 2026-10-28

### English

Multi-selection workflow completion (duplicate / grouping) plus
multi-point curve input. kimetron updated to 1.6.0 (B6 stroke-scaled
caps, P49 multi-point draw, resizeAspect hook).

- Duplicate / copy & paste (F25): Ctrl+D, Ctrl+C/V. Shapes, images and
  text areas are copied one grid step over and the copies get selected.
  Copied text areas become standalone single-area chains — links are
  not carried over, but font settings and the source chain's full text
  are (overflow shows honestly). A multi-selection duplicates
  everything; copied group members are re-keyed to a new group.
- Shape grouping (F26): uses kimetron's `group` field. The context
  menu gains Group/Ungroup. One click on a member selects the whole
  group; clicking again dives to the member (click-through); Alt+drag
  detaches a member, per kimetron.
- Multi-point curve input (F27): the "~" tool is now click-chained
  vertex input (kimetron P49 `startShapeDraw` / `'shape'` mode).
  Points snap to the grid with a dashed preview; Enter/double-click
  commits, Esc cancels. The result is immediately editable via the
  vertex grips (`.ki-vtx`).
- Rect/ellipse border ON/OFF (F28): a "Border" checkbox in the
  properties. OFF writes an explicit `stroke:'transparent'` (distinct
  from width 0).
- Align & distribute (F29): eight buttons in the inspector for
  multi-selections — left/center/right, top/middle/bottom, and
  horizontal/vertical equal spacing.
- Text area alignment: standalone (unchained) areas get horizontal
  (left/center/right) and vertical (top/middle/bottom) alignment.
  Chained areas stay anchored top-left.
- Fix (B6): thick-line caps (arrows/dots) were buried by the stroke.
  kimetron 1.6.0 scales cap markers with stroke width (`userSpaceOnUse`
  + `viewBox`); the print output scales them the same way.
- Image resize: aspect-lock moved to kimetron's `resizeAspect` hook,
  constraining corner drags live (post-commit correction kept for edge
  drags).

### 日本語

複製・グルーピング（複数選択ワークフローの完成）＋ 曲線の多点入力。
kimetron は 1.6.0 へ更新（B6 端子スケール・P49 多点入力・resizeAspect
フックを取り込み）。

- 複製/コピー＆ペースト（F25）: Ctrl+D・Ctrl+C/V。シェイプ・画像・
  テキストエリアをグリッド1段ずらして複製し複製物を選択。
  テキストエリアはリンクを引き継がず単独エリアの新連鎖となり、
  フォント等の設定と元連鎖の全文を引き継ぐ（収まらない分はあふれ
  表示）。複数選択は全選択を複製。グループは複製時に新規グループへ
  振り直し
- 図形のグルーピング（F26）: kimetron の `group` フィールドで束を
  識別。右クリックメニューに「グループ化/解除」。グループ内1点
  クリックで全体選択、全選択済みなら個別へ潜る（クリックスルー）、
  Alt+drag で個別脱出は kimetron 準拠
- 曲線の多点入力（F27）: 「〜」ツールがクリック連打による頂点入力に
  刷新（kimetron P49 の `startShapeDraw` / `'shape'` mode を利用）。
  点はグリッドにスナップし破線プレビュー、Enter/ダブルクリックで
  確定、Esc で取消。確定後はそのまま頂点グリップ（.ki-vtx）で編集可
- 矩形・楕円の枠線 ON/OFF（F28）: プロパティに「枠線」チェック。
  OFF は `stroke:'transparent'` の明示的消去（線幅0とは別扱い）
- 整列・分布（F29）: 複数選択時にプロパティペインへ
  左/中央/右揃え・上/中央/下揃え・縦横等間隔の8ボタン
- テキストエリアの揃え: 単独（非連鎖）エリアに横揃え（左/中央/右）と
  縦揃え（上/中央/下）。リンク連鎖のエリアは左上起点固定のまま
- 修正（B6）: 太い線の端子（矢印・●）が線幅に埋もれる。
  kimetron 1.6.0 で cap マーカーを線幅スケール化（viewBox 付き
  userSpaceOnUse）、印刷出力側も同率で拡大
- 画像リサイズ: アスペクト比ロックは kimetron の `resizeAspect`
  フックへ移行し、角ドラッグでライブ拘束（確定時補正は辺ドラッグ
  用に残置）

## [0.5.0] - 2026-10-27

### English

Shape vertex editing moved into the engine (kimetron 1.5.0) plus the
curve tool.

- Curve tool (~): drag to place a shallow arc, then shape it with the
  vertex grips — minimal implementation (click-chained multi-point
  input not yet — kimetron P49). Printing handled via Catmull-Rom
  expansion
- Vertex grips (F21) migrated to kimetron's vertex editing
  (P48 — `.ki-vtx` handles + `vertex` mode): double-click a grip to
  delete the anchor, double-click a selected curve/polygon outline to
  insert one. The app's own overlay (Grips.tsx) was removed
- Fix: line/curve properties showed a fill field (open chords never
  fill — hidden to avoid confusion)
- kimetron submodule updated to v1.5.0

### 日本語

シェイプ頂点編集のエンジン化（kimetron 1.5.0）と曲線ツール。

- 曲線ツール（〜）: ドラッグで浅い弧を配置し、頂点グリップで
  形を整える最小実装（連続クリックによる多点入力は未実装 —
  kimetron P49 予定）。印刷も Catmull-Rom 展開で対応
- 頂点グリップ（F21）を kimetron 側の頂点編集機構へ移行
  （P48 — `.ki-vtx` ハンドル＋`vertex` mode）。グリップの
  ダブルクリックで頂点削除、選択中の曲線/多角形の線上を
  ダブルクリックで頂点追加ができるようになった。
  アプリ側の独自オーバーレイ（Grips.tsx）は廃止
- 修正: 直線・曲線のプロパティに塗り色欄が出ていた
  （開いた chord なので fill は常に none — 誤解を招くため非表示化）
- kimetron submodule を v1.5.0 へ更新

## [0.4.0] - 2026-10-27

### English

A sweep of accumulated bugs plus expanded editing power
(v0.4.0-plan.md B1–B5, F21–F24). kimetron updated to 1.4.1
(frame-width and shape-svg fixes).

- Grips (vertex editing): □ grips on the anchors of a single-selected
  line/curve/polygon — drag to edit vertices directly. The bbox
  re-normalizes on every anchor (degenerate axes collapse to the
  midpoint); grid snap, rotated objects and Undo all apply
- Line caps & dash: start/end caps (none/arrow/dot) and dash styles
  (solid/dashed/dotted) for lines/curves. The canvas uses kimetron's
  cap/dash rendering as-is; print reproduces markers and dashes at
  true size via a mm viewBox (line-width print conversion also fixed)
- Text attributes: bold/italic/underline/color added to TextAreaData
  and reflected in measurement, rendering, printing and batch editing
- Snap temporary release: hold Alt to disable grid/object snapping
  (applies to drag, resize, rotate and grip editing)
- Line tool: horizontal/vertical drags produce a straight line with
  edge-center anchors instead of a diagonal chord (sethera parity).
  The drag start is kept as the chord's first anchor
- Change: paper opacity default 100% → 50% (new documents too;
  archives restore the saved value)
- Fix: shape fill color vs property display mismatch — the alpha of
  rgba/#rrggbbaa was ignored and colors were shown/overwritten as
  opaque. Added an opacity (%) field per color; color changes now keep
  alpha (initial fill unified to #rrggbbaa)
- Fix: horizontal/vertical lines disappearing — when a resize pushed
  w/h to near 0 (min 0.001mm) the shape `<svg>` collapsed to zero
  size and rendering was disabled entirely (overflow:visible can't
  rescue it). kimetron clamps the svg viewport to 1px; print output
  gets a 0.1mm floor
- Fix: border remaining at width 0 — kimetron 1.4.1 drives `.ki-obj`
  border width from `style.width`, and the app's temporary CSS was
  removed (rect delegates to native rendering)
- Fix: bold/italic/underline/color could not be changed for a single
  text area — the chain pane gained B/I/U and color controls
  (previously only available in batch selection)
- Fix: a text area's fill hid shapes underneath — the default fill
  was removed/transparentized

### 日本語

溜まった不具合の一掃と編集力の拡充（v0.4.0-plan.md の B1–B5・F21–F24）。
kimetron は 1.4.1 へ更新（枠幅・shape svg の修正を取り込み）。

- グリップ（頂点編集）: 単一選択の line/curve/polygon の
  アンカー点に □ グリップを表示し、ドラッグで頂点を直接編集。
  全頂点で bbox を再正規化（退縮辺は中点へ畳み込み）、
  グリッドスナップ・回転オブジェクト・Undo に対応
- 線の端子・線種: 直線/曲線に 始点/終点（なし/矢印/●）と
  線種（実線/破線/点線）を追加。キャンバスは kimetron の
  cap/dash 描画をそのまま使用、印刷は mm viewBox で
  マーカー・破線を実寸再現（線幅の印刷換算も修正）
- テキスト属性の拡充: 太字・斜体・下線・文字色を TextAreaData
  に追加し、計測・描画・印刷・一括編集のすべてに反映
- スナップ一時解除: Alt 押下中はグリッド/オブジェクト吸着を
  無効化（ドラッグ・リサイズ・回転・グリップ編集に共通適用）
- 直線ツール: 水平/垂直方向に引いた線は対角 chord ではなく
  辺中央アンカーの真っ直ぐな線として生成（sethera 準拠）。
  ドラッグ始点を chord の先頭点として保持
- 変更: 用紙の透過の既定値を 100% → 50%
  （新規作成時も同値。書庫は保存値を復元）
- 修正: シェイプの塗り色とプロパティ表示の不一致。
  rgba/#rrggbbaa のアルファを無視して表示・不透明色で上書きしていた。
  各色に不透明度（%）欄を追加し、色変更時はアルファを維持する
  （初期 fill を #rrggbbaa 形式へ統一）
- 修正: 水平・垂直の直線が消える不具合。リサイズで幅/高さが
  0 近辺（最小 0.001mm）になると、shape 用 <svg> 要素が
  0 サイズとなり要素ごと描画が無効化されていた
  （overflow:visible では救済不可）。kimetron 側で svg
  ビューポートに 1px 下限を設け、印刷出力にも 0.1mm 下限を適用
- 修正: 線幅 0 でも枠線が残る不具合。kimetron 1.4.1 で
  .ki-obj の枠幅を style.width 由来に変更して根本解消、
  アプリ側暫定 CSS を撤去（rect はネイティブ描画へ委譲）
- 修正: 単一テキストエリア選択時に太字・斜体・下線・文字色を
  変更できない不具合。連鎖ペインに B/I/U・文字色の
  コントロールを追加（従来は複数選択時のみ設定可能だった）
- 修正: テキストエリアの塗りが下のシェイプを隠す不具合。
  既定 fill を撤去し透明に変更

## [0.3.0] - 2026-10-27

### English

Visibility, navigation automation and internationalization
(v0.3.0-plan.md G1–G5).

- Page fit & top-left align: auto-zooms so the whole page fits and
  places the page's top-left (ruler origin) at the canvas corner.
  Applied on navigation/new/open; manual via the "Fit page" button
- Ruler: moved to strips along the active page frame's top/left
  edges, with 5mm-grid-aligned ticks
- Paper opacity: a slider in the document properties (0–100%; 0%
  shows frame outlines only). Included in archives and Undo/Redo
- Inspector collapse: the right pane folds away to the right
- English: the "Aa" button at the top of the menu toggles ja/en
  (persisted to localStorage). Menus, panes, dialogs, hints, status,
  page tags and badges are all translated; icons switch to Latin
  letters/symbols in English
- Startup demo data removed (opens with an empty document)
- GitHub Pages workflow added (manual trigger only for now)

### 日本語

視認性・ナビゲーションの自動化・多言語化（v0.3.0-plan.md の G1–G5）。

- ページフィット＆左上合わせ: ページ全体が収まる倍率に自動ズームし、
  ページ左上（ルーラー原点）をキャンバス左上へ。ナビ/新規/開く時に適用、
  メニューの「枠 ページを全体表示」ボタンで手動実行も可能
- ルーラー改良: ページ枠の上辺・左辺に沿う帯へ移動、
  5mm グリッド整合の刻み
- 用紙の透過設定: 文書プロパティにスライダー（0–100%）。
  0% でフレームのみ。書庫・Undo/Redo 履歴に含まれる
- プロパティペイン折りたたみ: 右ペインを右方向へ最小化
- 英語対応: メニュー最上段の「Aa」ボタンで ja/en 切替
  （localStorage 永続化）。メニュー・ペイン・ダイアログ・
  ヒント・ステータス・ページタグ・バッジを全翻訳。
  アイコンは EN 時に英字/記号へ切替
- 起動時のデモデータを撤去（空ドキュメントで起動）
- GitHub Pages 用ワークフロー追加（現時点では手動実行のみ）

## [0.2.0] - 2026-10-27

### English

Production-grade precision and recoverability
(v0.2.0-plan.md F14–F18, F20).

- Rulers: mm ticks along the active page frame's top/left edges —
  pan/zoom follow, 5mm-grid-aligned ticks, cursor position marker,
  ON/OFF toggle
- Save as: filename input dialog (defaults to the document title).
  The document properties get a title field; archives store and
  restore title/createdAt/updatedAt metadata
- Undo/Redo: integrated snapshot history covering doc + chains +
  pages + settings. Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y and menu buttons;
  500ms of continuous edits folds into one entry, capped at 100
- Chain mid-insert: "Add a chained area after this one" inserts an
  area right after the selected one
- Wire right-click unlink (a second unlink path besides Del)
- Image resize aspect-ratio constraint (corrected on commit when
  locked)
- Shortcuts: Ctrl+S save as, `beforeunload` unsaved-changes warning
- Fix: middle-button pan triggered browser autoscroll and moved the
  whole viewport (document scroll disabled + middle-button default
  suppressed)
- Fix: new area IDs could collide with demo/loaded objects (existing
  IDs are scanned before allocating)

### 日本語

制作実務の精度と回復力（v0.2.0-plan.md の F14–F18・F20）。

- ルーラー: アクティブページ枠の上辺・左辺に沿う mm 目盛り。
  ページと一緒にパン/ズーム追従、5mm グリッド整合の刻み、
  カーソル位置マーカー、ON/OFF 切替
- 名前を付けて保存: ファイル名入力ダイアログ（既定は文書タイトル）。
  文書プロパティにタイトル欄、書庫に title/createdAt/updatedAt
  メタ情報を格納・復元
- Undo/Redo: doc＋連鎖＋ページ＋設定の統合スナップショット履歴。
  Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y、メニューボタン、
  500ms 連続編集を1エントリに畳む・100件上限
- 連鎖途中挿入: 「このエリアの後に連鎖エリアを追加」で
  選択エリアの直後に中間挿入
- ワイヤー右クリック切断（Del 以外の切断経路）
- 画像リサイズのアスペクト比拘束（ロック ON 時、確定時に補正）
- ショートカット: Ctrl+S 名前を付けて保存、
  `beforeunload` 未保存警告
- 修正: 中ボタンパンでオートスクロールが発火し画面全体が
  動いてしまう不具合（ドキュメント scroll 禁止＋中ボタン既定動作抑止）
- 修正: 新規エリアの ID がデモ/読込オブジェクトと衝突する不具合
  （既存 ID を走査して空きを採番）

## [0.1.0] - 2026-10-27

### English

First release — the walking skeleton of "a print-first page layout
editor where you place things at true size on graph paper, with text
flowing across pages" (v0.1.0-plan.md F1–F13).

- Page model: A4/A3 × portrait/landscape, arranged vertically in
  world mm coordinates. Add, insert anywhere, delete (frames only) —
  swapping paper size leaves object coordinates unchanged
- Active page: click a page frame to select it; navigation, deletion
  and highlighting follow
- Text chains: display-only areas with greedy text distribution,
  overflow badges, linear one-way links (tail → head), rollback
  unlinking, and the chain edit pane
- Images: file pick → true-size ghost → click to place. mm editing,
  aspect-ratio lock, Z-order (right-click menu)
- Shapes: rectangle, ellipse, line (drag to place, mm stroke widths,
  batch editing)
- True-size printing: in-document overlay + beforeprint handling,
  dynamic `@page` setup, page-number footer (ON/OFF)
- Archive: custom .slm format (zip: doc.json + image binaries).
  New/Open/Save
- Layout: collapsible left menu + canvas + right inspector,
  floating page navigation (collapsible), status bar
- Themes: Standard (OS-driven) / Light / Dark / Quiet
- Grid: 5mm graph paper + 10mm major lines, 5mm snapping

### 日本語

初回リリース。「方眼紙に実寸で置いていく、ページ跨ぎ文字送りつきの
印刷物ファーストなページレイアウトエディタ」の歩く骨格
（v0.1.0-plan.md の F1–F13）。

- ページモデル: A4/A3 × 縦横、ワールド mm 座標で縦並び。
  追加・任意位置挿入・削除（枠のみ）、用紙差替えでオブジェクト座標不変
- アクティブページ: ページ枠クリックで選択。ナビ・削除・強調が連動
- テキスト連鎖: 表示専用エリア＋貪欲配分、あふれバッジ、
  線形一方通行リンク（末尾→先頭）、巻き戻し切断、連鎖編集ペイン
- 画像: ファイル選択→実寸ゴースト→クリック確定。mm編集・アスペクト比
  ロック・Z-order（右クリックメニュー）
- シェイプ: 矩形・楕円・直線（ドラッグ配置・mm線幅・一括編集）
- 実寸印刷: 同一ドキュメント内オーバーレイ＋beforeprint 対応、
  `@page` 動的設定、ページ番号フッター（ON/OFF可）
- 書庫: 独自 .slm 形式（zip: doc.json＋画像バイナリ）。新規/開く/保存
- 画面構成: 左メニュー（折りたたみ）＋キャンバス＋右プロパティの3ペイン、
  ページナビ（フローティング・折りたたみ可）、ステータスバー
- テーマ: 標準（OS連動）/ ライト / ダーク / クワイエット
- グリッド: 5mm 方眼紙＋10mm 主線、5mm スナップ
