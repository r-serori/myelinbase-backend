// src/functions/chat/index.ts
import {
  PutCommand,
  QueryCommand,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import {
  createDynamoDBClient,
  decodeCursor,
  encodeCursor,
} from "../../shared/utils/dynamodb";
import { randomUUID } from "crypto";
import { ErrorCode } from "../../shared/types/error-code";
import {
  streamApiHandler,
  AppError,
  StreamHelper,
  logger,
  validateJson,
} from "../../shared/utils/api-handler";
import {
  generateEmbeddings,
  invokeClaudeStream,
} from "../../shared/clients/bedrock";
import {
  createPineconeClient,
  getPineconeApiKey,
  searchVectorsByOwner,
} from "../../shared/clients/pinecone";
import { VectorSearchResult } from "../../shared/types/pinecone";
import {
  ChatStreamRequest,
  ChatStreamRequestSchema,
  SubmitFeedbackRequest,
  SubmitFeedbackRequestSchema,
  UpdateSessionNameRequestSchema,
  GetSessionMessagesQueryParams,
  GetSessionsResponse,
  GetSessionMessagesResponse,
  UpdateSessionNameResponse,
  DeleteSessionResponse,
  SubmitFeedbackResponse,
  SessionSummary,
  MessageSummary,
  ChatMessage,
  ChatSession,
  SourceDocument,
} from "../../shared/types/chat";
import { APIGatewayProxyEvent } from "aws-lambda";

const TABLE_NAME = process.env.TABLE_NAME!;
const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME || "documents";
const USE_MOCK_AUTH = process.env.USE_MOCK_AUTH === "true";
const USE_MOCK_BEDROCK = process.env.USE_MOCK_BEDROCK === "true";
const USER_POOL_ID = process.env.USER_POOL_ID!;
const CLIENT_ID = process.env.CLIENT_ID!;

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

const docClient = createDynamoDBClient();

const verifier =
  !USE_MOCK_AUTH && USER_POOL_ID && CLIENT_ID
    ? CognitoJwtVerifier.create({
        userPoolId: USER_POOL_ID,
        tokenUse: "id",
        clientId: CLIENT_ID,
      })
    : null;

export const handler = streamApiHandler(async (event, streamHelper) => {
  const { httpMethod, path, queryStringParameters } = event;

  const ownerId = await extractOwnerId(event);
  if (httpMethod === "POST" && path === "/chat/stream") {
    const body = validateJson(event.body, ChatStreamRequestSchema);
    await chatStream(body, streamHelper, ownerId);
    return;
  }

  if (httpMethod === "POST" && path === "/chat/feedback") {
    const body = validateJson(event.body, SubmitFeedbackRequestSchema);
    await submitFeedback(body, streamHelper, ownerId);
    return;
  }

  if (httpMethod === "GET" && path === "/chat/sessions") {
    await getSessions(streamHelper, ownerId);
    return;
  }

  if (path.startsWith("/chat/sessions/")) {
    const parts = path.split("/");
    const sessionId = parts[3];

    if (!sessionId) {
      throw new AppError(400, ErrorCode.MISSING_PARAMETER);
    }

    if (httpMethod === "GET") {
      await getSessionMessages(
        streamHelper,
        sessionId,
        ownerId,
        (queryStringParameters || {}) as GetSessionMessagesQueryParams
      );
      return;
    }

    if (httpMethod === "PATCH") {
      const body = validateJson(event.body, UpdateSessionNameRequestSchema);
      await updateSessionName(
        streamHelper,
        sessionId,
        ownerId,
        body.sessionName
      );
      return;
    }

    if (httpMethod === "DELETE") {
      await deleteSession(streamHelper, sessionId, ownerId);
      return;
    }
  }
  throw new AppError(404);
});

/**
 * ユーザーID抽出
 */
async function extractOwnerId(event: APIGatewayProxyEvent): Promise<string> {
  if (process.env.USE_MOCK_AUTH === "true") {
    return "user-001";
  }

  const authHeader =
    event.headers?.Authorization || event.headers?.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AppError(401, ErrorCode.PERMISSION_DENIED);
  }

  const token = authHeader.split(" ")[1];

  try {
    const payload = await verifier?.verify(token);
    if (!payload) {
      throw new AppError(401, ErrorCode.PERMISSION_DENIED);
    }
    return payload.sub;
  } catch (error) {
    throw new AppError(401, ErrorCode.PERMISSION_DENIED);
  }
}

// =================================================================
// ビジネスロジック
// =================================================================

/**
 * セッション名更新 PATCH /chat/sessions/{sessionId}
 */
async function updateSessionName(
  streamHelper: StreamHelper,
  sessionId: string,
  ownerId: string,
  sessionName: string
): Promise<void> {
  const command = new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `SESSION#${sessionId}`,
      sk: "META",
    },
    ConditionExpression:
      "ownerId = :ownerId AND attribute_not_exists(deletedAt)",
    UpdateExpression: "SET sessionName = :name, updatedAt = :now",
    ExpressionAttributeValues: {
      ":ownerId": ownerId,
      ":name": sessionName.trim(),
      ":now": new Date().toISOString(),
    },
    ReturnValues: "ALL_NEW",
  });

  const response = await docClient.send(command);
  const session = response.Attributes as ChatSession;

  const responseData: UpdateSessionNameResponse = {
    status: "success",
    session,
  };

  const responseStream = streamHelper.init(200, "application/json");
  responseStream.write(JSON.stringify(responseData));
  responseStream.end();
}

/**
 * セッション削除（論理削除） DELETE /chat/sessions/{sessionId}
 */
async function deleteSession(
  streamHelper: StreamHelper,
  sessionId: string,
  ownerId: string
): Promise<void> {
  // 90日後のUnix Timestamp (秒)
  const ttl = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
  const command = new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `SESSION#${sessionId}`,
      sk: "META",
    },
    ConditionExpression: "ownerId = :ownerId",
    UpdateExpression: "SET deletedAt = :now, ttl = :ttl REMOVE gsi1pk, gsi1sk",
    ExpressionAttributeValues: {
      ":ownerId": ownerId,
      ":now": new Date().toISOString(),
      ":ttl": ttl,
    },
    ReturnValues: "ALL_NEW",
  });

  await docClient.send(command);

  const responseData: DeleteSessionResponse = {
    status: "success",
  };

  const responseStream = streamHelper.init(200, "application/json");
  responseStream.write(JSON.stringify(responseData));
  responseStream.end();
}

/**
 * チャットストリーミング POST /chat/stream
 */
async function chatStream(
  body: ChatStreamRequest,
  streamHelper: StreamHelper,
  ownerId: string
): Promise<void> {
  const { query, sessionId, redoHistoryId } = body;

  const responseStream = streamHelper.init(200, "text/event-stream");

  try {
    const createdAt = new Date().toISOString();

    if (USE_MOCK_BEDROCK) {
      await sendMockStream(
        responseStream,
        query,
        sessionId,
        ownerId,
        createdAt,
        redoHistoryId
      );
    } else {
      await sendBedrockStream(
        responseStream,
        query,
        sessionId,
        ownerId,
        createdAt,
        redoHistoryId
      );
    }
    responseStream.end();
  } catch (error: any) {
    logger("ERROR", "Failed to process chat stream", {
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
      ownerId,
      sessionId,
    });

    const errorCode =
      error instanceof AppError
        ? error.errorCode
        : ErrorCode.INTERNAL_SERVER_ERROR;

    responseStream.write(
      `data: ${JSON.stringify({
        type: "error",
        errorCode: errorCode,
        message: error.message,
      })}\n\n`
    );
    responseStream.end();
  }
}

/**
 * フィードバック送信 POST /chat/feedback
 */
async function submitFeedback(
  body: SubmitFeedbackRequest,
  streamHelper: StreamHelper,
  ownerId: string
): Promise<void> {
  const { sessionId, historyId, createdAt, evaluation, comment, reasons } =
    body;

  if (evaluation === "BAD" && (!reasons || reasons.length === 0)) {
    throw new AppError(400, ErrorCode.CHAT_FEEDBACK_REASONS_EMPTY);
  }

  const command = new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `SESSION#${sessionId}`,
      sk: `MSG#${createdAt}`,
    },
    ConditionExpression: "ownerId = :ownerId AND historyId = :historyId",
    UpdateExpression:
      "SET feedback = :evaluation, feedbackComment = :comment, feedbackReasons = :reasons, feedbackUpdatedAt = :now",
    ExpressionAttributeValues: {
      ":ownerId": ownerId,
      ":historyId": historyId,
      ":evaluation": evaluation,
      ":comment": comment || null,
      ":reasons": reasons || null,
      ":now": new Date().toISOString(),
    },
    ReturnValues: "ALL_NEW",
  });

  const response = await docClient.send(command);
  const item = response.Attributes as ChatMessage;

  const responseData: SubmitFeedbackResponse = {
    status: "success",
    item,
  };

  const responseStream = streamHelper.init(200, "application/json");
  responseStream.write(JSON.stringify(responseData));
  responseStream.end();
}

/**
 * セッション一覧取得 GET /chat/sessions
 */
async function getSessions(
  streamHelper: StreamHelper,
  ownerId: string
): Promise<void> {
  const command = new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: "GSI1",
    KeyConditionExpression: "gsi1pk = :userKey",
    ExpressionAttributeValues: { ":userKey": `USER#${ownerId}` },
    ScanIndexForward: false,
    FilterExpression: "attribute_not_exists(deletedAt)",
  });

  const response = await docClient.send(command);
  const sessions = (response.Items || []) as ChatSession[];

  const responseData: GetSessionsResponse = {
    sessions: sessions.map(
      (s): SessionSummary => ({
        sessionId: s.sessionId,
        sessionName: s.sessionName,
        createdAt: s.createdAt,
        lastMessageAt: s.lastMessageAt,
      })
    ),
  };

  const responseStream = streamHelper.init();
  responseStream.write(JSON.stringify(responseData));
  responseStream.end();
}

/**
 * セッション内メッセージ一覧取得
 * GET /chat/sessions/{sessionId}/messages?limit=30&cursor=...&order=desc
 */
async function getSessionMessages(
  streamHelper: StreamHelper,
  sessionId: string,
  ownerId: string,
  queryParams: GetSessionMessagesQueryParams
): Promise<void> {
  const rawLimit = queryParams.limit;
  let limit = DEFAULT_LIMIT;

  if (rawLimit) {
    const parsed = parseInt(rawLimit, 10);
    if (isNaN(parsed) || parsed < 1) {
      throw new AppError(400, ErrorCode.INVALID_PARAMETER);
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  const cursor = queryParams.cursor;
  const exclusiveStartKey = cursor ? decodeCursor(cursor) : undefined;

  const command = new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :sessionKey AND begins_with(sk, :msgPrefix)",
    ExpressionAttributeValues: {
      ":sessionKey": `SESSION#${sessionId}`,
      ":msgPrefix": "MSG#",
      ":ownerId": ownerId,
    },
    FilterExpression: "ownerId = :ownerId AND attribute_not_exists(deletedAt)",
    ScanIndexForward: false,
    Limit: limit,
    ExclusiveStartKey: exclusiveStartKey,
  });

  const response = await docClient.send(command);
  const items = (response.Items || []) as ChatMessage[];

  if (items.length === 0) {
    throw new AppError(404);
  }

  if (items.length > 0 && items[0].ownerId !== ownerId) {
    logger("WARN", "Access attempt to session by non-owner", {
      sessionId,
      ownerId,
      actualOwnerId: items[0].ownerId,
    });
    throw new AppError(404);
  }

  const nextCursor = response.LastEvaluatedKey
    ? encodeCursor(response.LastEvaluatedKey)
    : undefined;

  const responseData: GetSessionMessagesResponse = {
    sessionId,
    messages: items.map(
      (m): MessageSummary => ({
        historyId: m.historyId,
        userQuery: m.userQuery,
        aiResponse: m.aiResponse,
        sourceDocuments: m.sourceDocuments || [],
        feedback: m.feedback || "NONE",
        createdAt: m.createdAt,
      })
    ),
    nextCursor,
  };

  const responseStream = streamHelper.init();
  responseStream.write(JSON.stringify(responseData));
  responseStream.end();
}

// =================================================================
// ヘルパー
// =================================================================

async function sendMockStream(
  responseStream: { write: (data: string) => void; end: () => void },
  query: string,
  sessionId: string,
  ownerId: string,
  createdAt: string,
  redoHistoryId?: string
): Promise<void> {
  let fullText = "";
  const mockCitations: SourceDocument[] = [
    {
      text: '**はい、TypeScriptでも完全に可能です！**\n実は、LangChainにはPython版と双璧をなす**JavaScript/TypeScript版のライブラリ（LangChain.js）**が存在します。\n\nむしろ、Webアプリケーション（Next.jsやReactなど）にAIを組み込む場合は、**LangChain.js（TypeScript）の方が親和性が高く、主流**になりつつあります。\n\n------\n\n### 1. TypeScript版「LangChain.js」の特徴\n\n  * **機能はほぼ同等:** Python版にある機能のほとんどが移植されており、最新のアップデート（LangGraphなど）もほぼ同時にサポートされます。\n  * **Web開発に最適:** Vercel (Edge Functions) や Cloudflare Workers などのサーバーレス環境で動かしやすい設計になっています。\n  * **型安全性:** TypeScriptで書かれているため、型定義がしっかりしており、開発体験（DX）が非常に良いです。\n\n-----\n\n### 2. TypeScriptでのコード例\n\n先ほどのPythonコードと同じ処理（会社名を考える）をTypeScriptで書くと以下のようになります。\n※ 記述方法は非常に似ています。\n\n```typescript\nimport { ChatOpenAI } from "@langchain/openai";\nimport { PromptTemplate } from "@langchain/core/prompts";\n\n// 1. LLMの定義\nconst model = new ChatOpenAI({\n  modelName: "gpt-3.5-turbo",\n  temperature: 0,\n});\n\n// 2. プロンプトのテンプレート作成\nconst prompt = PromptTemplate.fromTemplate(\n  "{product}を作るための、キャッチーな会社名を1つ考えてください。"\n);\n\n// 3. チェーンの作成（pipeを使って繋ぎます）\nconst chain = prompt.pipe(model);\n\n// 実行（非同期処理なのでawaitを使います）\nasync function main() {\n  const response = await chain.invoke({ product: "高性能なAIロボット" });\n  console.log(response.content); \n  // 出力例: "ロボ・インテリジェンス"\n}\n\nmain();\n```\n\n-----\n\n### 3. Python版とどう使い分けるべき？\n\n| 比較項目 | Python版 (LangChain) | Ty',
      fileName: "3_connect_confirm_dynamoDB.md",
      documentId: "31",
      score: 0.95,
    },
    {
      text: '**はい、TypeScriptでも完全に可能です！**\n実は、LangChainにはPython版と双璧をなす**JavaScript/TypeScript版のライブラリ（LangChain.js）**が存在します。\n\nむしろ、Webアプリケーション（Next.jsやReactなど）にAIを組み込む場合は、**LangChain.js（TypeScript）の方が親和性が高く、主流**になりつつあります。\n\n------\n\n### 1. TypeScript版「LangChain.js」の特徴\n\n  * **機能はほぼ同等:** Python版にある機能のほとんどが移植されており、最新のアップデート（LangGraphなど）もほぼ同時にサポートされます。\n  * **Web開発に最適:** Vercel (Edge Functions) や Cloudflare Workers などのサーバーレス環境で動かしやすい設計になっています。\n  * **型安全性:** TypeScriptで書かれているため、型定義がしっかりしており、開発体験（DX）が非常に良いです。\n\n-----\n\n### 2. TypeScriptでのコード例\n\n先ほどのPythonコードと同じ処理（会社名を考える）をTypeScriptで書くと以下のようになります。\n※ 記述方法は非常に似ています。\n\n```typescript\nimport { ChatOpenAI } from "@langchain/openai";\nimport { PromptTemplate } from "@langchain/core/prompts";\n\n// 1. LLMの定義\nconst model = new ChatOpenAI({\n  modelName: "gpt-3.5-turbo",\n  temperature: 0,\n});\n\n// 2. プロンプトのテンプレート作成\nconst prompt = PromptTemplate.fromTemplate(\n  "{product}を作るための、キャッチーな会社名を1つ考えてください。"\n);\n\n// 3. チェーンの作成（pipeを使って繋ぎます）\nconst chain = prompt.pipe(model);\n\n// 実行（非同期処理なのでawaitを使います）\nasync function main() {\n  const response = await chain.invoke({ product: "高性能なAIロボット" });\n  console.log(response.content); \n  // 出力例: "ロボ・インテリジェンス"\n}\n\nmain();\n```\n\n-----\n\n### 3. Python版とどう使い分けるべき？\n\n| 比較項目 | Python版 (LangChain) | Ty',
      fileName: "roudou-kijun.pdf",
      documentId: "9",
      score: 0.95,
    },
  ];

  try {
    await new Promise((resolve) => setTimeout(resolve, 500));

    responseStream.write(
      `data: ${JSON.stringify({
        type: "citations",
        citations: mockCitations,
      })}\n\n`
    );

    const mockResponse =
      '**はい、TypeScriptでも完全に可能です！**\n実は、LangChainにはPython版と双璧をなす**JavaScript/TypeScript版のライブラリ（LangChain.js）**が存在します。\n\nむしろ、Webアプリケーション（Next.jsやReactなど）にAIを組み込む場合は、**LangChain.js（TypeScript）の方が親和性が高く、主流**になりつつあります。\n\n------\n\n### 1. TypeScript版「LangChain.js」の特徴\n\n  * **機能はほぼ同等:** Python版にある機能のほとんどが移植されており、最新のアップデート（LangGraphなど）もほぼ同時にサポートされます。\n  * **Web開発に最適:** Vercel (Edge Functions) や Cloudflare Workers などのサーバーレス環境で動かしやすい設計になっています。\n  * **型安全性:** TypeScriptで書かれているため、型定義がしっかりしており、開発体験（DX）が非常に良いです。\n\n-----\n\n### 2. TypeScriptでのコード例\n\n先ほどのPythonコードと同じ処理（会社名を考える）をTypeScriptで書くと以下のようになります。\n※ 記述方法は非常に似ています。\n\n```typescript\nimport { ChatOpenAI } from "@langchain/openai";\nimport { PromptTemplate } from "@langchain/core/prompts";\n\n// 1. LLMの定義\nconst model = new ChatOpenAI({\n  modelName: "gpt-3.5-turbo",\n  temperature: 0,\n});\n\n// 2. プロンプトのテンプレート作成\nconst prompt = PromptTemplate.fromTemplate(\n  "{product}を作るための、キャッチーな会社名を1つ考えてください。"\n);\n\n// 3. チェーンの作成（pipeを使って繋ぎます）\nconst chain = prompt.pipe(model);\n\n// 実行（非同期処理なのでawaitを使います）\nasync function main() {\n  const response = await chain.invoke({ product: "高性能なAIロボット" });\n  console.log(response.content); \n  // 出力例: "ロボ・インテリジェンス"\n}\n\nmain();\n```\n\n-----\n\n### 3. Python版とどう使い分けるべき？\n\n| 比較項目 | Python版 (LangChain) | TypeScript版 (LangChain.js) |\n| :--- | :--- | :--- |\n| **主な用途** | データ分析、実験、バックエンドAPIサーバー | Webアプリ（Next.js等）、フロントエンド、Edge |\n| **強み** | AI/データサイエンス系のライブラリ(Pandas等)が豊富 | 既存のWeb開発スタック(JS/TS)にそのまま組み込める |\n| **実行環境** | Docker, 一般的なサーバー | Node.js, ブラウザ, Vercel Edge, Deno |\n\n**結論：**\n普段からフロントエンドやNode.jsで開発されているのであれば、無理にPythonを覚える必要はなく、**TypeScript版（LangChain.js）を使うのがおすすめ**です。\n\n-----\n\n**次はどのようなサポートが必要ですか？**\n\n  * **TypeScript (Node.js) 環境でのインストール手順**を知りたいですか？\n  * **Next.js** と組み合わせた具体的な実装例が見たいですか？\n  * **Vercel AI SDK**（LangChainとよく比較されるTS向けツール）との違いを知りたいですか？';
    const chunks = mockResponse.match(/[\s\S]{1,5}/g) || [];

    for (const chunk of chunks) {
      const delay = Math.floor(Math.random() * 70) + 30;

      await new Promise((resolve) => setTimeout(resolve, delay));

      fullText += chunk;
      responseStream.write(
        `data: ${JSON.stringify({ type: "text", text: chunk })}\n\n`
      );
    }

    await saveHistory(
      sessionId,
      ownerId,
      query,
      fullText,
      mockCitations,
      createdAt,
      responseStream,
      redoHistoryId
    );
  } catch (error: any) {
    if (fullText.length > 0) {
      await saveHistoryWithNoEvent(
        sessionId,
        ownerId,
        query,
        fullText,
        mockCitations,
        createdAt,
        redoHistoryId
      );
    }
    throw error;
  }
}

async function sendBedrockStream(
  responseStream: { write: (data: string) => void; end: () => void },
  query: string,
  sessionId: string,
  ownerId: string,
  createdAt: string,
  redoHistoryId?: string
): Promise<void> {
  let fullText = "";
  let citations: SourceDocument[] = [];

  try {
    const embeddings = await generateEmbeddings([query]);
    const queryVector = embeddings[0];

    const apiKey = await getPineconeApiKey();
    const pineconeClient = createPineconeClient(apiKey);

    const retrieveResults: VectorSearchResult[] = await searchVectorsByOwner(
      pineconeClient,
      PINECONE_INDEX_NAME,
      queryVector,
      ownerId,
      5
    );

    // 重複排除
    const uniqueParentTexts = new Set<string>();
    const contextParts: string[] = [];

    retrieveResults.forEach((match) => {
      const parentText = match.metadata.text || "";
      if (parentText && !uniqueParentTexts.has(parentText)) {
        uniqueParentTexts.add(parentText);
        contextParts.push(parentText);
      }
    });

    const contextText = contextParts.join("\n\n");

    citations = retrieveResults
      .filter((match) => match.metadata.text)
      .map(
        (match): SourceDocument => ({
          text: match.metadata.text,
          fileName: match.metadata.fileName,
          score: match.score,
          documentId: match.metadata.documentId,
        })
      );

    responseStream.write(
      `data: ${JSON.stringify({ type: "citations", citations })}\n\n`
    );

    const prompt = `以下のコンテキストを使用して質問に日本語で回答してください。
もしコンテキストに答えが含まれていない場合は、その旨を伝えつつ、あなたの知識で回答してください。

コンテキスト:
${contextText}

質問: ${query}

回答:`;

    for await (const textChunk of invokeClaudeStream(prompt)) {
      fullText += textChunk;
      responseStream.write(
        `data: ${JSON.stringify({ type: "text", text: textChunk })}\n\n`
      );
    }

    await saveHistory(
      sessionId,
      ownerId,
      query,
      fullText,
      citations,
      createdAt,
      responseStream,
      redoHistoryId
    );
  } catch (error) {
    if (fullText.length > 0) {
      try {
        await saveHistoryWithNoEvent(
          sessionId,
          ownerId,
          query,
          fullText,
          citations,
          createdAt,
          redoHistoryId
        );
      } catch (saveError) {
        logger(
          "ERROR",
          "Failed to save partial history during error recovery",
          {
            originalError: error,
            saveError: saveError,
            sessionId,
          }
        );
      }
    }
    throw error;
  }
}

async function saveHistory(
  sessionId: string,
  ownerId: string,
  query: string,
  answer: string,
  citations: SourceDocument[],
  createdAt: string,
  responseStream: { write: (data: string) => void },
  redoHistoryId?: string
): Promise<void> {
  await upsertSessionHeader(sessionId, ownerId, query, createdAt);

  const messageHistoryId = redoHistoryId || randomUUID();

  await saveMessageItem(
    messageHistoryId,
    sessionId,
    ownerId,
    query,
    answer,
    citations,
    createdAt
  );

  responseStream.write(
    `data: ${JSON.stringify({
      type: "done",
      sessionId,
      historyId: messageHistoryId,
      aiResponse: answer,
      citations: citations,
    })}\n\n`
  );
}

async function saveHistoryWithNoEvent(
  sessionId: string,
  ownerId: string,
  query: string,
  answer: string,
  citations: SourceDocument[],
  createdAt: string,
  redoHistoryId?: string
): Promise<void> {
  await upsertSessionHeader(sessionId, ownerId, query, createdAt);

  const messageHistoryId = redoHistoryId || randomUUID();

  await saveMessageItem(
    messageHistoryId,
    sessionId,
    ownerId,
    query,
    answer,
    citations,
    createdAt
  );
}

async function upsertSessionHeader(
  sessionId: string,
  ownerId: string,
  query: string,
  createdAt: string
): Promise<void> {
  const sessionPK = `SESSION#${sessionId}`;
  const sessionSK = "META";
  const initialSessionName =
    query.length > 20 ? `${query.slice(0, 20)}...` : query;

  try {
    const existingSession = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: sessionPK, sk: sessionSK },
      })
    );
    if (existingSession.Item) {
      await docClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: sessionPK, sk: sessionSK },
          UpdateExpression: "SET lastMessageAt = :last, gsi1sk = :last",
          ExpressionAttributeValues: { ":last": createdAt },
        })
      );
    } else {
      await docClient.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            pk: sessionPK,
            sk: sessionSK,
            gsi1pk: `USER#${ownerId}`,
            gsi1sk: createdAt,
            sessionId,
            ownerId,
            sessionName: initialSessionName,
            createdAt,
            lastMessageAt: createdAt,
          },
        })
      );
    }
  } catch (error) {
    logger("ERROR", "Failed to upsert session header", {
      error,
      sessionId,
      ownerId,
    });
    throw error;
  }
}

async function saveMessageItem(
  messageId: string,
  sessionId: string,
  ownerId: string,
  query: string,
  answer: string,
  citations: SourceDocument[],
  createdAt: string
): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: `SESSION#${sessionId}`,
        sk: `MSG#${createdAt}`,
        historyId: messageId,
        sessionId,
        ownerId,
        userQuery: query,
        aiResponse: answer,
        sourceDocuments: citations,
        feedback: "NONE",
        createdAt,
      },
    })
  );
}
