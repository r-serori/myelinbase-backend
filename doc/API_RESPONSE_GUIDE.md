# **API Response & Error Handling Guide**

このドキュメントは、フロントエンドアプリケーションにおけるAPIレスポンスのハンドリング仕様、特にエラーコードのマッピングとストリーミングレスポンスの構造について記述しています。

## **1\. 共通レスポンス形式**

### **1.1 成功時 (Standard REST API)**

HTTPステータスコード 200 (OK) または 202 (Accepted) が返却されます。  
レスポンスボディはエンドポイントごとのJSONスキーマに従います。

### **1.2 エラー時 (Standard REST API)**

HTTPステータスコード 4xx または 5xx が返却されます。  
レスポンスボディは以下のJSON形式で統一されています。  
{  
 "errorCode": "INVALID_PARAMETER"  
}

**Note:** 標準APIのエラーレスポンスには message フィールドが含まれない場合があります。UIへのメッセージ表示は、後述の **ErrorCode マッピング表** に基づいてフロントエンド側で生成することを推奨します。

## **2\. ErrorCode マッピング表**

フロントエンドでのメッセージ表示やハンドリングの参考にしてください。

### **汎用エラー (400/500系)**

| ErrorCode             | HTTP Status | 内容                    | UIメッセージ例 / 対応                                                           |
| :-------------------- | :---------- | :---------------------- | :------------------------------------------------------------------------------ |
| VALIDATION_FAILED     | 400         | 入力バリデーション失敗  | "入力内容を確認してください。"                                                  |
| INVALID_PARAMETER     | 400         | パラメータ不正          | "不正なリクエストです。"                                                        |
| MISSING_PARAMETER     | 400         | 必須パラメータ欠落      | "必要な情報が不足しています。"                                                  |
| PERMISSION_DENIED     | 401/403     | 権限不足 / トークン無効 | (ログイン画面へリダイレクト) "セッションが切れました。再ログインしてください。" |
| INTERNAL_SERVER_ERROR | 500         | サーバー内部エラー      | "システムエラーが発生しました。しばらくしてから再度お試しください。"            |
| RESOURCE_NOT_FOUND    | 404         | リソース不在            | "データが見つかりませんでした。"                                                |
| STATE_CONFLICT        | 409         | 状態不整合 (処理中など) | "現在処理中のため操作できません。"                                              |

### **ドキュメント関連エラー**

| ErrorCode                        | HTTP Status | 内容               | UIメッセージ例 / 対応                                          |
| :------------------------------- | :---------- | :----------------- | :------------------------------------------------------------- |
| DOCUMENTS_FILE_TOO_LARGE         | 400         | ファイルサイズ超過 | "ファイルサイズが大きすぎます (上限50MB)。"                    |
| DOCUMENTS_UNSUPPORTED_FILE_TYPE  | 400         | 非対応ファイル形式 | "PDF, Text, Markdown, CSV形式のみアップロード可能です。"       |
| DOCUMENTS_TAGS_TOO_MANY          | 400         | タグ数超過         | "タグは20個まで設定可能です。"                                 |
| DOCUMENTS_UPLOAD_FAILED          | 500         | S3アップロード失敗 | "ファイルのアップロードに失敗しました。"                       |
| DOCUMENTS_NOT_READY_FOR_DOWNLOAD | 400         | 処理未完了         | "ファイルの準備ができていません。処理完了までお待ちください。" |

### **チャット関連エラー**

| ErrorCode               | HTTP Status | 内容             | UIメッセージ例 / 対応                                          |
| :---------------------- | :---------- | :--------------- | :------------------------------------------------------------- |
| CHAT_QUERY_EMPTY        | 400         | 質問が空         | "質問内容を入力してください。"                                 |
| CHAT_QUERY_TOO_LONG     | 400         | 質問が長すぎる   | "質問が長すぎます。短くまとめてください。"                     |
| CHAT_SESSION_NAME_EMPTY | 400         | セッション名が空 | "セッション名を入力してください。"                             |
| CHAT_BEDROCK_ERROR      | 500         | AIサービスエラー | "AIの応答生成に失敗しました。時間をおいて再試行してください。" |

## **3\. ストリーミング API (SSE) 仕様**

エンドポイント: POST /chat/stream

Server-Sent Events (SSE) 形式でレスポンスが返却されます。イベントタイプ (type) に応じて処理を分岐してください。

### **イベント構造**

// 型定義イメージ  
type ChatStreamEvent \=  
 | { type: "citations", citations: SourceDocument\[\] }  
 | { type: "text", text: string }  
 | { type: "done", sessionId: string, historyId: string, aiResponse: string, citations: SourceDocument\[\] }  
 | { type: "error", errorCode: string, message: string };

### **イベント詳細**

#### **1\. citations (引用ソース)**

回答生成に使用されたドキュメント情報が最初に送られます。

data: {  
 "type": "citations",  
 "citations": \[  
 {  
 "fileName": "report.pdf",  
 "uri": "s3://bucket/key",  
 "text": "引用箇所の抜粋テキスト...",  
 "score": 0.85  
 }  
 \]  
}

#### **2\. text (回答テキスト)**

AIの回答がトークン単位（チャンク）で送られます。これを結合して表示してください。

data: {  
 "type": "text",  
 "text": "はい、"  
}

data: {  
 "type": "text",  
 "text": "その通り"  
}

#### **3\. done (完了)**

回答生成が完了したタイミングで送られます。最終的な回答全文とセッションIDが含まれます。

data: {  
 "type": "done",  
 "sessionId": "session-123",  
 "historyId": "msg-456",  
 "aiResponse": "はい、その通りです。",  
 "citations": \[...\]  
}

#### **4\. error (ストリーム中のエラー)**

ストリーミング中にエラーが発生した場合に送られます。このイベントを受信したらストリームをクローズしてください。

data: {  
 "type": "error",  
 "errorCode": "INTERNAL_SERVER_ERROR",  
 "message": "An unexpected error occurred."  
}

## **4\. 主なAPIエンドポイント一覧**

### **Chat**

- POST /chat/stream: チャット送信 (SSE)
- GET /chat/sessions: セッション履歴一覧取得
- GET /chat/sessions/{id}/messages: メッセージ履歴取得
- POST /chat/feedback: 回答へのフィードバック送信

### **Documents**

- GET /documents: ドキュメント一覧取得
- POST /documents/upload: アップロード用URL発行
- PATCH /documents/{id}/tags: タグ更新
- DELETE /documents/{id}: ドキュメント削除
