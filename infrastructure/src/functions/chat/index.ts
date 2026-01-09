import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
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
  SourceDocumentDto,
  StreamWriter,
  TextUIPartDto,
} from "../../shared/schemas/dto/chat.dto";
import { ErrorCode } from "../../shared/types/error-code";
import {
  AppError,
  logger,
  streamApiHandler,
  StreamHelper,
  validateJson,
} from "../../shared/utils/api-handler";
import { createDynamoDBClient } from "../../shared/utils/dynamodb";
import {
  streamCitations,
  streamError,
  streamFinish,
  streamSessionInfo,
  streamTextDelta,
  UI_MESSAGE_STREAM_CONTENT_TYPE,
} from "../../shared/utils/stream-helper";

const TABLE_NAME = process.env.TABLE_NAME!;
const IS_LOCAL_STAGE = process.env.STAGE! === "local";
const USE_BEDROCK = process.env.USE_BEDROCK! === "true";
const USER_POOL_ID = process.env.USER_POOL_ID!;
const CLIENT_ID = process.env.CLIENT_ID!;

const docClient = createDynamoDBClient();

const verifier =
  !IS_LOCAL_STAGE && USER_POOL_ID && CLIENT_ID
    ? CognitoJwtVerifier.create({
        userPoolId: USER_POOL_ID,
        tokenUse: "id",
        clientId: CLIENT_ID,
      })
    : null;

/**
 * Chat Stream Lambda Handler
 */
export const handler = streamApiHandler(async (event, streamHelper) => {
  const { httpMethod, path } = event;
  const ownerId = await extractOwnerId(event);

  if (httpMethod === "POST" && path === "/chat/stream") {
    const body = validateJson<ChatStreamRequestDto>(
      event.body,
      ChatStreamRequestSchema
    );
    await chatStream(body, streamHelper, ownerId);
    return;
  }

  throw new AppError(404);
});

async function extractOwnerId(event: APIGatewayProxyEvent): Promise<string> {
  if (IS_LOCAL_STAGE) return "user-001";
  try {
    const authHeader =
      event.headers?.Authorization || event.headers?.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) throw new Error();
    const token = authHeader.split(" ")[1];
    const payload = await verifier?.verify(token);
    if (!payload) throw new Error();
    return payload.sub;
  } catch {
    throw new AppError(401, ErrorCode.PERMISSION_DENIED);
  }
}

/**
 * チャットストリーミング
 */
async function chatStream(
  body: ChatStreamRequestDto,
  streamHelper: StreamHelper,
  ownerId: string
): Promise<void> {
  const { sessionId, redoHistoryId } = body;
  const query = extractQueryFromRequest(body);
  const createdAt = new Date().toISOString();

  const responseStream = streamHelper.init(200, UI_MESSAGE_STREAM_CONTENT_TYPE);

  try {
    if (USE_BEDROCK) {
      await processWithBedrock(
        responseStream,
        sessionId,
        query,
        ownerId,
        createdAt,
        redoHistoryId
      );
    } else {
      await processWithMockData(
        responseStream,
        sessionId,
        query,
        ownerId,
        createdAt,
        redoHistoryId
      );
    }
  } catch (error: unknown) {
    handleStreamError(responseStream, error, ownerId, sessionId);
  } finally {
    responseStream.end();
  }
}

/**
 * Bedrockを使用した処理フロー
 */
async function processWithBedrock(
  responseStream: StreamWriter,
  sessionId: string,
  query: string,
  ownerId: string,
  createdAt: string,
  redoHistoryId?: string
): Promise<void> {
  let fullText = "";
  let citations: SourceDocumentDto[] = [];

  try {
    const embeddings = await generateEmbeddings([query]);
    const apiKey = await getPineconeApiKey();
    const pineconeClient = createPineconeClient(apiKey);
    const retrieveResults = await searchVectorsByOwner(
      pineconeClient,
      embeddings[0],
      ownerId,
      5
    );

    const uniqueTexts = new Set<string>();
    const contextParts: string[] = [];
    retrieveResults.forEach((match) => {
      const text = match.metadata.text || "";
      if (text && !uniqueTexts.has(text)) {
        uniqueTexts.add(text);
        contextParts.push(text);
      }
    });

    citations = retrieveResults
      .filter((m) => m.metadata.text)
      .map(
        (m): SourceDocumentDto => ({
          text: m.metadata.text!,
          fileName: m.metadata.fileName || "unknown",
          score: m.score || 0,
          documentId: m.metadata.documentId || `doc-${Date.now()}`,
        })
      );

    // 引用情報を送信
    streamCitations(responseStream, citations);

    const prompt = buildPrompt(contextParts.join("\n\n"), query);
    for await (const chunk of invokeClaudeStream(prompt)) {
      fullText += chunk;
      streamTextDelta(responseStream, chunk);
    }

    const messageHistoryId = await saveHistoryOptimized(
      sessionId,
      ownerId,
      query,
      fullText,
      citations,
      createdAt,
      redoHistoryId
    );

    streamSessionInfo(responseStream, sessionId, messageHistoryId, createdAt);
    streamFinish(responseStream, "stop");
  } catch (error) {
    // エラー時も途中までのログを保存
    if (fullText.length > 0) {
      await saveHistoryOptimized(
        sessionId,
        ownerId,
        query,
        fullText,
        citations,
        createdAt,
        redoHistoryId
      ).catch((e: unknown) =>
        logger(
          "ERROR",
          "Failed to save partial history during error recovery",
          {
            errorName: e instanceof Error ? e.name : "UnknownError",
            errorMessage: e instanceof Error ? e.message : "UnknownError",
            stack: e instanceof Error ? e.stack : undefined,
            ownerId,
            sessionId,
          }
        )
      );
    }
    throw error;
  }
}

/**
 * モックデータを使用した処理フロー
 */
async function processWithMockData(
  responseStream: StreamWriter,
  sessionId: string,
  query: string,
  ownerId: string,
  createdAt: string,
  redoHistoryId?: string
): Promise<void> {
  const mockCitations: SourceDocumentDto[] = [
    {
      text: "Mock Citation Text 1",
      fileName: "mock.pdf",
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

  streamCitations(responseStream, mockCitations);

  const mockResponse =
    '**はい、TypeScriptでも完全に可能です！**\n実は、LangChainにはPython版と双璧をなす**JavaScript/TypeScript版のライブラリ（LangChain.js）**が存在します。\n\nむしろ、Webアプリケーション（Next.jsやReactなど）にAIを組み込む場合は、**LangChain.js（TypeScript）の方が親和性が高く、主流**になりつつあります。\n\n------\n\n### 1. TypeScript版「LangChain.js」の特徴\n\n  * **機能はほぼ同等:** Python版にある機能のほとんどが移植されており、最新のアップデート（LangGraphなど）もほぼ同時にサポートされます。\n  * **Web開発に最適:** Vercel (Edge Functions) や Cloudflare Workers などのサーバーレス環境で動かしやすい設計になっています。\n  * **型安全性:** TypeScriptで書かれているため、型定義がしっかりしており、開発体験（DX）が非常に良いです。\n\n-----\n\n### 2. TypeScriptでのコード例\n\n先ほどのPythonコードと同じ処理（会社名を考える）をTypeScriptで書くと以下のようになります。\n※ 記述方法は非常に似ています。\n\n```typescript\nimport { ChatOpenAI } from "@langchain/openai";\nimport { PromptTemplate } from "@langchain/core/prompts";\n\n// 1. LLMの定義\nconst model = new ChatOpenAI({\n  modelName: "gpt-3.5-turbo",\n  temperature: 0,\n});\n\n// 2. プロンプトのテンプレート作成\nconst prompt = PromptTemplate.fromTemplate(\n  "{product}を作るための、キャッチーな会社名を1つ考えてください。"\n);\n\n// 3. チェーンの作成（pipeを使って繋ぎます）\nconst chain = prompt.pipe(model);\n\n// 実行（非同期処理なのでawaitを使います）\nasync function main() {\n  const response = await chain.invoke({ product: "高性能なAIロボット" });\n  console.log(response.content); \n  // 出力例: "ロボ・インテリジェンス"\n}\n\nmain();\n```\n\n-----\n\n### 3. Python版とどう使い分けるべき？\n\n| 比較項目 | Python版 (LangChain) | TypeScript版 (LangChain.js) |\n| :--- | :--- | :--- |\n| **主な用途** | データ分析、実験、バックエンドAPIサーバー | Webアプリ（Next.js等）、フロントエンド、Edge |\n| **強み** | AI/データサイエンス系のライブラリ(Pandas等)が豊富 | 既存のWeb開発スタック(JS/TS)にそのまま組み込れる |\n| **実行環境** | Docker, 一般的なサーバー | Node.js, ブラウザ, Vercel Edge, Deno |\n\n**結論：**\n普段からフロントエンドやNode.jsで開発されているのであれば、無理にPythonを覚える必要はなく、**TypeScript版（LangChain.js）を使うのがおすすめ**です。\n\n-----\n\n**次はどのようなサポートが必要ですか？**\n\n  * **TypeScript (Node.js) 環境でのインストール手順**を知りたいですか？\n  * **Next.js** と組み合わせた具体的な実装例が見たいですか？\n  * **Vercel AI SDK**（LangChainとよく比較されるTS向けツール）との違いを知りたいですか？';
  const chunks = mockResponse.match(/[\s\S]{1,5}/g) || [];

  let fullText = "";
  for (const chunk of chunks) {
    fullText += chunk;
    streamTextDelta(responseStream, chunk);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const messageHistoryId = await saveHistoryOptimized(
    sessionId,
    ownerId,
    query,
    fullText,
    mockCitations,
    createdAt,
    redoHistoryId
  );

  streamSessionInfo(responseStream, sessionId, messageHistoryId, createdAt);
  streamFinish(responseStream, "stop");
}

/**
 * 履歴保存処理
 */
async function saveHistoryOptimized(
  sessionId: string,
  ownerId: string,
  query: string,
  answer: string,
  citations: SourceDocumentDto[],
  createdAt: string,
  redoHistoryId?: string
): Promise<string> {
  const historyId = redoHistoryId || randomUUID();
  const sessionName = query.length > 20 ? `${query.slice(0, 20)}...` : query;

  // 1. セッションメタデータの更新
  const sessionUpdateCommand = new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `SESSION#${sessionId}`,
      sk: "META",
    },
    UpdateExpression: `
      SET 
        gsi1pk = if_not_exists(gsi1pk, :userKey),
        gsi1sk = :createdAt,
        sessionId = if_not_exists(sessionId, :sessionId),
        ownerId = if_not_exists(ownerId, :ownerId),
        sessionName = if_not_exists(sessionName, :sessionName),
        createdAt = if_not_exists(createdAt, :createdAt),
        updatedAt = :createdAt,
        lastMessageAt = :createdAt
    `,
    ExpressionAttributeValues: {
      ":userKey": `USER#${ownerId}`,
      ":sessionId": sessionId,
      ":ownerId": ownerId,
      ":sessionName": sessionName,
      ":createdAt": createdAt,
    },
  });

  // 2. メッセージの保存
  const messagePutCommand = new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      pk: `SESSION#${sessionId}`,
      sk: `MSG#${createdAt}`,
      historyId,
      sessionId,
      ownerId,
      userQuery: query,
      aiResponse: answer,
      sourceDocuments: citations,
      feedback: "NONE",
      createdAt,
      updatedAt: createdAt,
    },
  });

  await Promise.all([
    docClient.send(sessionUpdateCommand),
    docClient.send(messagePutCommand),
  ]);

  return historyId;
}

/**
 * リクエストからユーザーのクエリテキストを抽出
 * UIMessage形式に対応 (parts配列からtextタイプを抽出)
 */
function extractQueryFromRequest(body: ChatStreamRequestDto): string {
  const lastUserMessage = body.messages
    .slice()
    .reverse()
    .find((m) => m.role === "user");

  if (!lastUserMessage?.parts) {
    throw new AppError(400, ErrorCode.MISSING_PARAMETER);
  }

  const isTextPart = (p: unknown): p is TextUIPartDto =>
    typeof p === "object" && p !== null && (p as TextUIPartDto).type === "text";

  const text = lastUserMessage.parts
    .filter(isTextPart)
    .map((p) => p.text)
    .join("");

  if (!text) {
    throw new AppError(400, ErrorCode.MISSING_PARAMETER);
  }

  return text;
}

function buildPrompt(context: string, query: string): string {
  return `以下のコンテキストを使用して質問に日本語で回答してください。
もしコンテキストに答えが含まれていない場合は、その旨を伝えつつ、あなたの知識で回答してください。

コンテキスト:
${context}

質問: ${query}

回答:`;
}

function handleStreamError(
  stream: StreamWriter,
  error: unknown,
  ownerId: string,
  sessionId: string
) {
  if (error instanceof Error) {
    logger("ERROR", "Chat stream failed", {
      error: error.message,
      ownerId,
      sessionId,
    });
  }
  const code =
    error instanceof AppError
      ? error.errorCode
      : ErrorCode.INTERNAL_SERVER_ERROR;
  streamError(stream, code || "INTERNAL_SERVER_ERROR");
}
