# **Documents Function (src/functions/documents)**

## **概要**

この Lambda 関数は、ドキュメント（PDF, テキスト等）の管理機能を提供する REST API のバックエンドです。ドキュメントのメタデータ管理（DynamoDB）と、実ファイル操作のための署名付き URL 発行（S3）を担当します。

## **責務**

| 責務                  | 説明                                                                                  |
| :-------------------- | :------------------------------------------------------------------------------------ |
| **ドキュメント CRUD** | ユーザーごとのドキュメント一覧取得、詳細取得、削除（論理削除）、タグ更新              |
| **アップロード支援**  | クライアントが S3 に直接アップロードするための署名付き URL 発行、メタデータの先行保存 |
| **重複検知**          | ファイルハッシュを用いた重複コンテンツのアップロード防止                              |
| **ダウンロード支援**  | セキュアなダウンロード用署名付き URL の発行                                           |
| **セキュリティ**      | Cognito 認証、ユーザーごとのデータ分離、入力バリデーション                            |

## **環境変数**

| 変数名               | 必須 | デフォルト | 説明                                  |
| :------------------- | :--- | :--------- | :------------------------------------ |
| TABLE_NAME           | ✅   | \-         | DynamoDB テーブル名                   |
| BUCKET_NAME          | ✅   | \-         | S3 バケット名                         |
| PRESIGNED_URL_EXPIRY | \-   | 900        | 署名付き URL の有効期限（秒）         |
| STAGE                | \-   | local      | 環境（local/dev/prod）                |
| ALLOWED_ORIGINS      | \-   | \-         | CORS 許可オリジン                     |
| DYNAMODB_ENDPOINT    | \-   | \-         | DynamoDB エンドポイント（ローカル用） |
| S3_ENDPOINT          | \-   | \-         | S3 エンドポイント（ローカル用）       |

## **API エンドポイント**

### **1\. アップロード URL 発行**

POST /documents/upload

S3 への直接アップロード用 URL を発行します。ファイルハッシュ（SHA-256等）を提供することで、重複コンテンツのチェックを行います。

**リクエスト**

{  
 "files": \[  
 {  
 "fileName": "sample.pdf",  
 "contentType": "application/pdf",  
 "fileSize": 102400,  
 "fileHash": "a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e"  
 }  
 \],  
 "tags": \["重要", "2024年度"\]  
}

**バリデーション**

| 項目             | 制限               |
| :--------------- | :----------------- |
| ファイルサイズ   | 最大 50MB          |
| ファイル名長     | 最大 255 文字      |
| 対応ファイル形式 | PDF, TXT, MD, DOCX |
| タグ数           | 最大 10 個         |
| タグ長           | 最大 50 文字       |

**レスポンス (202 Accepted)**

{  
 "results": \[  
 {  
 "status": "success",  
 "fileName": "sample.pdf",  
 "data": {  
 "documentId": "550e8400-e29b-41d4-a716-446655440000",  
 "uploadUrl": "\[https://s3.amazonaws.com/bucket/uploads/\](https://s3.amazonaws.com/bucket/uploads/)...",  
 "expiresIn": 900,  
 "s3Key": "uploads/user-001/550e8400.../sample.pdf"  
 }  
 }  
 \]  
}

**エラーレスポンス (個別ファイルの status が error の場合)**

| エラーコード                            | 説明                         |
| :-------------------------------------- | :--------------------------- |
| DOCUMENTS_FILE_TOO_LARGE                | ファイルサイズ超過           |
| DOCUMENTS_UNSUPPORTED_FILE_TYPE         | 非対応ファイル形式           |
| DOCUMENTS_INVALID_FILENAME_LENGTH_LIMIT | ファイル名が長すぎる         |
| DOCUMENTS_TAG_LENGTH_LIMIT              | タグが長すぎる               |
| DOCUMENTS_TAGS_TOO_MANY                 | タグ数超過                   |
| DOCUMENTS_DUPLICATE_CONTENT             | 同一内容のファイルが既に存在 |
| DOCUMENTS_UPLOAD_FAILED                 | アップロード処理失敗         |

### **2\. ドキュメント一覧取得**

GET /documents

認証ユーザーが所有するドキュメントの一覧を返します。削除済み（DELETED ステータス）のドキュメントは除外されます。

**レスポンス (200 OK)**

{  
 "documents": \[  
 {  
 "documentId": "550e8400-e29b-41d4-a716-446655440000",  
 "fileName": "sample.pdf",  
 "status": "COMPLETED",  
 "fileSize": 102400,  
 "contentType": "application/pdf",  
 "tags": \["重要"\],  
 "createdAt": "2024-01-01T00:00:00.000Z",  
 "updatedAt": "2024-01-01T00:05:00.000Z"  
 }  
 \]  
}

**ドキュメントステータス**

| ステータス     | 説明                                       |
| :------------- | :----------------------------------------- |
| PENDING_UPLOAD | アップロード待ち（メタデータのみ登録済み） |
| PROCESSING     | RAG パイプライン処理中                     |
| COMPLETED      | 処理完了（チャットで使用可能）             |
| FAILED         | 処理失敗                                   |
| DELETING       | 削除処理中                                 |

### **3\. ドキュメント詳細取得**

GET /documents/{documentId}

指定された ID のドキュメント詳細を返します。他ユーザーのドキュメントにはアクセスできません。

**レスポンス (200 OK)**

{  
 "document": {  
 "documentId": "550e8400-e29b-41d4-a716-446655440000",  
 "fileName": "sample.pdf",  
 "status": "COMPLETED",  
 "fileSize": 102400,  
 "contentType": "application/pdf",  
 "tags": \["重要"\],  
 "s3Key": "uploads/user-001/550e8400.../sample.pdf",  
 "createdAt": "2024-01-01T00:00:00.000Z",  
 "updatedAt": "2024-01-01T00:05:00.000Z"  
 }  
}

**エラーレスポンス**

| エラーコード        | HTTP | 説明                                                  |
| :------------------ | :--- | :---------------------------------------------------- |
| DOCUMENTS_NOT_FOUND | 404  | ドキュメントが存在しない                              |
| PERMISSION_DENIED   | 404  | 他ユーザーのドキュメント（セキュリティ上 404 を返す） |

### **4\. ダウンロード URL 取得**

GET /documents/{documentId}/download-url

指定されたドキュメントをダウンロードするための署名付き URL を取得します。

**前提条件**

- ドキュメントのステータスが COMPLETED であること
- リクエストユーザーがドキュメントの所有者であること

**レスポンス (200 OK)**

{  
 "downloadUrl": "\[https://s3.amazonaws.com/bucket/uploads/...?X-Amz-Signature=\](https://s3.amazonaws.com/bucket/uploads/...?X-Amz-Signature=)..."  
}

URL の有効期限は **1 時間** です。

**エラーレスポンス**

| エラーコード                     | HTTP | 説明                        |
| :------------------------------- | :--- | :-------------------------- |
| DOCUMENTS_NOT_FOUND              | 404  | ドキュメントが存在しない    |
| DOCUMENTS_NOT_READY_FOR_DOWNLOAD | 400  | ステータスが COMPLETED 以外 |

### **5\. ドキュメント削除**

DELETE /documents/{documentId}

ドキュメントを削除します。即座に物理削除は行わず、ステータスを DELETING に更新します。実際のクリーンアップ（S3 ファイル削除、Pinecone ベクトル削除）は DynamoDB Streams を通じて非同期で実行されます。

**レスポンス (202 Accepted)**

{  
 "document": {  
 "documentId": "550e8400-e29b-41d4-a716-446655440000",  
 "status": "DELETING"  
 }  
}

**削除フロー**

DELETE リクエスト  
 ↓  
ステータスを DELETING に更新  
 ↓  
DynamoDB Streams がイベント発火  
 ↓  
Stream Processor Lambda が起動  
 ↓  
S3 ファイル削除 \+ Pinecone ベクトル削除  
 ↓  
DynamoDB レコード物理削除

### **6\. タグ更新**

PATCH /documents/{documentId}/tags

ドキュメントのタグを更新します。

**リクエスト**

{  
 "tags": \["更新済み", "レビュー完了"\]  
}

**レスポンス (200 OK)**

{  
 "document": {  
 "documentId": "550e8400-e29b-41d4-a716-446655440000",  
 "tags": \["更新済み", "レビュー完了"\],  
 "updatedAt": "2024-01-02T10:30:00.000Z"  
 }  
}

## **認証・認可**

### **AWS 環境**

Cognito User Pool による JWT 認証を使用します。API Gateway の Authorizer が JWT を検証し、event.requestContext.authorizer.claims.sub から所有者 ID（ownerId）を取得します。

### **ローカル環境**

認証をバイパスし、固定の所有者 ID user-001 を使用します。

function extractOwnerId(event: APIGatewayProxyEvent): string {  
 if (IS_LOCAL_STAGE) {  
 return "user-001";  
 }  
 const claims \= event.requestContext?.authorizer?.claims;  
 const ownerId \= claims?.sub;  
 if (\!ownerId) throw new AppError(401, ErrorCode.PERMISSION_DENIED);  
 return ownerId;  
}

## **DynamoDB スキーマ**

### **Documents Table**

| 属性            | 型             | 説明                         |
| :-------------- | :------------- | :--------------------------- |
| documentId (PK) | String         | UUID v4                      |
| ownerId         | String         | Cognito User ID              |
| fileName        | String         | オリジナルファイル名         |
| fileHash        | String         | ファイルコンテンツのハッシュ |
| fileSize        | Number         | ファイルサイズ (bytes)       |
| contentType     | String         | MIME タイプ                  |
| status          | String         | ステータス                   |
| s3Key           | String         | S3 オブジェクトキー          |
| tags            | List\<String\> | タグ配列                     |
| createdAt       | String         | ISO 8601                     |
| updatedAt       | String         | ISO 8601                     |

### **GSI: OwnerIndex**

ユーザーごとのドキュメント一覧取得に使用。

- **パーティションキー**: ownerId
- **ソートキー**: createdAt (降順で最新順に取得)

### **GSI: FileNameIndex**

同名ファイルの重複アップロード検知に使用（同一ユーザー内でユニーク）。

- **パーティションキー**: ownerId
- **ソートキー**: fileName

### **GSI: FileHashIndex**

コンテンツハッシュによる重複ファイルの検知に使用。

- **パーティションキー**: ownerId
- **ソートキー**: fileHash

## **セキュリティ考慮事項**

### **アクセス制御**

- すべてのエンドポイントで ownerId によるアクセス制御を実施
- 他ユーザーのドキュメントへのアクセスは 404 Not Found を返す（情報漏洩防止）

### **入力バリデーション**

- Zod スキーマによる厳密なバリデーション
- ファイルサイズ、ファイル名長、タグ数の制限

### **署名付き URL**

- アップロード URL は 15 分で期限切れ
- ダウンロード URL は 1 時間で期限切れ
- S3 バケットへの直接アクセスは許可しない

## **テスト**

\# ユニットテスト実行  
cd infrastructure  
npm run test

\# 特定のテストファイル実行  
npm run test \-- src/functions/documents/index.test.ts

\# カバレッジレポート  
npm run test:coverage
