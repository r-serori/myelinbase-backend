# Stream Processor Function (`src/functions/processor`)

## 概要

この Lambda 関数は、DynamoDB Streams のイベントを処理し、削除されたドキュメントのクリーンアップを実行します。論理削除（`DELETING` ステータス）されたドキュメントの実データを非同期で物理削除します。

## 責務

| 責務                        | 説明                                               |
| --------------------------- | -------------------------------------------------- |
| **DynamoDB Streams 処理**   | Documents テーブルの変更イベントを監視             |
| **S3 クリーンアップ**       | 削除対象ドキュメントのファイルを S3 から削除       |
| **Pinecone クリーンアップ** | 削除対象ドキュメントのベクトルを Pinecone から削除 |
| **DynamoDB クリーンアップ** | レコードの物理削除                                 |

## トリガー

DynamoDB Streams（Documents テーブル）の `MODIFY` イベント

```yaml
# template.yaml での設定
Events:
  DocumentStream:
    Type: DynamoDB
    Properties:
      Stream: !GetAtt DocumentTable.StreamArn
      StartingPosition: LATEST
      BatchSize: 10
      FilterCriteria:
        Filters:
          - Pattern: '{"eventName":["MODIFY"]}'
```

## 環境変数

| 変数名                         | 必須 | 説明                            |
| ------------------------------ | :--: | ------------------------------- |
| `TABLE_NAME`                   |  ✅  | Documents DynamoDB テーブル名   |
| `BUCKET_NAME`                  |  ✅  | Documents S3 バケット名         |
| `PINECONE_API_KEY_PARAMETER_NAME` |  ✅  | SSM Parameter Store パラメータ名  |
| `PINECONE_INDEX_NAME`          |  ✅  | Pinecone インデックス名         |
| `S3_ENDPOINT`                  |  -   | S3 エンドポイント（ローカル用） |

## 処理フロー

```
Documents テーブルで MODIFY イベント発生
     ↓
DynamoDB Streams が Lambda をトリガー
     ↓
NewImage のステータスが DELETING かチェック
     ↓ (DELETING の場合のみ処理)
S3 からファイルを削除
     ↓
Pinecone からベクトルを削除
  (documentId をプレフィックスとして持つ全ベクトル)
     ↓
DynamoDB からレコードを物理削除
     ↓
完了
```

## 削除フロー全体像

```
┌─────────────────────────────────────────────────────────────┐
│                     削除リクエスト                           │
│  DELETE /documents/{id}                                     │
│     ↓                                                       │
│  Documents Function: ステータスを DELETING に更新            │
│     ↓                                                       │
│  DynamoDB: MODIFY イベント発生                               │
│     ↓                                                       │
│  DynamoDB Streams: イベントを Stream Processor に配信        │
│     ↓                                                       │
│  Stream Processor Function:                                 │
│    1. S3 ファイル削除                                       │
│    2. Pinecone ベクトル削除                                 │
│    3. DynamoDB レコード物理削除                             │
└─────────────────────────────────────────────────────────────┘
```

## DynamoDB Streams イベント形式

```json
{
  "Records": [
    {
      "eventName": "MODIFY",
      "dynamodb": {
        "Keys": {
          "documentId": { "S": "doc-001" }
        },
        "NewImage": {
          "documentId": { "S": "doc-001" },
          "ownerId": { "S": "user-001" },
          "status": { "S": "DELETING" },
          "s3Key": { "S": "uploads/user-001/doc-001/report.pdf" }
        },
        "OldImage": {
          "documentId": { "S": "doc-001" },
          "status": { "S": "COMPLETED" }
        }
      }
    }
  ]
}
```

## Pinecone ベクトル削除

ドキュメントのチャンクは以下の ID 形式で Pinecone に保存されています。

```
{documentId}-chunk-{index}
```

削除時は `documentId` をプレフィックスとして全ベクトルを削除します。

```typescript
await pineconeIndex.deleteMany({
  filter: {
    documentId: { $eq: documentId },
  },
});
```

## エラーハンドリング

### 部分的な削除失敗

S3 や Pinecone の削除が部分的に失敗した場合でも、処理を継続します。失敗した削除はログに記録されます。

```typescript
try {
  await s3Client.send(new DeleteObjectCommand({ ... }));
} catch (error) {
  logger('WARN', 'Failed to delete S3 object', { s3Key, error });
  // 処理は継続
}
```

### DynamoDB 削除失敗

DynamoDB からの物理削除に失敗した場合、エラーをスローして DynamoDB Streams のリトライメカニズムに委ねます。

## 設計思想

### なぜ即座に物理削除しないのか？

1. **HTTP セマンティクス**: DELETE リクエストに対して即座に 200/204 を返すことが期待される
2. **スケーラビリティ**: S3 や Pinecone の削除は時間がかかる可能性がある
3. **信頼性**: 非同期処理により、一時的な障害に対してリトライが可能

### なぜ論理削除を経由するのか？

1. **監査証跡**: 削除リクエストの記録を残せる
2. **リカバリ**: 誤削除からの復旧が可能（実装次第）
3. **整合性**: 外部サービス（Pinecone）との整合性を保ちやすい

## ローカル開発

LocalStack では DynamoDB Streams がサポートされていますが、完全な動作確認は AWS 環境で実施することを推奨します。

```bash
# DynamoDB Streams の有効化確認
awslocal dynamodb describe-table \
  --table-name myelinbase-local-documents \
  --query 'Table.StreamSpecification'
```

## テスト

```bash
# ユニットテスト
cd infrastructure
npm run test -- src/functions/processor/

# 手動テスト（DynamoDB ステータス更新）
awslocal dynamodb update-item \
  --table-name myelinbase-local-documents \
  --key '{"documentId": {"S": "doc-001"}}' \
  --update-expression "SET #s = :status" \
  --expression-attribute-names '{"#s": "status"}' \
  --expression-attribute-values '{":status": {"S": "DELETING"}}'
```

## 監視

### CloudWatch メトリクス

- `IteratorAge`: Streams の遅延を監視
- `Errors`: 処理エラー数
- `Duration`: 処理時間

### ログ

```json
{
  "level": "INFO",
  "message": "Document cleanup completed",
  "documentId": "doc-001",
  "s3Deleted": true,
  "pineconeDeleted": true,
  "dynamoDeleted": true
}
```
