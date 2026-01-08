# Document Cleanup Function (`src/functions/cleanup`)

## 概要

この Lambda 関数は、DynamoDB Streams の `REMOVE` イベントをトリガーとして、削除されたドキュメントに関連するリソース（S3 ファイル、Pinecone ベクトル）をクリーンアップします。

## 責務

| 責務                        | 説明                                                 |
| --------------------------- | ---------------------------------------------------- |
| **DynamoDB Streams 処理**   | Documents テーブルの `REMOVE` イベントを監視         |
| **S3 クリーンアップ**       | 削除されたドキュメントのファイルを S3 から削除       |
| **Pinecone クリーンアップ** | 削除されたドキュメントのベクトルを Pinecone から削除 |

## トリガー

DynamoDB Streams（Documents テーブル）の `REMOVE` イベント

```yaml
# template.yaml での設定
DocumentCleanupFunction:
  Type: AWS::Serverless::Function
  Properties:
    FunctionName: !Sub ${ProjectName}-${Stage}-cleanup
    # ...
    Events:
      DocumentStream:
        Type: DynamoDB
        Properties:
          Stream: !GetAtt DocumentTable.StreamArn
          StartingPosition: LATEST
          BatchSize: 10
          FilterCriteria:
            Filters:
              - Pattern: '{"eventName":["REMOVE"]}'
```

## 環境変数

| 変数名                         | 必須 | 説明                            |
| ------------------------------ | :--: | ------------------------------- |
| `BUCKET_NAME`                  |  ✅  | Documents S3 バケット名         |
| `PINECONE_API_KEY_PARAMETER_NAME` |  ✅  | SSM Parameter Store パラメータ名  |
| `PINECONE_INDEX_NAME`          |  ✅  | Pinecone インデックス名         |
| `S3_ENDPOINT`                  |  -   | S3 エンドポイント（ローカル用） |

## 処理フロー

```
DynamoDB で REMOVE イベント発生（TTL による自動削除）
     ↓
DynamoDB Streams が Lambda をトリガー
     ↓
eventName が REMOVE かチェック
     ↓ (REMOVE の場合のみ処理)
OldImage からドキュメント情報を取得
     ↓
並列処理:
  ├─ S3 からファイルを削除
  └─ Pinecone からベクトルを削除
     ↓
完了
```

## 削除アーキテクチャ全体像

Myelin Base では、ドキュメント削除を以下の2段階で処理します：

```
┌─────────────────────────────────────────────────────────────────────┐
│                        削除フロー全体                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  【Phase 1: 論理削除】                                               │
│  DELETE /documents/{id}                                             │
│       ↓                                                             │
│  Documents Function:                                                │
│    - ステータスを DELETED に更新                                     │
│    - TTL を設定（24時間後に自動削除）                                │
│       ↓                                                             │
│  ユーザーへ即座に 202 Accepted を返却                                │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  【Phase 2: 物理削除（非同期）】                                      │
│  TTL により DynamoDB レコードが自動削除                               │
│       ↓                                                             │
│  DynamoDB Streams: REMOVE イベント発火                               │
│       ↓                                                             │
│  Cleanup Function (この関数):                                        │
│    - S3 ファイル削除                                                 │
│    - Pinecone ベクトル削除                                           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## DynamoDB Streams イベント形式

```json
{
  "Records": [
    {
      "eventName": "REMOVE",
      "dynamodb": {
        "Keys": {
          "documentId": { "S": "doc-001" }
        },
        "OldImage": {
          "documentId": { "S": "doc-001" },
          "ownerId": { "S": "user-001" },
          "s3Key": { "S": "uploads/user-001/doc-001/report.pdf" },
          "status": { "S": "DELETED" }
        }
      }
    }
  ]
}
```

## 実装詳細

### イベント処理

```typescript
export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  for (const record of event.Records) {
    // REMOVE イベントのみ処理
    if (record.eventName !== "REMOVE") {
      continue;
    }

    // OldImage が必要（削除前のデータ）
    if (!record.dynamodb?.OldImage) {
      continue;
    }

    const oldImage = unmarshall(record.dynamodb.OldImage);
    const { documentId, s3Key } = oldImage;

    // S3 と Pinecone を並列で削除
    await Promise.all([deleteFromS3(s3Key), deleteFromPinecone(documentId)]);
  }
};
```

### 並列削除処理

S3 と Pinecone の削除は `Promise.all` で並列実行されます。一方の削除が失敗しても、もう一方の削除は継続します。

```typescript
const promises: Promise<void>[] = [];

// S3 削除
if (s3Key) {
  promises.push(
    deleteS3Object(s3Client, BUCKET_NAME, s3Key).catch((err) => {
      logger("ERROR", "Failed to delete S3 object", {
        documentId,
        s3Key,
        error: err,
      });
    })
  );
}

// Pinecone 削除
promises.push(
  (async () => {
    const apiKey = await getPineconeApiKey();
    const pinecone = createPineconeClient(apiKey);
    await deleteDocumentVectors(pinecone, documentId);
  })().catch((err) => {
    logger("ERROR", "Failed to delete Pinecone vectors", {
      documentId,
      error: err,
    });
  })
);

await Promise.all(promises);
```

## エラーハンドリング

### 削除失敗時の挙動

| 失敗箇所          | 挙動                                    |
| ----------------- | --------------------------------------- |
| S3 削除失敗       | エラーログを出力し、Pinecone 削除は継続 |
| Pinecone 削除失敗 | エラーログを出力し、S3 削除は継続       |
| 両方失敗          | 両方のエラーログを出力、関数は正常終了  |

### なぜ例外をスローしないのか？

DynamoDB Streams のリトライはイベント全体に対して行われるため、一部のレコードが失敗した場合に全体をリトライすると、既に成功したレコードが重複処理される可能性があります。そのため、エラーはログに記録し、関数自体は正常終了させています。

> **注意**: 孤立したリソース（削除されなかった S3 オブジェクトや Pinecone ベクトル）は、定期的なクリーンアップジョブで対応することを推奨します。

## 設計思想

### なぜ REMOVE イベントを使用するのか？

1. **TTL との連携**: DynamoDB の TTL 機能を活用し、自動的にレコードが削除されるタイミングでクリーンアップを実行
2. **確実な実行**: 物理削除のタイミングで必ずクリーンアップが走る
3. **シンプルな実装**: ステータス監視が不要

### processor 関数との違い

| 関数          | トリガー                     | 用途                       |
| ------------- | ---------------------------- | -------------------------- |
| **processor** | MODIFY (DELETING ステータス) | 即座の削除処理が必要な場合 |
| **cleanup**   | REMOVE (物理削除)            | TTL による遅延削除         |

## テスト

```bash
# ユニットテスト実行
cd infrastructure
npm run test -- src/functions/cleanup/

# テストケース
# - REMOVE イベントで S3 と Pinecone が削除される
# - INSERT/MODIFY イベントは無視される
# - s3Key がない場合は S3 削除をスキップ
# - S3 削除失敗時も Pinecone 削除は継続
# - Pinecone 削除失敗時も S3 削除は継続
# - 複数レコードの処理
```

## ローカル開発

LocalStack では DynamoDB Streams がサポートされていますが、TTL による自動削除のシミュレーションには制限があります。

```bash
# 手動で REMOVE イベントをシミュレート
awslocal dynamodb delete-item \
  --table-name myelinbase-local-documents \
  --key '{"documentId": {"S": "doc-001"}}'
```

## 監視

### CloudWatch メトリクス

| メトリクス    | 説明                |
| ------------- | ------------------- |
| `IteratorAge` | Streams の処理遅延  |
| `Errors`      | Lambda 実行エラー数 |
| `Duration`    | 処理時間            |

### アラート推奨設定

```yaml
# IteratorAge が 1 時間を超えた場合にアラート
Threshold: 3600000 # ミリ秒
```

### ログ出力例

```json
{
  "level": "INFO",
  "message": "Processing REMOVE event",
  "documentId": "doc-001",
  "s3Key": "uploads/user-001/doc-001/report.pdf"
}
```

```json
{
  "level": "ERROR",
  "message": "Failed to delete S3 object",
  "documentId": "doc-001",
  "s3Key": "uploads/user-001/doc-001/report.pdf",
  "error": "Access Denied"
}
```
