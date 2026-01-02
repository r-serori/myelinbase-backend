# Ingestion Trigger Function (`src/functions/trigger`)

## 概要

この Lambda 関数は、S3 へのファイルアップロードをトリガーとして RAG パイプライン（Step Functions）を起動します。ドキュメントのインジェスチョン処理の起点となる関数です。

## 責務

| 責務                 | 説明                                         |
| -------------------- | -------------------------------------------- |
| **S3 イベント処理**  | `s3:ObjectCreated:*` イベントを受信          |
| **パイプライン起動** | Step Functions ステートマシンの実行を開始    |
| **メタデータ更新**   | ドキュメントステータスを `PROCESSING` に更新 |

## トリガー条件

| 項目           | 値                   |
| -------------- | -------------------- |
| イベントタイプ | `s3:ObjectCreated:*` |
| バケット       | Documents バケット   |
| プレフィックス | `uploads/`           |

```yaml
# template.yaml での設定
Events:
  S3Upload:
    Type: S3
    Properties:
      Bucket: !Ref DocumentsBucket
      Events: s3:ObjectCreated:*
      Filter:
        S3Key:
          Rules:
            - Name: prefix
              Value: uploads/
```

## 環境変数

| 変数名                    | 必須 | 説明                                    |
| ------------------------- | :--: | --------------------------------------- |
| `STATE_MACHINE_ARN`       |  ✅  | Step Functions ステートマシン ARN       |
| `PROCESSOR_FUNCTION_NAME` |  ✅  | Doc Processor Lambda 関数名             |
| `TABLE_NAME`              |  ✅  | Documents DynamoDB テーブル名           |
| `LOCALSTACK_ENDPOINT`     |  -   | LocalStack エンドポイント（ローカル用） |

## 処理フロー

```
S3 へファイルアップロード
     ↓
S3 イベント通知が Lambda をトリガー
     ↓
S3 キーからドキュメント ID を抽出
  (uploads/{ownerId}/{documentId}/{fileName})
     ↓
DynamoDB のステータスを PROCESSING に更新
     ↓
Step Functions を起動（documentId, s3Key を渡す）
     ↓
Lambda 完了（Step Functions が非同期で処理を継続）
```

## S3 キー形式

```
uploads/{ownerId}/{documentId}/{fileName}
```

**例**:

```
uploads/user-001/550e8400-e29b-41d4-a716-446655440000/report.pdf
```

## Step Functions 入力

```json
{
  "documentId": "550e8400-e29b-41d4-a716-446655440000",
  "s3Key": "uploads/user-001/550e8400.../report.pdf",
  "bucket": "myelinbase-docs"
}
```

## RAG パイプライン（Step Functions）

```
┌─────────────────────────────────────────────┐
│           RAG Ingestion Pipeline            │
├─────────────────────────────────────────────┤
│  1. UpdateStatus (PROCESSING)               │
│     ↓                                       │
│  2. ExtractText                             │
│     - S3 からファイル取得                    │
│     - PDF/テキストからテキスト抽出           │
│     ↓                                       │
│  3. ChunkText                               │
│     - テキストをチャンク分割                 │
│     - オーバーラップウィンドウ方式           │
│     ↓                                       │
│  4. GenerateEmbeddings                      │
│     - Bedrock Titan でエンベディング生成     │
│     ↓                                       │
│  5. UpsertVectors                           │
│     - Pinecone にベクトル保存               │
│     ↓                                       │
│  6. UpdateStatus (COMPLETED)                │
├─────────────────────────────────────────────┤
│  Error Handler → UpdateStatus (FAILED)      │
└─────────────────────────────────────────────┘
```

## エラーハンドリング

### イベント解析エラー

S3 イベントの解析に失敗した場合、エラーログを出力して処理を終了します。

```typescript
if (!s3Key || !bucket) {
  logger("ERROR", "Invalid S3 event", { event });
  return;
}
```

### Step Functions 起動エラー

ステートマシンの起動に失敗した場合、エラーをスローして Lambda の再試行メカニズムに委ねます。

## ローカル開発

LocalStack では S3 イベント通知の設定が必要です。デプロイスクリプトが自動的に設定します。

```bash
# deploy-local.sh での設定
awslocal s3api put-bucket-notification-configuration \
  --bucket myelinbase-local-docs \
  --notification-configuration '{
    "LambdaFunctionConfigurations": [
      {
        "Id": "TriggerOnUpload",
        "LambdaFunctionArn": "arn:aws:lambda:...",
        "Events": ["s3:ObjectCreated:*"],
        "Filter": {
          "Key": {
            "FilterRules": [
              { "Name": "prefix", "Value": "uploads/" }
            ]
          }
        }
      }
    ]
  }'
```

## テスト

```bash
# SAM CLI でローカルテスト
npm run test:trigger

# S3 イベントを模擬（events/s3-put.json）
{
  "Records": [
    {
      "s3": {
        "bucket": { "name": "myelinbase-local-docs" },
        "object": { "key": "uploads/user-001/doc-001/test.pdf" }
      }
    }
  ]
}
```
