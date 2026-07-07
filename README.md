# MCP Proxy Server (Patched)

[ptbsare/mcp-proxy-server](https://github.com/ptbsare/mcp-proxy-server) (v0.4.1) をベースにした個人パッチ版のHome Assistant addon。

## 上流からの独自修正点

1. **SSEバックエンドへのツール呼び出しの度に無条件で再接続していた挙動を修正**：実際にエラーが起きた時だけ再接続するよう変更（毎回の切断/再接続サイクルによる遅延・新たな失敗ポイントを解消）
2. **クライアント側transportが際限なく溜まり続ける問題を修正**：`onclose`/`onerror`が発火しないケース（このproxyが別のリバースプロキシ/webhookブリッジの裏にいる場合など）で発生。30分アイドルのtransportを5分毎に強制クローズする仕組みを追加
3. **リトライ前の再接続処理をhttpトランスポートにも拡張**：以前はSSEのみが対象で、httpバックエンド（bitbank等）は接続が一度詰まるとリトライしても永遠に直らない構造的欠陥があった

詳細は各パッチのコード内コメント（`PATCHED (kouichi550803):`で検索）を参照。

ビルドはローカルソースから行う（GHCRのimageを直接pullしない）。
