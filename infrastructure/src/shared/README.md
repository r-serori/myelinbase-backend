# **Shared Layer (src/shared)**

## **概要**

src/shared ディレクトリは、全てのLambda関数で共有されるビジネスロジック、型定義、ユーティリティ、外部サービスクライアントを集約した内部ライブラリです。  
各Lambda関数は、このディレクトリをインポートして利用することで、実装の重複を防ぎ、一貫した挙動（エラーハンドリング、ログ出力、型定義）を保証します。

## **ディレクトリ構成**

src/shared/  
├── clients/ \# 外部サービス（AWS, SaaS）への接続クライアント  
├── schemas/ \# Zodスキーマ（バリデーション & OpenAPI定義）  
├── types/ \# TypeScript型定義（Zodから自動生成）  
└── utils/ \# 汎用ユーティリティ（APIハンドラ、DB操作など）

## **1\. Schemas & Types (schemas/, types/)**

**「Single Source of Truth (信頼できる唯一の情報源)」** の原則に基づき、Zodスキーマを中心に設計されています。

- **Zodスキーマ (schemas/\*.ts)**:
  - ランタイムバリデーション（入力チェック）と、OpenAPIドキュメント生成の両方に使用されます。
  - @asteasolutions/zod-to-openapi を使用して拡張されています。
- **TypeScript型 (types/\*.ts)**:
  - z.infer\<typeof Schema\> を使用して、Zodスキーマから静的な型定義を自動生成しています。
  - これにより、「ドキュメント」と「実装（型）」と「バリデーション」の3つが常に同期します。

## **2\. API Handler (utils/api-handler.ts)**

全てのLambda関数（API Gatewayトリガー）は、このラッパー関数を通して実装されます。

### **機能**

- **統一されたエラーハンドリング**: AppError や ZodError をキャッチし、適切なHTTPステータスコードとエラーレスポンス（JSON）に変換します。
- **構造化ログ**: リクエスト情報（パス、メソッド、RequestId）を含むJSONログを自動出力します。
- **CORSヘッダー付与**: 環境変数 ALLOWED_ORIGINS に基づき、適切なCORSヘッダーをレスポンスに注入します。
- **ストリーミング対応**: streamApiHandler は、Lambda Response Streaming (AWS) と ローカル開発用のポリフィル（チャンク送信模倣）を透過的に切り替えます。

**使用例:**

export const handler \= apiHandler(async (event) \=\> {  
 // 正常系ロジックのみ記述すればよい  
 // エラーを投げれば自動的にハンドリングされる  
 throw new AppError(404, ErrorCode.NOT_FOUND);  
});

## **3\. Clients (clients/)**

外部サービスへの接続ロジックを隠蔽し、環境（ローカル/AWS）に応じた初期化を行います。

- **bedrock.ts**:
  - generateEmbeddings: Titan Embeddings を使用したベクトル化（バッチ処理対応）。
  - invokeClaudeStream: Claude 3 Haiku を使用したストリーミング推論。
- **pinecone.ts**:
  - Secrets Manager からの APIキー取得（キャッシュ付き）。
  - Pinecone SDK のラッパー（Upsert, Query, Delete）。

## **4\. Utilities (utils/)**

- **dynamodb.ts**:
  - ローカル開発時は localhost:8000、本番はAWSエンドポイントに向くようにクライアントを初期化。
  - ページネーション用カーソル（LastEvaluatedKey）のBase64エンコード/デコード。
- **s3.ts**:
  - 署名付きURL（Presigned URL）の発行。
  - LocalStack環境への対応（forcePathStyle: true）。
- **text-processing.ts**:
  - pdf-parse を用いたPDFからのテキスト抽出。
  - LangChain等を使わない、軽量なテキストチャンク分割ロジック（Overlapping Window）。

## **開発ガイドライン**

1. **ロジックはここに置く**: Lambda関数（functions/\*）は薄く保ち、主要なロジックは shared に寄せる。
2. **環境依存の排除**: process.env.STAGE \=== 'local' の分岐は、可能な限り clients や utils の初期化部分に閉じ込める。
3. **循環参照の回避**: utils 同士の依存などに注意する。
