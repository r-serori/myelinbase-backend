# **Chat Function (src/functions/chat)**

## **概要**

このLambda関数は、RAG（Retrieval-Augmented Generation）アプリケーションの中核となるバックエンドロジックを提供します。  
ユーザーからの自然言語クエリを受け取り、ベクトルデータベース（Pinecone）を検索し、LLM（Bedrock/Claude）を用いて回答をストリーミング生成します。

## **責務 (Responsibilities)**

1. **RAG 推論 & ストリーミング**  
   * ユーザーのクエリをベクトル化し、Pineconeから関連ドキュメントを検索（Hybrid Search/Vector Search）。  
   * 検索結果（Context）とクエリを組み合わせてプロンプトを作成。  
   * Bedrock (Claude 3 Haiku) を呼び出し、回答をチャンク単位でリアルタイムにフロントエンドへ配信（Server-Sent Events）。  
2. **セッション & 履歴管理**  
   * チャットセッション（スレッド）の作成、一覧取得、名称変更、削除。  
   * チャットメッセージ履歴の保存と取得（DynamoDB）。  
   * マルチユーザー対応（Cognito sub をキーにしたデータ分離）。  
3. **フィードバック収集**  
   * AIの回答に対するユーザー評価（GOOD/BAD）とコメントの保存。

## **環境変数 (Environment Variables)**

| 変数名 | 必須 | デフォルト値 | 説明 |
| :---- | :---- | :---- | :---- |
| TABLE\_NAME | **Yes** | \- | チャット履歴を保存するDynamoDBテーブル名 |
| PINECONE\_INDEX\_NAME | No | documents | ベクトル検索を行うPineconeのインデックス名 |
| USE\_MOCK\_AUTH | No | false | trueの場合、Cognito検証をスキップしダミーユーザーとして動作（ローカル開発用） |
| USER\_POOL\_ID | Cond | \- | Cognito User Pool ID（本番認証時に必須） |
| CLIENT\_ID | Cond | \- | Cognito Client ID（本番認証時に必須） |
| MODEL\_ID | No | (Claude 3 Haiku) | 使用するBedrockのモデルID |
| AWS\_REGION | No | us-east-1 | AWSリージョン |

## **入出力インターフェース**

### **1\. チャットストリーミング (POST /chat/stream)**

**リクエスト:**

* Content-Type: application/json  
* Body:  
  {  
    "query": "このドキュメントの要約を教えて",  
    "sessionId": "optional-uuid-v4"  // 指定がない場合は新規セッション作成  
  }

**レスポンス (Server-Sent Events):** このエンドポイントは text/event-stream を返します。以下のイベントタイプが順次送信されます。

| イベントType | ペイロード例 | 説明 |
| :---- | :---- | :---- |
| citations | { "citations": \[{ "fileName": "...", "uri": "...", "text": "..." }\] } | 回答の根拠となったドキュメント情報。回答生成前に送信されます。 |
| text | { "text": "はい、" } | 回答テキストの断片（チャンク）。連続して送信されます。 |
| done | { "sessionId": "...", "historyId": "..." } | 生成完了通知。保存された履歴IDを含みます。 |
| error | { "errorCode": "INTERNAL\_SERVER\_ERROR", "message": "..." } | エラー発生時。 |

### **2\. フィードバック送信 (POST /chat/feedback)**

**リクエスト:**

{  
  "sessionId": "session-id",  
  "historyId": "message-history-id",  
  "evaluation": "GOOD" | "BAD",  
  "comment": "助かりました",  
  "reasons": \["わかりにくい", "間違っている"\] // BADの場合のみ  
}

### **3\. セッション管理 API**

| メソッド | パス | 説明 | クエリパラメータ |
| :---- | :---- | :---- | :---- |
| GET | /chat/sessions | セッション一覧取得 | \- |
| GET | /chat/sessions/{id} | メッセージ履歴取得 | limit (default: 30), cursor (ページネーション) |
| PATCH | /chat/sessions/{id} | セッション名変更 | Body: { "sessionName": "新しい名前" } |
| DELETE | /chat/sessions/{id} | セッション削除 | (論理削除) |

## **内部処理フロー (Chat Stream)**

1. **バリデーション**: リクエストボディをZodスキーマで検証。  
2. **認証**: Authorization ヘッダーのJWTを検証し、ユーザーID (ownerId) を特定。  
3. **Embedding**: ユーザーのクエリを amazon.titan-embed-text-v1 でベクトル化。  
4. **検索**: Pineconeに対し、ownerId フィルタ付きでベクトル検索を実行 (Top-K)。  
5. **プロンプト構築**: 検索されたドキュメントのテキストをContextとしてLLMプロンプトに埋め込み。  
6. **生成 (Streaming)**: Claude 3 Haiku を呼び出し、ストリームレスポンスをクライアントへパイプ。  
7. **保存**: 完了後、DynamoDBに「クエリ」「回答」「引用元」「メタデータ」をアトミックに保存。

## **エラーハンドリング**

* **401 Unauthorized**: トークンが無効、または期限切れ。  
* **400 Bad Request**: 必須パラメータ不足、またはバリデーションエラー。  
* **500 Internal Server Error**: Bedrock/Pinecone/DynamoDB への接続エラーなど。