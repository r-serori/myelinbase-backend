# ローカル開発環境セットアップ

## 概要

このプロジェクトは以下のローカル開発環境を提供します：

- **LocalStack**: S3, SQS, Secrets Manager のエミュレーション
- **DynamoDB Local**: DynamoDB のローカル版
- **DynamoDB Streams Worker**: Streams イベントのエミュレーション
- **DynamoDB Admin**: GUIでテーブル確認

## 前提条件

- Docker & Docker Compose
- Node.js 20+
- AWS CLI v2
- SAM CLI（オプション、Lambda開発用）

## クイックスタート

### 1. 環境変数の設定

```bash
cp .env.local.example .env.local
# .env.local を編集して必要な値を設定
```

### 2. Docker起動

```bash
# 全サービス起動
docker-compose up -d

# ログ確認
docker-compose logs -f

# 特定サービスのログ
docker-compose logs -f dynamodb-streams-worker
```

### 3. 初期化確認

初回起動時、以下が自動作成されます：

- DynamoDB テーブル: `DocumentTable`, `ChatHistoryTable`
- S3 バケット: `dev-documents-bucket`
- SQS キュー: `dev-document-processing-queue`
- Secrets: `pinecone-api-key`

### 4. 動作確認

```bash
# DynamoDB テーブル一覧
aws dynamodb list-tables --endpoint-url http://localhost:8000

# S3 バケット一覧
aws s3 ls --endpoint-url http://localhost:4566

# DynamoDB Admin GUI
open http://localhost:8001
```

## サービス一覧

| サービス | URL | 説明 |
|----------|-----|------|
| LocalStack | http://localhost:4566 | S3, SQS, Secrets Manager |
| DynamoDB Local | http://localhost:8000 | DynamoDB |
| DynamoDB Admin | http://localhost:8001 | GUI管理ツール |

## 開発フロー

### バックエンド開発（NestJS）

```bash
cd backend

# 依存関係インストール
npm install

# 開発サーバー起動
npm run start:dev
```

### フロントエンド開発（Next.js）

```bash
cd frontend

# 依存関係インストール
npm install

# 開発サーバー起動
npm run dev
```

### Lambda開発（SAM Local）

```bash
# API Gateway + Lambda をローカルで起動
sam local start-api \
  --docker-network rag-network \
  --env-vars env.local.json

# 単一関数のテスト
sam local invoke DocumentsFunction \
  --event events/get-documents.json \
  --docker-network rag-network \
  --env-vars env.local.json
```

## よくある操作

### DynamoDB テーブルにテストデータ挿入

```bash
aws dynamodb put-item \
  --endpoint-url http://localhost:8000 \
  --table-name DocumentTable \
  --item '{
    "documentId": {"S": "test-doc-001"},
    "ownerId": {"S": "user-001"},
    "fileName": {"S": "test.pdf"},
    "status": {"S": "PENDING_UPLOAD"},
    "s3Path": {"S": "s3://dev-documents-bucket/uploads/user-001/test-doc-001/test.pdf"},
    "createdAt": {"S": "2024-01-01T00:00:00Z"},
    "updatedAt": {"S": "2024-01-01T00:00:00Z"},
    "tags": {"L": [{"S": "テスト"}]},
    "sk": {"S": "user-001#test-doc-001"}
  }'
```

### S3 にファイルアップロード

```bash
aws s3 cp test.pdf s3://dev-documents-bucket/uploads/user-001/test-doc-001/test.pdf \
  --endpoint-url http://localhost:4566
```

### DynamoDB Streams のテスト（削除要求）

```bash
# deleteRequested を true に設定
aws dynamodb update-item \
  --endpoint-url http://localhost:8000 \
  --table-name DocumentTable \
  --key '{"documentId": {"S": "test-doc-001"}}' \
  --update-expression "SET deleteRequested = :true, #status = :deleting" \
  --expression-attribute-names '{"#status": "status"}' \
  --expression-attribute-values '{":true": {"BOOL": true}, ":deleting": {"S": "DELETING"}}'

# dynamodb-streams-worker のログで削除処理を確認
docker-compose logs -f dynamodb-streams-worker
```

### Secrets の確認

```bash
aws secretsmanager get-secret-value \
  --endpoint-url http://localhost:4566 \
  --secret-id pinecone-api-key
```

## トラブルシューティング

### コンテナが起動しない

```bash
# 全コンテナ停止・削除
docker-compose down -v

# イメージ再ビルド
docker-compose build --no-cache

# 再起動
docker-compose up -d
```

### DynamoDB テーブルが作成されない

```bash
# 手動で初期化スクリプト実行
docker-compose run --rm init-resources
```

### LocalStack の状態リセット

```bash
# ボリューム含めて完全リセット
docker-compose down -v
docker volume rm rag-localstack-data rag-dynamodb-data
docker-compose up -d
```

### ネットワーク接続エラー

```bash
# ネットワーク確認
docker network ls
docker network inspect rag-network

# コンテナ間の疎通確認
docker-compose exec localstack curl http://dynamodb-local:8000
```

## 環境切り替え

### ローカル環境（デフォルト）

```bash
# .env.local を使用
USE_MOCK_BEDROCK=true
USE_MOCK_AUTH=true
```

### AWS Dev環境接続

```bash
# .env.local を編集
USE_MOCK_BEDROCK=false
USE_MOCK_AUTH=false
KNOWLEDGE_BASE_ID=your-actual-kb-id
AWS_PROFILE=dev
```

## ファイル構成

```
.
├── docker-compose.yml           # メインの compose ファイル
├── .env.local.example           # 環境変数サンプル
├── .env.local                   # 環境変数（gitignore）
│
├── docker/
│   └── dynamodb-streams-worker/ # Streams エミュレータ
│       ├── Dockerfile
│       ├── package.json
│       └── src/
│           └── index.js
│
├── localstack-init/             # LocalStack 初期化
│   └── init-localstack.sh
│
├── scripts/
│   └── init-local-resources.sh  # リソース初期化
│
├── events/                      # Lambda テストイベント
│   ├── get-documents.json
│   └── upload-request.json
│
└── env.local.json               # SAM Local 用環境変数
```

## 次のステップ

1. バックエンド開発: `backend/README.md`
2. フロントエンド開発: `frontend/README.md`
3. Lambda開発: `infrastructure/README.md`
4. AWS デプロイ: `docs/deployment.md`