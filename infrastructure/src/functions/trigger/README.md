# **Ingestion Trigger Function (src/functions/trigger)**

## **概要**

このLambda関数は、S3イベント通知（s3:ObjectCreated:\*）をトリガーとして起動し、RAGのデータ取り込み（Ingestion）パイプラインであるAWS Step Functionsを実行します。  
ユーザーがドキュメントをアップロードした直後に、非同期処理を開始させるためのエントリポイントです。

## **責務 (Responsibilities)**

1. **S3イベントのハンドリング**  
   * S3から送られてくるイベントオブジェクトをパース。  
   * URLエンコードされたオブジェクトキーのデコード（+ をスペースに置換など）。  
2. **メタデータ抽出**  
   * S3キーのパスパターンから documentId を抽出。  
   * パス形式: uploads/{ownerId}/{documentId}/{fileName}  
3. **Step Functionsの起動**  
   * 抽出した情報を入力として、定義されたステートマシン（STATE\_MACHINE\_ARN）を実行 (StartExecution)。  
   * 実行名（Name）に ingest-{documentId}-{timestamp} を付与し、追跡可能にする。

## **環境変数 (Environment Variables)**

| 変数名 | 必須 | デフォルト値 | 説明 |
| :---- | :---- | :---- | :---- |
| STATE\_MACHINE\_ARN | **Yes** | \- | 実行するStep FunctionsステートマシンのARN |

## **入出力インターフェース**

### **トリガーイベント (S3 Event Notification)**

S3バケットにファイルが作成された際にAWSから自動的にinvokeされます。

**入力ペイロード例 (S3 Event):**

{  
  "Records": \[  
    {  
      "s3": {  
        "bucket": {  
          "name": "myelinbase-dev-docs-123456789012"  
        },  
        "object": {  
          "key": "uploads/user-001/doc-uuid-v4/sample.pdf",  
          "size": 1024,  
          "eTag": "..."  
        }  
      }  
    }  
  \]  
}

### **Step Functions への入力 (StartExecution Input)**

このLambdaがStep Functionsに渡すJSONペイロードです。

{  
  "bucket": "myelinbase-dev-docs-123456789012",  
  "key": "uploads/user-001/doc-uuid-v4/sample.pdf",  
  "documentId": "doc-uuid-v4"  
}

## **内部処理フロー**

1. **イベントループ**: S3イベントは複数のレコードを含む可能性があるため、Records 配列をループ処理（Promise.all）。  
2. **キーのデコード**: S3キーはURLエンコードされているため、decodeURIComponent で元の文字列に戻す。特にスペースが \+ になっている点に注意。  
3. **ID抽出**: 正規表現 uploads/\[^/\]+/(\[^/\]+)/ を使用して、パスから documentId を抽出。抽出できない場合は警告ログを出してスキップ（DLQ等には送らない設計）。  
4. **実行開始**: SFNClient.send(new StartExecutionCommand(...)) を呼び出し。  
5. **エラーハンドリング**: 実行開始に失敗した場合はエラーログを出力し、例外をスローしてLambdaを失敗させる（S3イベントの再試行メカニズムを利用するため）。

## **エラーハンドリングとリトライ**

* **Lambdaレベル**: この関数がエラー終了した場合、S3イベント通知の仕様により自動的にリトライが行われます（非同期呼び出しのデフォルト設定）。  
* **ログ**: 失敗した場合は CloudWatch Logs に Failed to start execution for {documentId} というエラーが出力されます。

## **関連リソース**

* **Trigger元**: DocumentsBucket (S3)  
* **起動先**: RagIngestionStateMachine (Step Functions)