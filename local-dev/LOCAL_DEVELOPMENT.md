# Local Development Environment (`local-dev`)

## 概要

このディレクトリには、ローカル開発環境の構成ファイルとスクリプトが含まれています。LocalStack と DynamoDB Local を使用して、AWS サービスをローカルでエミュレートします。

## アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Network (rag-network)             │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐    ┌─────────────────┐                │
│  │   LocalStack    │    │  DynamoDB Local │                │
│  │   (port 4566)   │    │   (port 8000)   │                │
│  │                 │    │                 │                │
│  │  - S3           │    │  - Documents    │                │
│  │  - Lambda       │    │  - ChatHistory  │                │
│  │  - API Gateway  │    │                 │                │
│  │  - SFN          │    └─────────────────┘                │
│  │  - Logs         │                                       │
│  │  - Secrets      │    ┌─────────────────┐                │
│  └─────────────────┘    │  DynamoDB Admin │                │
│                         │   (port 8001)   │                │
│                         └─────────────────┘                │
│                                                            │
│  ┌─────────────────┐                                       │
│  │ RAG Status      │ (Optional)                            │
│  │ Simulator       │                                       │
│  └─────────────────┘                                       │
└─────────────────────────────────────────────────────────────┘
            ↑
            │ host.docker.internal
            ↓
┌─────────────────────────────────────────────────────────────┐
│                      Host Machine                           │
│                                                            │
│  Frontend (Next.js)  ←→  SAM Local API                     │
│     port 3001             port 3000                        │
└─────────────────────────────────────────────────────────────┘
```

## ディレクトリ構成

```
local-dev/
├── docker/
│   └── rag-status-simulator/    # RAG ステータスシミュレーター
├── scripts/
│   └── deploy-local.sh          # ローカルデプロイスクリプト
├── docker-compose.yml           # Docker Compose 設定
└── env.local.json               # SAM ローカル環境変数
```

## クイックスタート

```bash
# 1. Docker コンテナを起動
npm run local:start

# 2. LocalStack にデプロイ
npm run deploy:local

# 3. SAM Local API を起動（別ターミナル）
npm run api:start

# 4. 動作確認
curl http://localhost:4566/restapis/<api-id>/local/_user_request_/health
```

## Docker Compose サービス

### LocalStack

AWS サービスのローカルエミュレーター。

| 項目                 | 値                                                                        |
| -------------------- | ------------------------------------------------------------------------- |
| ポート               | 4566                                                                      |
| エミュレートサービス | S3, Lambda, API Gateway, Step Functions, CloudWatch Logs, Secrets Manager |
| データ永続化         | `./localstack-data`                                                       |

### DynamoDB Local

DynamoDB のローカル版。

| 項目         | 値                |
| ------------ | ----------------- |
| ポート       | 8000              |
| データ永続化 | `./dynamodb-data` |

### DynamoDB Admin

DynamoDB を GUI で操作するための Web UI。

| 項目   | 値                    |
| ------ | --------------------- |
| ポート | 8001                  |
| URL    | http://localhost:8001 |

## npm スクリプト

| コマンド                        | 説明                         |
| ------------------------------- | ---------------------------- |
| `npm run local:start`           | Docker コンテナを起動        |
| `npm run local:start:nocache`   | キャッシュなしで起動         |
| `npm run local:stop`            | コンテナを停止               |
| `npm run local:stop:volumes`    | コンテナとボリュームを削除   |
| `npm run local:reset`           | 環境をリセット（データ削除） |
| `npm run local:reset:nocache`   | キャッシュなしでリセット     |
| `npm run local:logs`            | 全コンテナのログを表示       |
| `npm run local:logs:localstack` | LocalStack のログを表示      |
| `npm run deploy:local`          | LocalStack にデプロイ        |
| `npm run api:start`             | SAM Local API を起動         |

## 環境変数設定 (`env.local.json`)

SAM Local で使用する環境変数を定義しています。

```json
{
  "Parameters": {
    "AWS_REGION": "us-east-1",
    "DYNAMODB_ENDPOINT": "http://host.docker.internal:8000",
    "S3_ENDPOINT": "http://host.docker.internal:4566",
    "STAGE": "local"
  },
  "DocumentsFunction": {
    "TABLE_NAME": "myelinbase-local-documents",
    "BUCKET_NAME": "myelinbase-local-docs"
  },
  "ChatAgentFunction": {
    "TABLE_NAME": "myelinbase-local-chat-history",
    "USE_MOCK_BEDROCK": "true"
  }
}
```

## デプロイスクリプト (`deploy-local.sh`)

LocalStack への自動デプロイを行うスクリプトです。

### 処理内容

1. LocalStack の起動確認
2. DynamoDB テーブル作成
3. S3 バケット作成
4. SAM ビルド（`template-local.yaml` 使用）
5. CloudFormation パッケージング
6. LocalStack へデプロイ
7. S3 イベント通知設定
8. フロントエンド `.env.local` の自動更新

### 出力例

```
🔍 Checking LocalStack...
✅ LocalStack is running

📦 Creating DynamoDB tables...
✅ Table myelinbase-local-documents created

🪣 Creating S3 bucket...
✅ Bucket myelinbase-local-docs created

🔨 Building SAM application...
✅ Build complete

🚀 Deploying to LocalStack...
✅ Deployment complete!

📋 ローカル開発情報:
---------------------------------------------------
API Endpoint: http://localhost:4566/restapis/<api-id>/local/_user_request_/
DynamoDB Admin: http://localhost:8001
認証: バイパス（user-001 として自動認証）
---------------------------------------------------
```

## 認証バイパス

ローカル環境では Cognito 認証をバイパスし、固定のユーザー ID `user-001` を使用します。

```typescript
// Lambda 関数内での判定
function extractOwnerId(event: APIGatewayProxyEvent): string {
  if (process.env.STAGE === "local") {
    return "user-001";
  }
  // AWS 環境では Cognito から取得
  return event.requestContext?.authorizer?.claims?.sub;
}
```

## LocalStack の制限事項

LocalStack の無料版には以下の制限があります。

| サービス                  | 制限                               |
| ------------------------- | ---------------------------------- |
| Cognito                   | サポートなし（認証バイパスで対応） |
| Lambda Response Streaming | 部分的サポート                     |
| Bedrock                   | サポートなし（モックで対応）       |

## ストリーミングの制限

LocalStack では Lambda Response Streaming が完全にはサポートされていないため、チャット機能のストリーミングテストは AWS dev 環境で実施することを推奨します。

```bash
# AWS dev 環境へデプロイ
npm run deploy:dev
```

## トラブルシューティング

### LocalStack が起動しない

```bash
# コンテナの状態確認
docker-compose ps

# ログ確認
npm run local:logs:localstack

# 完全リセット
npm run local:reset:nocache
```

### DynamoDB に接続できない

```bash
# テーブル一覧確認
awslocal dynamodb list-tables

# エンドポイント確認
curl http://localhost:8000
```

### API Gateway エンドポイントが不明

```bash
# REST API 一覧取得
awslocal apigateway get-rest-apis

# API ID から URL を構築
# http://localhost:4566/restapis/{api-id}/local/_user_request_/
```

### S3 イベントが発火しない

```bash
# 通知設定確認
awslocal s3api get-bucket-notification-configuration \
  --bucket myelinbase-local-docs

# 手動で再設定
npm run deploy:local
```

## 便利なコマンド

```bash
# DynamoDB テーブルのスキャン
awslocal dynamodb scan --table-name myelinbase-local-documents

# S3 バケットの内容確認
awslocal s3 ls s3://myelinbase-local-docs/uploads/ --recursive

# Lambda 関数一覧
awslocal lambda list-functions

# CloudWatch ログ取得
awslocal logs filter-log-events \
  --log-group-name /aws/lambda/myelinbase-local-documents \
  --limit 20

# Step Functions 実行一覧
awslocal stepfunctions list-executions \
  --state-machine-arn arn:aws:states:us-east-1:000000000000:stateMachine:myelinbase-local-rag-pipeline
```

## フロントエンドとの連携

デプロイスクリプトは自動的にフロントエンドの `.env.local` を更新します。

```bash
# 更新される内容
NEXT_PUBLIC_API_BASE_URL="http://localhost:4566/restapis/<api-id>/local/_user_request_"
```

手動で更新する場合：

```bash
# API ID を取得
API_ID=$(awslocal apigateway get-rest-apis --query "items[?name=='myelinbase-local-api'].id" --output text)

# .env.local を更新
echo "NEXT_PUBLIC_API_BASE_URL=\"http://localhost:4566/restapis/$API_ID/local/_user_request_\"" > ../frontend/.env.local
```
