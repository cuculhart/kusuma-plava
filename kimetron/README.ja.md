# Kimetron Isle

**World-coordinate canvas engine — position is data.**

フレームワーク非依存の 2D 配置エンジン。
CAD 流のワールド座標（実寸単位・原点選択・グリッドスナップ・縮尺ズーム）
を、見た目ではなく「データ」として扱う。

開発初期。まだインストールできるものはありません。

## 構成

| パス | パッケージ | 役割 |
|------|-----------|------|
| `packages/core` | `@kimetron/core` | モデル・座標系・選択・ドラッグ・ヒットテスト・ビューポート（DOM 非依存の vanilla TS） |
| `packages/dom` | `@kimetron/dom` | DOM + CSS transform レンダラ |
| `packages/react` | `@kimetron/react` | 薄い React アダプタ（components + hooks） |
| `drivers/` | — | エンジンを使う側のサンプルアプリ（プレイグラウンド、将来の sethera/plesfeda 系統合） |

## 開発

```sh
npm install
npm run dev        # プレイグラウンド（drivers/demo）
npm run typecheck  # 全ワークスペース
npm run test       # vitest
npm run build      # 全ワークスペース
```

## License

MIT
