# Chat Agent Function (`src/functions/chat`)

## 概要

この Lambda 関数は、RAG（Retrieval-Augmented Generation）ベースのチャット機能を提供します。Lambda Function URL を使用したストリーミングレスポンスに対応し、Vercel AI SDK v3.x の UI Message Stream Protocol (NDJSON) 形式でレスポンスを返します。

## 責務

| 責務               | 説明                                                          |
| ------------------ | ------------------------------------------------------------- |
| **メッセージ処理** | ユーザークエリの受信、RAG コンテキスト検索、AI レスポンス生成 |
| **ストリーミング** | リアルタイムでのレスポンス配信（NDJSON 形式）                 |

## 環境変数

| 変数名                            | 必須 | デフォルト                               | 説明                                |
| --------------------------------- | :--: | ---------------------------------------- | ----------------------------------- |
| `TABLE_NAME`                      |  ✅  | -                                        | Chat History DynamoDB テーブル名    |
| `MODEL_ID`                        |  -   | `anthropic.claude-3-haiku-20240307-v1:0` | Bedrock チャットモデル ID           |
| `USE_MOCK_BEDROCK`                |  -   | `false`                                  | モック Bedrock を使用（ローカル用） |
| `STAGE`                           |  -   | `local`                                  | 環境（local/dev/prod）              |
| `USER_POOL_ID`                    |  -   | -                                        | Cognito User Pool ID                |
| `CLIENT_ID`                       |  -   | -                                        | Cognito Client ID                   |
| `ALLOWED_ORIGINS`                 |  -   | -                                        | CORS 許可オリジン                   |
| `PINECONE_API_KEY_PARAMETER_NAME` |  -   | -                                        | Pinecone API キーのSSMパラメータ名  |
| `PINECONE_INDEX_NAME`             |  -   | -                                        | Pinecone インデックス名             |

## API エンドポイント

### 1. メッセージ送信（ストリーミング）

`POST /chat/stream`

メッセージを送信し、AI レスポンスをストリーミングで受信します。

**リクエスト**

```json
{
  "query": "アップロードしたドキュメントの要約を教えてください"
}
```

**バリデーション**

| 項目   | 制限         |
| ------ | ------------ |
| クエリ | 1〜4000 文字 |

**レスポンス (200 OK, Streaming)**

Vercel AI SDK v3.x の UI Message Stream Protocol (NDJSON) 形式でストリーミング配信されます。

```
0:"こん"
0:"にちは"
0:"、"
0:"ドキュメント"
0:"の"
0:"要約"
0:"です"
0:"。"
e:{"finishReason":"stop","usage":{"promptTokens":150,"completionTokens":50}}
d:{"finishReason":"stop"}
```

**ストリームイベント形式**

| プレフィックス | 説明                       |
| -------------- | -------------------------- |
| `0:`           | テキストチャンク           |
| `e:`           | 完了イベント（使用量情報） |
| `d:`           | 完了シグナル               |

## RAG パイプライン

メッセージ送信時の処理フローです。

```
1. ユーザークエリを受信
     ↓
2. Bedrock Titan でクエリをエンベディング
     ↓
3. Pinecone で類似ベクトルを検索
     ↓
4. 検索結果からコンテキストを構築
     ↓
5. システムプロンプト + コンテキスト + クエリで
   Bedrock Claude を呼び出し
     ↓
6. ストリーミングでレスポンスを返却
     ↓
7. メッセージ履歴を DynamoDB に保存
```

## ストリーミング実装

### Lambda Function URL

API Gateway ではなく、Lambda Function URL を使用してストリーミングレスポンスを実現しています。

```typescript
// template.yaml
ChatAgentFunction:
  Type: AWS::Serverless::Function
  Properties:
    FunctionUrlConfig:
      AuthType: NONE  # 認証は関数内で実施
      InvokeMode: RESPONSE_STREAM
```

### Vercel AI SDK v3.x 対応

UI Message Stream Protocol (NDJSON) 形式でレスポンスを返します。

```typescript
// ストリーミングレスポンスの例
responseStream.write('0:"こんにちは"\n');
responseStream.write('0:"、"\n');
responseStream.write('0:"お手伝い"\n');
responseStream.write('0:"します"\n');
responseStream.write('e:{"finishReason":"stop"}\n');
responseStream.write('d:{"finishReason":"stop"}\n');
```

## 認証

### AWS 環境

Lambda Function URL は `AuthType: NONE` で公開されていますが、関数内で JWT 検証を実施します。`aws-jwt-verify` ライブラリを使用して Cognito トークンを検証します。

```typescript
import { CognitoJwtVerifier } from "aws-jwt-verify";

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID,
  tokenUse: "id",
  clientId: process.env.CLIENT_ID,
});

const payload = await verifier.verify(token);
const ownerId = payload.sub;
```

### ローカル環境

認証をバイパスし、固定の所有者 ID `user-001` を使用します。

## DynamoDB スキーマ

### Chat History Table

| 属性                | 型     | 説明                                                    |
| ------------------- | ------ | ------------------------------------------------------- |
| `pk` (PK)           | String | 主キー                                                  |
| `sk` (SK)           | String | ソートキー                                              |
| `gsi1pk` (GSI-1 PK) | String | グローバルセカンダリインデックス 1 のパーティションキー |
| `gsi1sk` (GSI-1 SK) | String | グローバルセカンダリインデックス 1 のソートキー         |
| `sessionId`         | String | セッション ID                                           |
| `ownerId`           | String | 所有者 ID                                               |
| `sessionName`       | String | セッション名                                            |
| `createdAt`         | String | 作成日時                                                |
| `updatedAt`         | String | 更新日時                                                |
| `lastMessageAt`     | String | 最終メッセージ日時                                      |

### レコード種別

同一テーブル内でセッションメタデータとメッセージ履歴を管理します。

| historyId パターン       | 種別                 |
| ------------------------ | -------------------- |
| `#METADATA`              | セッションメタデータ |
| `msg-{timestamp}-{uuid}` | メッセージ履歴       |

## エラーハンドリング

### エラーコード

| エラーコード                   | HTTP | 説明                   |
| ------------------------------ | ---- | ---------------------- |
| `CHAT_SESSION_NOT_FOUND`       | 404  | セッションが存在しない |
| `CHAT_SESSION_NAME_EMPTY`      | 400  | セッション名が空       |
| `CHAT_SESSION_NAME_TOO_LONG`   | 400  | セッション名が長すぎる |
| `CHAT_QUERY_EMPTY`             | 400  | クエリが空             |
| `CHAT_QUERY_TOO_LONG`          | 400  | クエリが長すぎる       |
| `DOCUMENTS_SELECTION_EMPTY`    | 400  | ドキュメント選択が空   |
| `DOCUMENTS_SELECTION_TOO_MANY` | 400  | ドキュメント選択数超過 |

### ストリーミングエラー

ストリーミング中にエラーが発生した場合、エラーイベントとして配信されます。

```
3:"サーバーエラーが発生しました"
d:{"finishReason":"error"}
```

## ローカル開発での注意点

LocalStack は Lambda Response Streaming を完全にはサポートしていないため、ローカル環境でのストリーミングテストには制限があります。

**推奨アプローチ**:

- 基本的な動作確認はローカルで実施
- ストリーミング動作の確認は AWS dev 環境で実施

```bash
# AWS dev 環境へデプロイしてテスト
npm run deploy:dev
```

## テスト

```bash
# ユニットテスト実行
cd infrastructure
npm run test -- src/functions/chat/

# 手動テスト（curl）
curl -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"query": "Hello"}' \
  "${CHAT_FUNCTION_URL}/chat/sessions/${SESSION_ID}/messages"
```
