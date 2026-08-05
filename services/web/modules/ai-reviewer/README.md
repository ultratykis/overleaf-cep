# AI Reviewer module

このモジュールは、プロジェクトを参照するローカルなAI Reviewerの製品責務をホストから分離する。

選択範囲、現在の文書、プロジェクト全体の査読、成果物の確認と適用、議論、保存、接続設定、引用点検、Zotero参照を扱う。

## 有効化

機能は既定で無効である。

Webプロセスの開始前に次を設定した場合だけ有効になる。

```sh
OVERLEAF_AI_REVIEWER_ENABLED=true
```

値は大文字小文字を区別しない`true`または`false`だけを受け付ける。

未設定または空の値は無効として扱い、曖昧な値は設定読込時に拒否する。

無効時は、バックエンドのモジュールと有効時の処理を読み込まない。

エディタ拡張はwebpackビルド時に解決されるため、`server-ce/Dockerfile`はコンパイル工程で本フラグを常に立てて拡張をバンドルに含める。有効・無効の判断は実行時の本フラグだけが行う。

## 設計資料

- 製品範囲と安全境界：`../../../../.loop/SPEC.md`
- 利用者から見える振る舞い：`../../../../.loop/PRODUCT_DESIGN.md`
- provider内部設計：`../../../../.loop/ARCHITECTURE.md`
- 既存状態の移行：`../../../../.loop/MIGRATION.md`
- 採用済み決定：`../../../../.loop/DECISIONS.md`
- 機能到達状況：`../../../../.loop/CAPABILITY_STATUS.md`
- 技術状態：`../../../../.loop/STATE.md`
- 検証契約：`../../../../.loop/EVALS.md`

現在のモデル通信、型、保存形式、利用SDKは移行対象であり、採用済みの`ARCHITECTURE.md`より優先しない。

ホストとの現在の接続境界は`docs/architecture.md`に記録する。

上流更新の手順は`docs/upstream-sync.md`に記録する。

## 基本確認

```sh
yarn --cwd services/web test:unit:run_dir \
  modules/ai-reviewer/test/unit/src
```

変更内容に応じた確認範囲は`../../../../.loop/EVALS.md`に従う。
