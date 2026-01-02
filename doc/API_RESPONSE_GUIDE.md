# API Documentation (`doc`)

## 概要

このディレクトリには、Myelin Base Backend の API ドキュメントが含まれています。OpenAPI 3.0 仕様に基づいて定義されており、フロントエンドの API クライアント生成や API ドキュメントの公開に使用されます。

## ファイル構成

```
doc/
└── openapi.yaml    # OpenAPI 3.0 仕様書
```

## OpenAPI 仕様 (`openapi.yaml`)

### 概要

- **バージョン**: OpenAPI 3.0.0
- **タイトル**: Myelin Base RAG API
- **ベース URL**: `/api`

### 認証

```yaml
securitySchemes:
  BearerAuth:
    type: http
    scheme: bearer
    bearerFormat: JWT
```

全てのエンドポイント（ヘルスチェックを除く）で Cognito JWT 認証が必要です。

### 主要エンドポイント

#### Documents API

| メソッド | パス                           | 説明                 | タグ      |
| -------- | ------------------------------ | -------------------- | --------- |
| GET      | `/documents`                   | ドキュメント一覧取得 | Documents |
| POST     | `/documents/upload`            | アップロードURL発行  | Documents |
| GET      | `/documents/{id}`              | ドキュメント詳細取得 | Documents |
| GET      | `/documents/{id}/download-url` | ダウンロードURL取得  | Documents |
| DELETE   | `/documents/{id}`              | ドキュメント削除     | Documents |
| PATCH    | `/documents/{id}/tags`         | タグ更新             | Documents |

#### Chat API

| メソッド | パス                           | 説明               | タグ |
| -------- | ------------------------------ | ------------------ | ---- |
| POST     | `/chat/sessions`               | セッション作成     | Chat |
| GET      | `/chat/sessions`               | セッション一覧取得 | Chat |
| POST     | `/chat/sessions/{id}/messages` | メッセージ送信     | Chat |
| GET      | `/chat/sessions/{id}/messages` | 履歴取得           | Chat |
| PATCH    | `/chat/sessions/{id}`          | セッション更新     | Chat |
| DELETE   | `/chat/sessions/{id}`          | セッション削除     | Chat |
| POST     | `/chat/messages/{id}/feedback` | フィードバック     | Chat |

#### Health API

| メソッド | パス      | 説明           | タグ   |
| -------- | --------- | -------------- | ------ |
| GET      | `/health` | ヘルスチェック | Health |

### スキーマ定義

#### ErrorCode

```yaml
ErrorCode:
  type: string
  enum:
    - VALIDATION_FAILED
    - INVALID_PARAMETER
    - MISSING_PARAMETER
    - PERMISSION_DENIED
    - RESOURCE_NOT_FOUND
    - INTERNAL_SERVER_ERROR
    - DOCUMENTS_FILE_TOO_LARGE
    - DOCUMENTS_UNSUPPORTED_FILE_TYPE
    - DOCUMENTS_NOT_FOUND
    # ... その他のエラーコード
```

#### Document Status

```yaml
DocumentStatus:
  type: string
  enum:
    - PENDING_UPLOAD
    - PROCESSING
    - COMPLETED
    - FAILED
    - DELETING
    - DELETED
```

#### Feedback Type

```yaml
FeedbackType:
  type: string
  enum:
    - NONE
    - GOOD
    - BAD
```

## ドキュメント生成

OpenAPI 仕様は Zod スキーマから自動生成されます。

```bash
npm run doc:generate
```

### 生成プロセス

```
infrastructure/src/shared/schemas/*.ts (Zod スキーマ)
     ↓
@asteasolutions/zod-to-openapi
     ↓
infrastructure/scripts/generate-openapi.ts
     ↓
doc/openapi.yaml
```

## フロントエンドでの使用

### Orval による API クライアント生成

フロントエンドでは Orval を使用して、OpenAPI 仕様から React Query フックと Zod スキーマを自動生成しています。

```typescript
// orval.config.ts (フロントエンド)
export default defineConfig({
  myelin: {
    input: {
      target: "../myelinbase-backend/doc/openapi.yaml",
    },
    output: {
      mode: "tags-split",
      target: "src/lib/api/generated",
      client: "react-query",
    },
  },
  "myelin-zod": {
    input: {
      target: "../myelinbase-backend/doc/openapi.yaml",
    },
    output: {
      client: "zod",
      target: "src/lib/api/generated/zod",
    },
  },
});
```

### 生成コマンド（フロントエンド）

```bash
# フロントエンドリポジトリで実行
npx orval
```

### 生成されるファイル

```
frontend/src/lib/api/generated/
├── documents/           # Documents API フック
│   └── documents.ts
├── chat/               # Chat API フック
│   └── chat.ts
├── health/             # Health API フック
│   └── health.ts
├── model/              # TypeScript 型定義
│   ├── documentResponseDto.ts
│   ├── chatSessionDto.ts
│   └── ...
└── zod/                # Zod スキーマ
    ├── documents.zod.ts
    └── ...
```

## API ドキュメントの閲覧

### Swagger UI

ローカルで Swagger UI を起動して API ドキュメントを閲覧できます。

```bash
# Docker で起動
docker run -p 8080:8080 \
  -e SWAGGER_JSON=/openapi.yaml \
  -v $(pwd)/doc/openapi.yaml:/openapi.yaml \
  swaggerapi/swagger-ui

# ブラウザで開く
open http://localhost:8080
```

### Redoc

```bash
# npx で起動
npx @redocly/cli preview-docs doc/openapi.yaml

# ブラウザで開く
open http://localhost:8080
```

## 更新ワークフロー

1. **スキーマ変更**: `infrastructure/src/shared/schemas/*.ts` を編集
2. **ドキュメント生成**: `npm run doc:generate`
3. **確認**: Swagger UI 等で変更を確認
4. **フロントエンド更新**: フロントエンドで `npx orval` を実行

## バリデーション

OpenAPI 仕様の整合性を検証します。

```bash
# Spectral でリント
npx @stoplight/spectral-cli lint doc/openapi.yaml

# Redocly でバリデーション
npx @redocly/cli lint doc/openapi.yaml
```
