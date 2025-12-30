import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { APIGatewayProxyEvent } from "aws-lambda";
import { randomUUID } from "crypto";

import {
  generateEmbeddings,
  invokeClaudeStream,
} from "../../shared/clients/bedrock";
import {
  createPineconeClient,
  getPineconeApiKey,
  searchVectorsByOwner,
} from "../../shared/clients/pinecone";
import {
  ChatStreamRequestDto,
  ChatStreamRequestSchema,
  DeleteSessionResponseDto,
  GetSessionMessagesQueryParamsDto,
  GetSessionMessagesResponseDto,
  GetSessionsResponseDto,
  SourceDocumentDto,
  StreamWriter,
  SubmitFeedbackRequestDto,
  SubmitFeedbackRequestSchema,
  SubmitFeedbackResponseDto,
  UpdateSessionNameRequestDto,
  UpdateSessionNameRequestSchema,
  UpdateSessionNameResponseDto,
} from "../../shared/schemas/dto/chat.dto";
import {
  ChatMessageEntity,
  ChatSessionEntity,
} from "../../shared/schemas/entities/chat.entity";
import { ErrorCode } from "../../shared/types/error-code";
import { VectorSearchResult } from "../../shared/types/pinecone";
import {
  AppError,
  logger,
  streamApiHandler,
  StreamHelper,
  validateJson,
} from "../../shared/utils/api-handler";
import { toMessageDTO, toSessionDTO } from "../../shared/utils/dto-mapper";
import {
  createDynamoDBClient,
  decodeCursor,
  encodeCursor,
} from "../../shared/utils/dynamodb";
import {
  streamCitations,
  streamError,
  streamFinish,
  streamSessionInfo,
  streamTextDelta,
  UI_MESSAGE_STREAM_CONTENT_TYPE,
} from "../../shared/utils/stream-helper";

// =================================================================
// Configuration & Clients
// =================================================================

const TABLE_NAME = process.env.TABLE_NAME!;
const IS_LOCAL_STAGE = process.env.STAGE! === "local";
const USE_BEDROCK = process.env.USE_BEDROCK! === "true";
const USER_POOL_ID = process.env.USER_POOL_ID!;
const CLIENT_ID = process.env.CLIENT_ID!;

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

const docClient = createDynamoDBClient();

const verifier =
  !IS_LOCAL_STAGE && USER_POOL_ID && CLIENT_ID
    ? CognitoJwtVerifier.create({
        userPoolId: USER_POOL_ID,
        tokenUse: "id",
        clientId: CLIENT_ID,
      })
    : null;

// =================================================================
// Main Handler
// =================================================================

export const handler = streamApiHandler(async (event, streamHelper) => {
  const { httpMethod, path, queryStringParameters } = event;

  const ownerId = await extractOwnerId(event);

  if (httpMethod === "POST" && path === "/chat/stream") {
    const body = validateJson<ChatStreamRequestDto>(
      event.body,
      ChatStreamRequestSchema
    );
    await chatStream(body, streamHelper, ownerId);
    return;
  }

  if (httpMethod === "POST" && path === "/chat/feedback") {
    const body = validateJson<SubmitFeedbackRequestDto>(
      event.body,
      SubmitFeedbackRequestSchema
    );
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
        (queryStringParameters || {}) as GetSessionMessagesQueryParamsDto
      );
      return;
    }

    if (httpMethod === "PATCH") {
      const body = validateJson<UpdateSessionNameRequestDto>(
        event.body,
        UpdateSessionNameRequestSchema
      );
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
  if (IS_LOCAL_STAGE) {
    return "user-001";
  }

  try {
    const authHeader =
      event.headers?.Authorization || event.headers?.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new Error();
    }

    const token = authHeader.split(" ")[1];
    const payload = await verifier?.verify(token);
    if (!payload) {
      throw new Error();
    }
    return payload.sub;
  } catch {
    throw new AppError(401, ErrorCode.PERMISSION_DENIED);
  }
}

// =================================================================
// ビジネスロジック
// =================================================================

/**
 * チャットストリーミング POST /chat/stream
 * Vercel AI SDK Data Stream Protocol に準拠
 */
async function chatStream(
  body: ChatStreamRequestDto,
  streamHelper: StreamHelper,
  ownerId: string
): Promise<void> {
  const { sessionId, redoHistoryId } = body;

  if (!sessionId) {
    throw new AppError(400, ErrorCode.MISSING_PARAMETER);
  }

  const query = extractQueryFromRequest(body);

  const responseStream = streamHelper.init(200, UI_MESSAGE_STREAM_CONTENT_TYPE);

  try {
    const createdAt = new Date().toISOString();

    if (!USE_BEDROCK) {
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
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger("ERROR", "Failed to process chat stream", {
        errorName: error.name,
        errorMessage: error.message,
        stack: error.stack,
        ownerId,
        sessionId,
      });
    }

    const errorCode =
      error instanceof AppError
        ? error.errorCode
        : ErrorCode.INTERNAL_SERVER_ERROR;

    streamError(responseStream, errorCode || "INTERNAL_SERVER_ERROR");
    responseStream.end();
  }
}

/**
 * モックストリーム送信
 */
async function sendMockStream(
  responseStream: StreamWriter,
  query: string,
  sessionId: string,
  ownerId: string,
  createdAt: string,
  redoHistoryId?: string
): Promise<void> {
  let fullText = "";
  const textId = `text-${Date.now()}`;

  const mockCitations: SourceDocumentDto[] = [
    {
      text: "Mock Citation Text 1",
      fileName: "doc1.pdf",
      documentId: "1",
      score: 0.95,
    },
    {
      text: "Mock Citation Text 2",
      fileName: "doc2.pdf",
      documentId: "2",
      score: 0.92,
    },
  ];

  try {
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 引用情報を送信
    streamCitations(responseStream, mockCitations);

    const mockResponse =
      '**はい、TypeScriptでも完全に可能です！**\n実は、LangChainにはPython版と双璧をなす**JavaScript/TypeScript版のライブラリ（LangChain.js）**が存在します。\n\nむしろ、Webアプリケーション（Next.jsやReactなど）にAIを組み込む場合は、**LangChain.js（TypeScript）の方が親和性が高く、主流**になりつつあります。\n\n------\n\n### 1. TypeScript版「LangChain.js」の特徴\n\n  * **機能はほぼ同等:** Python版にある機能のほとんどが移植されており、最新のアップデート（LangGraphなど）もほぼ同時にサポートされます。\n  * **Web開発に最適:** Vercel (Edge Functions) や Cloudflare Workers などのサーバーレス環境で動かしやすい設計になっています。\n  * **型安全性:** TypeScriptで書かれているため、型定義がしっかりしており、開発体験（DX）が非常に良いです。\n\n-----\n\n### 2. TypeScriptでのコード例\n\n先ほどのPythonコードと同じ処理（会社名を考える）をTypeScriptで書くと以下のようになります。\n※ 記述方法は非常に似ています。\n\n```typescript\nimport { ChatOpenAI } from "@langchain/openai";\nimport { PromptTemplate } from "@langchain/core/prompts";\n\n// 1. LLMの定義\nconst model = new ChatOpenAI({\n  modelName: "gpt-3.5-turbo",\n  temperature: 0,\n});\n\n// 2. プロンプトのテンプレート作成\nconst prompt = PromptTemplate.fromTemplate(\n  "{product}を作るための、キャッチーな会社名を1つ考えてください。"\n);\n\n// 3. チェーンの作成（pipeを使って繋ぎます）\nconst chain = prompt.pipe(model);\n\n// 実行（非同期処理なのでawaitを使います）\nasync function main() {\n  const response = await chain.invoke({ product: "高性能なAIロボット" });\n  console.log(response.content); \n  // 出力例: "ロボ・インテリジェンス"\n}\n\nmain();\n```\n\n-----\n\n### 3. Python版とどう使い分けるべき？\n\n| 比較項目 | Python版 (LangChain) | TypeScript版 (LangChain.js) |\n| :--- | :--- | :--- |\n| **主な用途** | データ分析、実験、バックエンドAPIサーバー | Webアプリ（Next.js等）、フロントエンド、Edge |\n| **強み** | AI/データサイエンス系のライブラリ(Pandas等)が豊富 | 既存のWeb開発スタック(JS/TS)にそのまま組み込める |\n| **実行環境** | Docker, 一般的なサーバー | Node.js, ブラウザ, Vercel Edge, Deno |\n\n**結論：**\n普段からフロントエンドやNode.jsで開発されているのであれば、無理にPythonを覚える必要はなく、**TypeScript版（LangChain.js）を使うのがおすすめ**です。\n\n-----\n\n**次はどのようなサポートが必要ですか？**\n\n  * **TypeScript (Node.js) 環境でのインストール手順**を知りたいですか？\n  * **Next.js** と組み合わせた具体的な実装例が見たいですか？\n  * **Vercel AI SDK**（LangChainとよく比較されるTS向けツール）との違いを知りたいですか？';
    const chunks = mockResponse.match(/[\s\S]{1,5}/g) || [];

    for (const chunk of chunks) {
      fullText += chunk;
      streamTextDelta(responseStream, chunk);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // 履歴を保存
    const messageHistoryId = await saveHistory(
      sessionId,
      ownerId,
      query,
      fullText,
      mockCitations,
      createdAt,
      redoHistoryId
    );

    // セッション情報を送信
    streamSessionInfo(responseStream, sessionId, messageHistoryId, createdAt);
    streamFinish(responseStream, "stop");
  } catch (error: unknown) {
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

/**
 * Bedrock (Claude) ストリーム送信
 */

async function sendBedrockStream(
  responseStream: StreamWriter,
  query: string,
  sessionId: string,
  ownerId: string,
  createdAt: string,
  redoHistoryId?: string
): Promise<void> {
  let fullText = "";
  let citations: SourceDocumentDto[] = [];

  try {
    const embeddings = await generateEmbeddings([query]);
    const queryVector = embeddings[0];

    const apiKey = await getPineconeApiKey();
    const pineconeClient = createPineconeClient(apiKey);

    const retrieveResults: VectorSearchResult[] = await searchVectorsByOwner(
      pineconeClient,
      queryVector,
      ownerId,
      5
    );

    // 重複排除とコンテキスト生成
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
        (match): SourceDocumentDto => ({
          text: match.metadata.text,
          fileName: match.metadata.fileName,
          score: match.score,
          documentId: match.metadata.documentId,
        })
      );

    // 引用情報を送信
    streamCitations(responseStream, citations);

    const prompt = `以下のコンテキストを使用して質問に日本語で回答してください。
もしコンテキストに答えが含まれていない場合は、その旨を伝えつつ、あなたの知識で回答してください。

コンテキスト:
${contextText}

質問: ${query}

回答:`;

    // Bedrockからのチャンクを順次送信
    for await (const textChunk of invokeClaudeStream(prompt)) {
      fullText += textChunk;
      streamTextDelta(responseStream, textChunk);
    }

    const messageHistoryId = await saveHistory(
      sessionId,
      ownerId,
      query,
      fullText,
      citations,
      createdAt,
      redoHistoryId
    );

    // セッション情報を送信
    streamSessionInfo(responseStream, sessionId, messageHistoryId, createdAt);
    streamFinish(responseStream, "stop");
  } catch (error: unknown) {
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
      } catch (saveError: unknown) {
        logger(
          "ERROR",
          "Failed to save partial history during error recovery",
          {
            sessionId,
            error: saveError,
          }
        );
      }
    }
    throw error;
  }
}

// -----------------------------------------------------------
// DB Helper Functions
// -----------------------------------------------------------

/**
 * 履歴保存（イベント送信は呼び出し元で行うよう変更し、IDを返す）
 */
async function saveHistory(
  sessionId: string,
  ownerId: string,
  query: string,
  answer: string,
  citations: SourceDocumentDto[],
  createdAt: string,
  redoHistoryId?: string
): Promise<string> {
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

  return messageHistoryId;
}

async function saveHistoryWithNoEvent(
  sessionId: string,
  ownerId: string,
  query: string,
  answer: string,
  citations: SourceDocumentDto[],
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
  } catch (error: unknown) {
    logger("ERROR", "Failed to upsert session header", {
      sessionId,
      ownerId,
      error,
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
  citations: SourceDocumentDto[],
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

// -----------------------------------------------------------
// Other Route Handlers (No changes required for Vercel Stream)
// -----------------------------------------------------------

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
  const session = response.Attributes as ChatSessionEntity;

  const responseData: UpdateSessionNameResponseDto = {
    status: "success",
    session: toSessionDTO(session),
  };

  const responseStream = streamHelper.init(200, "application/json");
  responseStream.write(JSON.stringify(responseData));
  responseStream.end();
}

async function deleteSession(
  streamHelper: StreamHelper,
  sessionId: string,
  ownerId: string
): Promise<void> {
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

  const responseData: DeleteSessionResponseDto = {
    status: "success",
  };

  const responseStream = streamHelper.init(200, "application/json");
  responseStream.write(JSON.stringify(responseData));
  responseStream.end();
}

async function submitFeedback(
  body: SubmitFeedbackRequestDto,
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
  const item = response.Attributes as ChatMessageEntity;

  const responseData: SubmitFeedbackResponseDto = {
    status: "success",
    item: toMessageDTO(item),
  };

  const responseStream = streamHelper.init(200, "application/json");
  responseStream.write(JSON.stringify(responseData));
  responseStream.end();
}

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
  const sessions = (response.Items || []) as ChatSessionEntity[];

  const responseData: GetSessionsResponseDto = {
    sessions: sessions.map((s) => toSessionDTO(s)),
  };

  const responseStream = streamHelper.init(200, "application/json");
  responseStream.write(JSON.stringify(responseData));
  responseStream.end();
}

async function getSessionMessages(
  streamHelper: StreamHelper,
  sessionId: string,
  ownerId: string,
  queryParams: GetSessionMessagesQueryParamsDto
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
  const items = (response.Items || []) as ChatMessageEntity[];

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

  const responseData: GetSessionMessagesResponseDto = {
    sessionId,
    messages: items.map((m) => toMessageDTO(m)),
    nextCursor,
  };

  const responseStream = streamHelper.init(200, "application/json");
  responseStream.write(JSON.stringify(responseData));
  responseStream.end();
}

/**
 * クエリを抽出
 */
function extractQueryFromRequest(body: ChatStreamRequestDto): string {
  if (!body.messages || body.messages.length === 0) {
    throw new AppError(400, ErrorCode.MISSING_PARAMETER);
  }

  for (let i = body.messages.length - 1; i >= 0; i--) {
    const message = body.messages[i];
    if (message.role === "user" && message.parts) {
      const textParts = message.parts.filter(
        (part): part is { type: "text"; text: string } => part.type === "text"
      );
      if (textParts.length > 0) {
        return textParts.map((p) => p.text).join("");
      }
    }
  }

  throw new AppError(400, ErrorCode.MISSING_PARAMETER);
}
