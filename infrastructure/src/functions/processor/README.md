# **Doc Processor Function (src/functions/processor)**

## **概要**

このLambda関数は、RAG ETLパイプライン（Step Functions）内の各タスクを実行するワーカー関数です。  
「単一のLambda関数で複数の処理を切り替えて実行する」パターン（Lambda Monolith for Workers）を採用しており、action パラメータによって挙動が変わります。

## **責務 (Responsibilities)**

この関数は以下の3つの主要なアクションを提供します：

1. **ステータス更新 (updateStatus)**  
   * DynamoDB上のドキュメントステータスを更新します（例: PROCESSING, COMPLETED, FAILED）。  
   * エラー発生時にはエラーメッセージを記録します。  
   * 完了時には processingStatus を削除し、Sparse Indexを最適化します。  
2. **テキスト抽出 & チャンク分割 (extractAndChunk)**  
   * S3からファイル（PDF, テキスト等）をダウンロードします。  
   * ファイルタイプに応じたテキスト抽出を行います（PDFの場合は pdf-parse を使用）。  
   * 抽出したテキストを、検索に適したサイズ（例: 1000文字）に分割（チャンク化）します。  
3. **Embedding & ベクトル保存 (embedAndUpsert)**  
   * 分割されたテキストチャンクを、Bedrock (Titan Embeddings) を使用してベクトル化します。  
   * 生成されたベクトルとメタデータを、Pineconeに保存（Upsert）します。

## **環境変数 (Environment Variables)**

| 変数名 | 必須 | デフォルト値 | 説明 |
| :---- | :---- | :---- | :---- |
| TABLE\_NAME | **Yes** | \- | ドキュメントメタデータを保存するDynamoDBテーブル名 |
| BUCKET\_NAME | **Yes** | \- | 実ファイルを保存するS3バケット名 |
| PINECONE\_INDEX\_NAME | No | documents | ベクトルデータを保存するPineconeインデックス名 |
| PINECONE\_SECRET\_NAME | No | pinecone-api-key | Secrets Managerのシークレット名 |
| AWS\_REGION | No | us-east-1 | AWSリージョン |

## **入出力インターフェース**

このLambdaは、Step Functionsから渡される **ProcessorEvent** オブジェクトを入力として受け取ります。

### **共通入力構造**

interface ProcessorEvent {  
  action: "updateStatus" | "extractAndChunk" | "embedAndUpsert";  
  status?: string;           // updateStatus用  
  error?: { message: string }; // updateStatus (エラー時)用  
  payload: {                 // 前のステートからの出力  
    documentId: string;  
    bucket?: string;  
    key?: string;  
    chunks?: string\[\];  
    // ...その他  
  };  
}

### **アクション別の仕様**

#### **1\. updateStatus**

処理の開始・終了・失敗時に、DB上の状態を更新します。

**入力例:**

{  
  "action": "updateStatus",  
  "status": "PROCESSING",  
  "payload": { "documentId": "doc-1" }  
}

**出力例:**

{  
  "documentId": "doc-1",  
  "status": "PROCESSING"  
}

#### **2\. extractAndChunk**

S3からファイルを読み込み、テキスト処理を行います。

**入力例:**

{  
  "action": "extractAndChunk",  
  "payload": {  
    "documentId": "doc-1",  
    "bucket": "my-bucket",  
    "key": "uploads/user-1/doc-1/file.pdf"  
  }  
}

出力例:  
次段の embedAndUpsert に渡すため、テキストとチャンクを含んだ大きなペイロードを返します。  
{  
  "documentId": "doc-1",  
  "bucket": "my-bucket",  
  "key": "...",  
  "fileName": "file.pdf",  
  "contentType": "application/pdf",  
  "text": "抽出された全文...",  
  "chunks": \["チャンク1...", "チャンク2..."\]  
}

#### **3\. embedAndUpsert**

テキストをベクトル化し、DBに登録します。

**入力例:**

{  
  "action": "embedAndUpsert",  
  "payload": {  
    "documentId": "doc-1",  
    "chunks": \["チャンク1...", "チャンク2..."\]  
  }  
}

**出力例:**

{  
  "documentId": "doc-1",  
  "vectorCount": 15  
}

## **内部処理フロー**

1. **イベント解析**: event.action を見て、実行すべきハンドラ関数 (handleUpdateStatus 等) に振り分けます。  
2. **検証**: 各アクションに必要なパラメータ (documentId 等) が存在するかチェックします。  
3. **実行**:  
   * **DynamoDB操作**: lib-dynamodb の UpdateCommand / GetCommand を使用。  
   * **S3操作**: client-s3 の GetObjectCommand を使用し、ストリームをバッファに変換して処理。  
   * **Bedrock**: invokeModel で amazon.titan-embed-text-v1 を呼び出し。  
   * **Pinecone**: 公式SDKを使用してUpsert。APIキーはSecrets Managerから取得（キャッシュあり）。

## **エラーハンドリング**

* **Lambdaレベル**: エラーが発生した場合、そのまま例外をスローします。  
* **Step Functionsレベル**:  
  * extractAndChunk や embedAndUpsert でエラーが発生した場合、Catch ブロックにより HandleFailure ステートに遷移します。  
  * HandleFailure では、このLambdaを action: "updateStatus", status: "FAILED" で呼び出し、DBにエラー情報を記録します。  
  * Bedrockのスロットリング等に対しては、Step Functions側で Retry が設定されています。