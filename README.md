# Myelin Base - RAG Application

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/AWS%20SAM-Serverless-orange?logo=amazonaws" alt="AWS SAM" />
  <img src="https://img.shields.io/badge/Node.js-20.x-green?logo=nodedotjs" alt="Node.js" />
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="License" />
</p>

本格的なプロダクションレベルのAWS Serverless RAG（Retrieval-Augmented Generation）アプリケーションです。ドキュメントのアップロード、処理、AI によるチャット機能を提供します。

## 概要

Myelin Base は、ドキュメントをアップロードすると自動的にテキスト抽出・チャンク分割・ベクトル化が行われ、アップロードしたドキュメントをコンテキストとして AI とチャットができます。

### 主な機能

- 📄 **ドキュメント管理** - PDF/テキストファイルのアップロード、タグ管理、署名付きURLによるセキュアなダウンロード
- 🤖 **RAG チャット** - アップロードしたドキュメントを参照しながら AI とリアルタイムストリーミングチャット
- 🔐 **認証・認可** - Amazon Cognito による安全なユーザー認証
- ⚡ **サーバーレス** - スケーラブルで従量課金のコスト効率の良いアーキテクチャ

## アーキテクチャ

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              AWS Cloud                                   │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐            │
│  │   Cognito    │────▶│ API Gateway  │────▶│   Lambda     │            │
│  │  User Pool   │     │              │     │  Functions   │            │
│  └──────────────┘     └──────────────┘     └──────┬───────┘            │
│                                                    │                    │
│  ┌──────────────┐     ┌──────────────┐     ┌──────▼───────┐            │
│  │   DynamoDB   │◀───▶│      S3      │◀───▶│ Step         │            │
│  │   Tables     │     │   Bucket     │     │ Functions    │            │
│  └──────────────┘     └──────────────┘     └──────────────┘            │
│                                                    │                    │
│  ┌──────────────┐     ┌──────────────┐            │                    │
│  │   Bedrock    │◀────│   Pinecone   │◀───────────┘                    │
│  │  Claude/Titan│     │  Vector DB   │                                 │
│  └──────────────┘     └──────────────┘                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

## 技術スタック

| カテゴリ               | 技術                                              |
| ---------------------- | ------------------------------------------------- |
| **ランタイム**         | Node.js 20.x / TypeScript 5.9                     |
| **IaC**                | AWS SAM (Serverless Application Model)            |
| **コンピューティング** | AWS Lambda (arm64)                                |
| **API**                | API Gateway REST API                              |
| **認証**               | Amazon Cognito                                    |
| **データベース**       | DynamoDB                                          |
| **ストレージ**         | Amazon S3                                         |
| **AI/ML**              | Amazon Bedrock (Claude 3 Haiku, Titan Embeddings) |
| **ベクトルDB**         | Pinecone                                          |
| **ワークフロー**       | AWS Step Functions                                |
| **ローカル開発**       | LocalStack, Docker Compose                        |

## プロジェクト構成

```
myelinbase-backend/
├── infrastructure/           # AWS SAM テンプレート & Lambda関数
│   ├── src/
│   │   ├── functions/       # Lambda関数群
│   │   │   ├── chat/        # チャットAPI (ストリーミング)
│   │   │   ├── documents/   # ドキュメント管理API
│   │   │   ├── health/      # ヘルスチェック
│   │   │   ├── processor/   # DynamoDB Streamsプロセッサ
│   │   │   └── trigger/     # S3イベントトリガー
│   │   └── shared/          # 共有ユーティリティ & クライアント
│   ├── template.yaml        # SAMテンプレート (本番用)
│   └── template-local.yaml  # SAMテンプレート (ローカル用)
├── local-dev/               # ローカル開発環境
│   ├── docker/              # Dockerコンテナ定義
│   ├── scripts/             # デプロイスクリプト
│   └── docker-compose.yml   # ローカル環境構成
├── doc/                     # API ドキュメント
│   └── openapi.yaml         # OpenAPI仕様
└── package.json             # npm workspaces設定
```

## セットアップ

### 前提条件

- Node.js 20.x 以上
- Docker & Docker Compose
- AWS CLI
- AWS SAM CLI
- (オプション) LocalStack CLI

### ローカル開発環境

```bash
# 1. 依存関係のインストール
npm install

# 2. LocalStack & DynamoDB Local を起動
npm run local:start

# 3. ローカル環境へデプロイ
npm run deploy:local

# 4. (別ターミナル) SAM Local API を起動
npm run api:start
```

### AWS 開発環境へのデプロイ

```bash
# ビルド & デプロイ
npm run deploy:dev
```

### 本番環境へのデプロイ

```bash
# ビルド & デプロイ (確認あり)
npm run deploy:prod
```

## npm スクリプト

| コマンド               | 説明                                            |
| ---------------------- | ----------------------------------------------- |
| `npm run local:start`  | ローカル環境を起動 (LocalStack, DynamoDB Local) |
| `npm run local:stop`   | ローカル環境を停止                              |
| `npm run local:reset`  | ローカル環境をリセット (データ削除)             |
| `npm run deploy:local` | LocalStackへデプロイ                            |
| `npm run deploy:dev`   | AWS開発環境へデプロイ                           |
| `npm run deploy:prod`  | AWS本番環境へデプロイ                           |
| `npm run build`        | SAMビルド                                       |
| `npm run validate`     | SAMテンプレート検証                             |
| `npm run lint`         | ESLint実行                                      |
| `npm run test`         | テスト実行                                      |
| `npm run doc:generate` | OpenAPIドキュメント生成                         |

## 環境変数

### 必須環境変数 (AWS)

| 変数名                         | 説明                            |
| ------------------------------ | ------------------------------- |
| `STAGE`                        | 環境 (local/dev/prod)           |
| `TABLE_NAME`                   | DynamoDB ドキュメントテーブル名 |
| `BUCKET_NAME`                  | S3 バケット名                   |
| `PINECONE_API_KEY_SECRET_NAME` | Secrets Manager シークレット名  |
| `PINECONE_INDEX_NAME`          | Pinecone インデックス名         |
| `CHAT_MODEL_ID`                | Bedrock チャットモデルID        |
| `EMBEDDING_MODEL_ID`           | Bedrock エンベディングモデルID  |

### ローカル開発用環境変数

ローカル開発時は `local-dev/env.local.json` で設定を管理しています。

## API エンドポイント

### Documents API

| メソッド | パス                           | 説明                 |
| -------- | ------------------------------ | -------------------- |
| GET      | `/documents`                   | ドキュメント一覧取得 |
| POST     | `/documents/upload`            | アップロードURL発行  |
| GET      | `/documents/{id}`              | ドキュメント詳細取得 |
| GET      | `/documents/{id}/download-url` | ダウンロードURL取得  |
| DELETE   | `/documents/{id}`              | ドキュメント削除     |
| PATCH    | `/documents/{id}/tags`         | タグ更新             |

### Chat API

| メソッド | パス                           | 説明                            |
| -------- | ------------------------------ | ------------------------------- |
| POST     | `/chat/sessions`               | セッション作成                  |
| GET      | `/chat/sessions`               | セッション一覧取得              |
| POST     | `/chat/sessions/{id}/messages` | メッセージ送信 (ストリーミング) |
| GET      | `/chat/sessions/{id}/messages` | メッセージ履歴取得              |

### Health API

| メソッド | パス      | 説明           |
| -------- | --------- | -------------- |
| GET      | `/health` | ヘルスチェック |

## ドキュメント処理フロー

```
1. クライアントが POST /documents/upload でアップロードURLを取得
2. クライアントがS3に直接ファイルをアップロード
3. S3イベントが Lambda (Trigger) を起動
4. Step Functions がRAGパイプラインを実行:
   a. ドキュメントステータスを PROCESSING に更新
   b. テキスト抽出 & チャンク分割
   c. Bedrock Titan でエンベディング生成
   d. Pinecone にベクトル保存
   e. ドキュメントステータスを COMPLETED に更新
```

## 開発ガイドライン

### コーディング規約

- TypeScript strict モードを使用
- `any` 型は禁止（ESLintで検出）
- 全てのエラーハンドリングで適切な型ガードを使用
- Zod スキーマによるバリデーションと型生成

### テスト

```bash
# 全テスト実行
npm run test

# ウォッチモード
npm run test:watch

# カバレッジレポート
npm run test:coverage
```

### ログ確認

```bash
# ローカル: LocalStack ログ
npm run local:logs:localstack

# ローカル: Documents Lambda ログ
npm run local:logs:documents

# AWS開発環境
npm run logs:dev
```

## 関連リポジトリ

- [myelinbase-frontend](../frontend) - Next.js フロントエンド

## ライセンス

MIT License

## 作者

Ryu
