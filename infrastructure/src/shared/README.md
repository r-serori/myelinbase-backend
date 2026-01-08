# Shared Layer (`src/shared`)

## 概要

`src/shared` ディレクトリは、全ての Lambda 関数で共有されるビジネスロジック、型定義、ユーティリティ、外部サービスクライアントを集約した内部ライブラリです。

各 Lambda 関数はこのディレクトリをインポートすることで、実装の重複を防ぎ、一貫した挙動（エラーハンドリング、ログ出力、型定義）を保証します。

## 設計原則

- **Single Source of Truth**: Zod スキーマを中心に、バリデーション・型定義・OpenAPI ドキュメントを一元管理
- **環境依存の隠蔽**: ローカル/AWS 環境の切り替えは clients と utils の初期化部分に集約
- **薄い Lambda 関数**: 主要なロジックは shared に寄せ、Lambda 関数は薄く保つ

## ディレクトリ構成

```
src/shared/
├── clients/            # 外部サービスクライアント
│   ├── bedrock.ts      # AWS Bedrock (Claude, Titan)
│   └── pinecone.ts     # Pinecone Vector DB
├── schemas/            # Zod スキーマ (バリデーション & OpenAPI)
│   ├── common.ts       # 共通スキーマ
│   ├── document.ts     # ドキュメント関連スキーマ
│   ├── chat.ts         # チャット関連スキーマ
│   └── error.ts        # エラーコード定義
├── types/              # TypeScript 型定義
│   ├── document.ts     # ドキュメント型 (z.infer で生成)
│   └── chat.ts         # チャット型 (z.infer で生成)
└── utils/              # 汎用ユーティリティ
    ├── api-handler.ts  # API Gateway ハンドラーラッパー
    ├── dynamodb.ts     # DynamoDB クライアント & ヘルパー
    ├── s3.ts           # S3 クライアント & 署名付きURL
    ├── rag.ts          # RAG 関連ユーティリティ
    ├── text-processing.ts  # テキスト抽出 & チャンク分割
    └── embeddings.ts   # エンベディング生成
```

## Schemas & Types

**「Single Source of Truth」** の原則に基づき、Zod スキーマを中心に設計されています。

### Zod スキーマ (`schemas/*.ts`)

- ランタイムバリデーション（入力チェック）
- OpenAPI ドキュメント生成 (`@asteasolutions/zod-to-openapi`)

```typescript
// schemas/document.ts
import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const DocumentStatusSchema = z
  .enum([
    "PENDING_UPLOAD",
    "PROCESSING",
    "COMPLETED",
    "FAILED",
    "DELETING",
    "DELETED",
  ])
  .openapi({ description: "ドキュメントのステータス" });
```

### TypeScript 型 (`types/*.ts`)

`z.infer<typeof Schema>` を使用して、Zod スキーマから静的な型定義を自動生成しています。

```typescript
// types/document.ts
import { z } from "zod";
import {
  DocumentStatusSchema,
  DocumentEntitySchema,
} from "../schemas/document";

export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;
export type DocumentEntity = z.infer<typeof DocumentEntitySchema>;
```

これにより **「ドキュメント」「実装（型）」「バリデーション」** の3つが常に同期します。

## API Handler (`utils/api-handler.ts`)

全ての Lambda 関数（API Gateway トリガー）は、このラッパー関数を通して実装されます。

### 機能

| 機能                             | 説明                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------- |
| **統一されたエラーハンドリング** | `AppError` や `ZodError` を適切な HTTP ステータスコードとエラーレスポンスに変換 |
| **構造化ログ**                   | リクエスト情報（パス、メソッド、RequestId）を含む JSON ログを自動出力           |
| **CORS ヘッダー付与**            | 環境変数 `ALLOWED_ORIGINS` に基づきヘッダーを注入                               |
| **ストリーミング対応**           | Lambda Response Streaming とローカル用ポリフィルを透過的に切り替え              |

### 使用例

```typescript
import {
  apiHandler,
  AppError,
  ErrorCode,
} from "../../shared/utils/api-handler.js";

export const handler = apiHandler(async (event) => {
  // 正常系ロジックのみ記述
  const result = await someBusinessLogic();

  // エラーを投げれば自動的にハンドリングされる
  if (!result) {
    throw new AppError(404, ErrorCode.DOCUMENTS_NOT_FOUND);
  }

  return {
    statusCode: 200,
    body: JSON.stringify(result),
  };
});
```

### ストリーミングハンドラー

```typescript
import { streamApiHandler } from "../../shared/utils/api-handler.js";

export const handler = streamApiHandler(async (event, responseStream) => {
  // ストリーミングレスポンスを送信
  for await (const chunk of generateResponse()) {
    responseStream.write(chunk);
  }
  responseStream.end();
});
```

## Clients (`clients/`)

外部サービスへの接続ロジックを隠蔽し、環境（ローカル/AWS）に応じた初期化を行います。

### Bedrock Client (`bedrock.ts`)

AWS Bedrock への接続を管理。

```typescript
// エンベディング生成
import { generateEmbeddings } from '../../shared/clients/bedrock.js';

const embeddings = await generateEmbeddings(textChunks);
// バッチ処理に対応、Titan Embeddings を使用

// ストリーミング推論
import { invokeClaudeStream } from '../../shared/clients/bedrock.js';

const stream = await invokeClaudeStream({
  messages: [...],
  system: 'You are a helpful assistant.'
});
```

### Pinecone Client (`pinecone.ts`)

Pinecone Vector Database への接続を管理。

```typescript
import {
  getPineconeClient,
  upsertVectors,
  queryVectors,
} from "../../shared/clients/pinecone.js";

// ベクトルのアップサート
await upsertVectors(indexName, vectors);

// 類似ベクトル検索
const results = await queryVectors(indexName, queryVector, topK);
```

**特徴**:

- Secrets Manager からの API キー取得（キャッシュ付き）
- Pinecone SDK のラッパー（Upsert, Query, Delete）

## Utilities (`utils/`)

### DynamoDB (`dynamodb.ts`)

```typescript
import { docClient, TABLE_NAME } from "../../shared/utils/dynamodb.js";

// 環境に応じたエンドポイント設定
// - ローカル: http://localhost:8000
// - AWS: デフォルトエンドポイント

// ページネーション用カーソルのエンコード/デコード
import {
  encodeNextToken,
  decodeNextToken,
} from "../../shared/utils/dynamodb.js";
```

### S3 (`s3.ts`)

```typescript
import {
  getPresignedUploadUrl,
  getPresignedDownloadUrl,
} from "../../shared/utils/s3.js";

// アップロード用署名付きURL
const uploadUrl = await getPresignedUploadUrl({
  bucket: BUCKET_NAME,
  key: s3Key,
  contentType: "application/pdf",
  expiresIn: 900, // 15分
});

// ダウンロード用署名付きURL
const downloadUrl = await getPresignedDownloadUrl({
  bucket: BUCKET_NAME,
  key: s3Key,
  expiresIn: 3600, // 1時間
});
```

**特徴**:

- LocalStack 環境への対応 (`forcePathStyle: true`)

### Text Processing (`text-processing.ts`)

```typescript
import {
  extractTextFromPdf,
  chunkText,
} from "../../shared/utils/text-processing.js";

// PDF からテキスト抽出
const text = await extractTextFromPdf(pdfBuffer);

// テキストをチャンク分割 (Overlapping Window)
const chunks = chunkText(text, {
  chunkSize: 1000,
  chunkOverlap: 200,
});
```

**特徴**:

- `pdf-parse` を用いた PDF テキスト抽出
- LangChain を使わない軽量なチャンク分割ロジック

### RAG (`rag.ts`)

RAG パイプラインのユーティリティ関数群。

```typescript
import { processDocument, retrieveContext } from "../../shared/utils/rag.js";

// ドキュメント処理 (抽出 → チャンク → エンベディング → アップサート)
await processDocument(documentId, s3Key);

// コンテキスト検索
const context = await retrieveContext(query, topK);
```

## エラーコード (`schemas/error.ts`)

全 Lambda 関数で統一されたエラーコードを定義しています。

```typescript
export const ErrorCode = {
  // 共通
  VALIDATION_FAILED: "VALIDATION_FAILED",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  RESOURCE_NOT_FOUND: "RESOURCE_NOT_FOUND",
  INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",

  // Documents
  DOCUMENTS_NOT_FOUND: "DOCUMENTS_NOT_FOUND",
  DOCUMENTS_FILE_TOO_LARGE: "DOCUMENTS_FILE_TOO_LARGE",
  DOCUMENTS_UNSUPPORTED_FILE_TYPE: "DOCUMENTS_UNSUPPORTED_FILE_TYPE",

  // Chat
  CHAT_SESSION_NOT_FOUND: "CHAT_SESSION_NOT_FOUND",
  CHAT_QUERY_EMPTY: "CHAT_QUERY_EMPTY",
  // ...
} as const;
```

## 開発ガイドライン

### 1. ロジックは shared に寄せる

Lambda 関数は薄く保ち、主要なロジックは shared に集約します。

```typescript
// ❌ Bad: Lambda 関数に直接ロジックを書く
export const handler = async (event) => {
  const client = new DynamoDBClient({ ... }); // 初期化ロジック
  // 複雑なビジネスロジック
};

// ✅ Good: shared からインポート
import { docClient } from '../../shared/utils/dynamodb.js';
import { processDocument } from '../../shared/utils/rag.js';

export const handler = apiHandler(async (event) => {
  await processDocument(documentId, s3Key);
});
```

### 2. 環境依存は初期化部分に閉じ込める

```typescript
// utils/dynamodb.ts
const endpoint =
  process.env.STAGE === "local" ? process.env.DYNAMODB_ENDPOINT : undefined;

export const docClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ endpoint })
);
```

### 3. 型安全性を保つ

- `any` 型は使用禁止（ESLint で検出）
- エラーハンドリングでは適切な型ガードを使用

```typescript
// ❌ Bad
} catch (error: any) {
  console.error(error.message);
}

// ✅ Good
} catch (error: unknown) {
  if (error instanceof Error) {
    console.error(error.message);
  }
}
```

### 4. 循環参照を回避

utils 同士の依存関係に注意し、循環参照が発生しないように設計します。

## npm パッケージ設定

`package.json` でエクスポートを定義しています。

```json
{
  "name": "../../shared",
  "exports": {
    "./utils/dynamodb.js": "./utils/dynamodb.ts",
    "./utils/s3.js": "./utils/s3.ts",
    "./utils/rag.js": "./utils/rag.ts",
    "./clients/bedrock.js": "./clients/bedrock.ts",
    "./clients/pinecone.js": "./clients/pinecone.ts",
    "./types/document.js": "./types/document.ts",
    "./types/chat.js": "./types/chat.ts"
  }
}
```
