# **Documents Function (src/functions/documents)**

## **概要**

このLambda関数は、ドキュメント（PDF, テキスト等）の管理機能を提供するREST APIのバックエンドです。  
ドキュメントのメタデータ管理（DynamoDB）と、実ファイル操作のための署名付きURL発行（S3）を担当します。

## **責務 (Responsibilities)**

1. **ドキュメント管理 (CRUD)**  
   * ユーザーごとのドキュメント一覧取得。  
   * ドキュメント詳細情報の取得。  
   * ドキュメントの削除（論理削除フラグの更新）。  
   * タグ情報の更新。  
2. **ファイルアップロード支援**  
   * クライアントがS3に直接ファイルをアップロードするための「署名付きURL (Presigned URL)」の発行。  
   * アップロード予定のメタデータをDynamoDBに先行保存（ステータス: PENDING\_UPLOAD）。  
3. **セキュリティ**  
   * Cognitoによる認証（Authorization ヘッダーの検証）。  
   * ユーザーごとのデータ分離（ownerId によるアクセス制御）。  
   * ファイル名、サイズ、拡張子のバリデーション。

## **環境変数 (Environment Variables)**

| 変数名 | 必須 | デフォルト値 | 説明 |
| :---- | :---- | :---- | :---- |
| TABLE\_NAME | **Yes** | \- | ドキュメントメタデータを保存するDynamoDBテーブル名 |
| BUCKET\_NAME | **Yes** | \- | 実ファイルを保存するS3バケット名 |
| PRESIGNED\_URL\_EXPIRY | No | 900 | 署名付きURLの有効期限（秒）。デフォルト15分。 |
| USE\_MOCK\_AUTH | No | false | trueの場合、Cognito検証をスキップしダミーユーザーとして動作（ローカル開発用） |

## **入出力インターフェース**

### **1\. アップロードリクエスト (POST /documents/upload-request)**

S3へのアップロード用URLを発行します。クライアントはこのURLに対してファイルをPUTします。

**リクエスト:**

* Content-Type: application/json

```json
{  
  "files": [  
    {  
      "fileName": "sample.pdf",  
      "contentType": "application/pdf",  
      "fileSize": 102400  
    }  
  ],  
  "tags": ["重要", "2024年度"]  
}
```

**レスポンス (202 Accepted):**

```json
{  
  "results": [  
    {  
      "status": "success",  
      "fileName": "sample.pdf",  
      "data": {  
        "documentId": "uuid-v4",  
        "uploadUrl": "[https://s3.amazonaws.com/](https://s3.amazonaws.com/)...", // このURLにPUTする  
        "expiresIn": 900,  
        "s3Key": "uploads/user-id/uuid/sample.pdf"  
      }  
    }  
  ]  
}
```

### **2\. ドキュメント一覧取得 (GET /documents)**

認証ユーザーが所有するドキュメントの一覧を返します。

**レスポンス (200 OK):**

```json
{  
  "documents": [  
    {  
      "documentId": "doc-1",  
      "fileName": "sample.pdf",  
      "status": "COMPLETED", // PENDING\_UPLOAD, PROCESSING, COMPLETED, FAILED  
      "fileSize": 102400,  
      "tags": ["重要"],  
      "createdAt": "2024-01-01T00:00:00Z",  
      "updatedAt": "2024-01-01T00:05:00Z"  
    }  
  ]  
}
```

### **3\. ドキュメント詳細取得 (GET /documents/{id})**

指定されたIDのドキュメント詳細を返します。他人のドキュメントにはアクセスできません。

**レスポンス (200 OK):**

```json
{  
  "document": {  
    "documentId": "doc-1",  
    // ... (一覧取得時と同じフィールド)  
    "s3Path": "s3://bucket/uploads/..."  
  }  
}
```

### **4. ダウンロードURL取得 (GET /documents/{id}/download-url)**

指定されたIDのドキュメントをダウンロードするための署名付きURLを取得します。
URLの有効期限は1時間です。

**レスポンス (200 OK):**

```json
{
  "downloadUrl": "https://s3.amazonaws.com/..."
}
```

### **5\. ドキュメント削除 (DELETE /documents/{id})**

ドキュメントを削除します。実際には物理削除ではなく、ステータスを DELETING に更新し、非同期プロセス（DynamoDB Streams）によってクリーンアップされます。

**レスポンス (202 Accepted):**

```json
{  
  "document": {  
    "documentId": "doc-1",  
    "status": "DELETING",  
    "deleteRequested": true  
  }  
}
```

### **6\. タグ更新 (PATCH /documents/{id}/tags)**

ドキュメントのタグを更新（上書き）します。

**リクエスト:**

```json
{  
  "tags": ["新しいタグ", "更新済み"]  
}
```

**レスポンス (200 OK):**

```json
{  
  "document": {  
    // ... 更新後のドキュメント情報  
    "tags": ["新しいタグ", "更新済み"]  
  }  
}
```

### **7. ドキュメント一括削除 (POST /documents/batch-delete)**

指定された複数のドキュメントを一括で削除（論理削除）します。

**リクエスト:**

* Content-Type: application/json

```json
{
  "documentIds": ["doc-1", "doc-2"]
}
```

**レスポンス (200 OK):**

```json
{
  "results": [
    {
      "documentId": "doc-1",
      "status": "success"
    },
    {
      "documentId": "doc-2",
      "status": "error",
      "errorCode": "INTERNAL_SERVER_ERROR" // エラー時のみ
    }
  ]
}
```

## **内部処理フロー (Upload Request)**

1. **バリデーション**: ファイル名、サイズ、拡張子（PDF, TXT, MD, CSVのみ許可）をチェック。  
2. **重複チェック**: 同名ファイルが存在する場合、古いものを削除フラグ付きでマーク。  
3. **ID生成**: uuid を生成し、S3キー (uploads/{userId}/{docId}/{fileName}) を決定。  
4. **DB保存**: ステータス PENDING\_UPLOAD でDynamoDBにメタデータを保存。  
5. **署名**: AWS SDKを用いてS3 PutObject 用の署名付きURLを生成。  
6. **返却**: クライアントにURLとメタデータを返却。

## **エラーハンドリング**

* **400 Bad Request**: パラメータ不足、不正なファイル形式、サイズ超過など。  
* **401 Unauthorized**: 認証トークンが無効。  
* **404 Not Found**: 指定されたIDのドキュメントが存在しない、またはアクセス権がない。  
* **500 Internal Server Error**: DynamoDB/S3への接続エラーなど。
