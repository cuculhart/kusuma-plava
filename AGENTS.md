# Kusuma Plava — 作業ルール

## Git / リリース

- **public リポジトリへの push はリリース時のみ**。
  開発中のコミットはローカルのみに留める（2026-10-31 指示）
- コミット author は GitHub noreply を使う
  （実メールは privacy 設定で push を弾かれる）:
  `GIT_AUTHOR_EMAIL=GIT_COMMITTER_EMAIL=332349660+cuculhart@users.noreply.github.com`
- タグは `v0.x.0` 形式。リリース時は package.json×3
  （root/app/inimbal）+ package-lock.json + About 画面の
  バージョン表記（app/src/About.tsx の APP_VERSION）を揃える

## パッケージ構成

- **`inimbal/` は kusuma-plava 固有の独自パッケージ**。
  silim-murlun の inimbal からフォークしたが、縦書き組版
  （tategaki）・青空 marks・ChainBreak などで大きく分岐
  したため独立宣言 — silim-murlun 側との同期・backport
  は行わない（API は互換だが製品適合が違うため）
- `kimetron/` は本体リポジトリ（`cuculhart/kimetron`）の
  **git submodule**（silim-murlun と同じ構成。clone 時は
  `git submodule init` または `--recursive`）。v1.7.0 へ
  pin — 更新は `git -C kimetron fetch && checkout <tag>` →
  親側でコミット。objectFilter は v1.7.0 で本体へ
  backport 済み（2026-11-03）

## 環境固有の注意

- **`node_modules/inimbal` は実体コピー**（npm workspaces
  の link がこの環境では materialize される）。`inimbal/src`
  を編集したら `node_modules/inimbal/src/` にもコピーすること
- inimbal 変更後は `app/node_modules/.vite` を削除する
  （プリバンドルキャッシュが古いと白画面になる）
- 検証: `cd app && npx tsc --noEmit`、
  `cd inimbal && npm run typecheck`、`npm test`、
  `npm run build -w kusuma-plava-app`

## 設計資料

- `../idea/garakuta/kusuma-plava/` に concept.md /
  backlog.md / v0.4.0-plan.md / title-plan.md
- spike/ に検証済みプロトタイプ（縦書き・回しこみ・
  折返しテスト）
