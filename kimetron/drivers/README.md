# drivers

Kimetron を使う側のサンプルアプリ置き場。
sethera / plesfeda が将来 Kimetron 上に載るとしたら、この位置に置かれる
種類のコード。ライブラリ側の「実際にどう使われるか」を検証する場。

`drivers/` 全体が1つの Vite マルチページアプリ（`kimetron-drivers`）。
`npm run dev` で launcher（`/`）から各ドライバへ遷移できる。

| page | 内容 |
|------|------|
| `index.html` | ドライバ一覧（launcher） |
| `demo/` | プレイグラウンド。origin / units / grid / snap / リサイズ / オブジェクトスナップ / Undo / エッジを切り替えてワールド座標モデルを体感する検証用アプリ |
| `demo/vanilla.html` | React 無しの最小ページ（`createRenderer`） |
| `plesfeda/` | plesfeda 移植 spike。WBS ツリー + 依存エッジを Kimetron で再現し、移植ギャップを洗い出す。階層=smoothstep 灰 / dep=bezier 茶+矢印 / critical=橙太線 / `canConnect` で重複拒否 |
| `sethera/` | sethera-piece 移植 spike。ピース・Σゾーン・calc 配線を Kimetron で再現。方向付きポート（`out`→`a`/`b`）は `canConnect` で実現。line/ellipse/arc/curve の形状 kind ギャラリー付き（P24）。ロック/グループは data のみ（エンジン未対応のギャップ確認用） |

ドライバを追加するときは、サブフォルダに `index.html` + `src/` を置き、
`vite.config.ts` の input とこのテーブルに1行足す。
