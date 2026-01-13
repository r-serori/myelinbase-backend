// src/functions/chat/index.ts
// AI SDK 6+ を使用した完全準拠のストリーミング実装

import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createUIMessageStream } from "ai";
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
  buildRAGPrompt,
  ContextDocument,
  extractAnswerFromStream,
  extractCitedFileNames,
  parseThinkingResponse,
} from "../../shared/prompts/rag-prompt-builder";
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

// ============================================
// Configuration
// ============================================

const TABLE_NAME = process.env.TABLE_NAME!;
const IS_LOCAL_STAGE = process.env.STAGE! === "local";
const USE_BEDROCK = process.env.USE_BEDROCK! === "true";
const USER_POOL_ID = process.env.USER_POOL_ID!;
const CLIENT_ID = process.env.CLIENT_ID!;

// RAG Options
const ENABLE_THINKING = process.env.ENABLE_THINKING === "true";

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
 * AI SDK 6+ Data Stream Protocol Content-Type (SSE)
 */
const UI_MESSAGE_STREAM_CONTENT_TYPE = "text/event-stream";

/**
 * Chat Stream Lambda Handler
 */
export const handler = streamApiHandler(async (event, streamHelper) => {
  const httpMethod =
    (event.requestContext as { http?: { method?: string } })?.http?.method ||
    event.httpMethod;
  const path =
    (event as { rawPath?: string }).rawPath ||
    (event.requestContext as { http?: { path?: string } })?.http?.path ||
    event.path;

  const ownerId = await extractOwnerId(event);

  if (
    httpMethod === "POST" &&
    (path === "/chat/stream" || path === "chat/stream")
  ) {
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
  const authHeader =
    event.headers?.Authorization || event.headers?.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    throw new AppError(401, ErrorCode.PERMISSION_DENIED);
  }

  const token = authHeader.split(" ")[1];
  const payload = await verifier?.verify(token);
  if (!payload) {
    throw new AppError(401, ErrorCode.PERMISSION_DENIED);
  }

  return payload.sub;
}

/**
 * チャットストリーミング - AI SDK 6+
 */
async function chatStream(
  body: ChatStreamRequestDto,
  streamHelper: StreamHelper,
  ownerId: string
): Promise<void> {
  const { sessionId, redoHistoryId } = body;
  const query = extractQuery(body);
  const createdAt = new Date().toISOString();

  const lambdaStream = streamHelper.init(200, UI_MESSAGE_STREAM_CONTENT_TYPE);

  try {
    if (USE_BEDROCK) {
      await processWithBedrock(
        lambdaStream,
        sessionId,
        query,
        ownerId,
        createdAt,
        redoHistoryId
      );
    } else {
      await processWithMockData(
        lambdaStream,
        sessionId,
        query,
        ownerId,
        createdAt,
        redoHistoryId
      );
    }
  } catch (error: unknown) {
    handleError(lambdaStream, error, ownerId, sessionId);
  } finally {
    lambdaStream.end();
  }
}

/**
 * AI SDK createUIMessageStream を使用してストリームを生成し、
 * Lambda のストリームに書き込む
 */
async function processWithBedrock(
  lambdaStream: StreamWriter,
  sessionId: string,
  query: string,
  ownerId: string,
  createdAt: string,
  redoHistoryId?: string
): Promise<void> {
  let fullText = "";
  let citations: SourceDocumentDto[] = [];
  let historyId = "";

  // createUIMessageStream で AI SDK 準拠のストリームを生成
  const uiStream = createUIMessageStream({
    execute: async ({ writer }) => {
      try {
        // 1. Embed query
        const [queryEmbedding] = await generateEmbeddings([query]);

        // 2. Search Pinecone
        const apiKey = await getPineconeApiKey();
        const pinecone = createPineconeClient(apiKey);
        const results = await searchVectorsByOwner(
          pinecone,
          queryEmbedding,
          ownerId,
          5
        );

        // 3. Deduplicate and build context
        const seen = new Set<string>();
        const documents: ContextDocument[] = [];

        for (const match of results) {
          const text = match.metadata.text || "";
          if (text && !seen.has(text)) {
            seen.add(text);
            documents.push({
              text,
              fileName: match.metadata.fileName || "unknown",
              documentId: match.metadata.documentId || `doc-${Date.now()}`,
              score: match.score || 0,
            });
          }
        }

        // 4. Build citations for frontend
        const candidateCitations: SourceDocumentDto[] = documents.map(
          (doc) => ({
            text: doc.text,
            fileName: doc.fileName,
            documentId: doc.documentId,
            score: doc.score,
          })
        );

        // 6. Generate RAG prompt
        const { systemPrompt, userPrompt } = buildRAGPrompt({
          documents,
          query,
          enableThinking: ENABLE_THINKING,
        });

        // 7. Stream Claude response as text
        const textBlockId = `text-${randomUUID()}`;
        writer.write({ type: "text-start", id: textBlockId });

        let lastStreamedLength = 0;

        for await (const chunk of invokeClaudeStream({
          prompt: userPrompt,
          systemPrompt,
          maxTokens: 2048,
        })) {
          fullText += chunk;

          if (ENABLE_THINKING) {
            const answerContent = extractAnswerFromStream(fullText);
            const newContent = answerContent.substring(lastStreamedLength);
            if (newContent) {
              writer.write({
                type: "text-delta",
                id: textBlockId,
                delta: newContent,
              });
              lastStreamedLength = answerContent.length;
            }
          } else {
            writer.write({ type: "text-delta", id: textBlockId, delta: chunk });
          }
        }

        writer.write({ type: "text-end", id: textBlockId });

        // 8. Parse final answer for storage
        const finalAnswer = ENABLE_THINKING
          ? parseThinkingResponse(fullText).answer
          : fullText;

        const citedFileNames = extractCitedFileNames(finalAnswer);

        citations = candidateCitations.filter((doc) =>
          citedFileNames.includes(doc.fileName)
        );

        citations.sort((a, b) => b.score - a.score);

        for (const citation of citations) {
          writer.write({
            type: "data-citation",
            data: {
              sourceId: citation.documentId,
              fileName: citation.fileName,
              text: citation.text,
              score: citation.score,
            },
          });
        }

        // 9. Save history
        historyId = await saveHistory(
          sessionId,
          ownerId,
          query,
          finalAnswer,
          citations,
          createdAt,
          redoHistoryId
        );

        // 10. Send session info as custom data part
        writer.write({
          type: "data-session-info",
          data: {
            sessionId,
            historyId,
            createdAt,
          },
        });
      } catch (error) {
        // Save partial response on error
        if (fullText) {
          await saveHistory(
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
                ownerId,
                sessionId,
              }
            )
          );
        }
        throw error;
      }
    },
  });

  // ReadableStream を消費して Lambda ストリームに書き込む
  // createUIMessageStream は ReadableStream<object> を返すため、型キャストが必要
  await pipeToLambdaStream(
    uiStream as unknown as ReadableStream<string | object>,
    lambdaStream
  );
}

async function processWithMockData(
  lambdaStream: StreamWriter,
  sessionId: string,
  query: string,
  ownerId: string,
  createdAt: string,
  redoHistoryId?: string
): Promise<void> {
  const mockCitations: SourceDocumentDto[] = [
    {
      text: "Mock document 1",
      fileName: "mock1.pdf",
      documentId: "doc-1",
      score: 0.95,
    },
    {
      text: "Mock document 2",
      fileName: "mock2.pdf",
      documentId: "doc-2",
      score: 0.88,
    },
  ];

  const uiStream = createUIMessageStream({
    execute: async ({ writer }) => {
      // Mock: Stream text content first
      const textBlockId = `text-${randomUUID()}`;
      writer.write({ type: "text-start", id: textBlockId });

      const response =
        "**はい、TypeScriptでも完全に可能です！**\n実は、LangChainにはPython版と双璧をなす**JavaScript/TypeScript版のライブラリ（LangChain.js）**が存在します。\n\n" +
        `あなたの質問: ${query}`;

      const chunks = response.match(/[\s\S]{1,10}/g) || [];
      let fullText = "";

      for (const chunk of chunks) {
        fullText += chunk;
        writer.write({ type: "text-delta", id: textBlockId, delta: chunk });
        await new Promise((r) => setTimeout(r, 30));
      }

      writer.write({ type: "text-end", id: textBlockId });

      const filteredCitations = mockCitations.filter((c) =>
        response.includes(c.fileName)
      );

      for (const citation of filteredCitations) {
        writer.write({
          type: "data-citation",
          data: {
            sourceId: citation.documentId,
            fileName: citation.fileName,
            text: citation.text,
            score: citation.score,
          },
        });
      }

      // Save history
      const historyId = await saveHistory(
        sessionId,
        ownerId,
        query,
        fullText,
        filteredCitations,
        createdAt,
        redoHistoryId
      );

      // Send session info
      writer.write({
        type: "data-session-info",
        data: {
          sessionId,
          historyId,
          createdAt,
        },
      });
    },
  });

  await pipeToLambdaStream(
    uiStream as unknown as ReadableStream<string | object>,
    lambdaStream
  );
}

/**
 * AI SDK の ReadableStream を Lambda ストリームに書き込む
 * createUIMessageStream はオブジェクトを返すため、SSE形式の文字列に変換する
 */
async function pipeToLambdaStream(
  uiStream: ReadableStream<string | object>,
  lambdaStream: StreamWriter
): Promise<void> {
  const reader = uiStream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        // value が文字列の場合はそのまま、オブジェクトの場合はSSE形式に変換
        if (typeof value === "string") {
          lambdaStream.write(value);
        } else {
          // SSE形式: data: {json}\n\n
          lambdaStream.write(`data: ${JSON.stringify(value)}\n\n`);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function saveHistory(
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

  await Promise.all([
    docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: `SESSION#${sessionId}`, sk: "META" },
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
      })
    ),
    docClient.send(
      new PutCommand({
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
      })
    ),
  ]);

  return historyId;
}

// ============================================
// Utilities
// ============================================

function extractQuery(body: ChatStreamRequestDto): string {
  const lastMessage = body.messages
    .slice()
    .reverse()
    .find((m) => m.role === "user");

  if (!lastMessage?.parts) {
    throw new AppError(400, ErrorCode.MISSING_PARAMETER);
  }

  const isTextPart = (p: unknown): p is TextUIPartDto =>
    typeof p === "object" && p !== null && (p as TextUIPartDto).type === "text";

  const text = lastMessage.parts
    .filter(isTextPart)
    .map((p) => p.text)
    .join("");

  if (!text) {
    throw new AppError(400, ErrorCode.MISSING_PARAMETER);
  }

  return text;
}

function handleError(
  stream: StreamWriter,
  error: unknown,
  ownerId: string,
  sessionId: string
): void {
  logger("ERROR", "Chat stream failed", {
    error: error instanceof Error ? error.message : String(error),
    ownerId,
    sessionId,
  });

  const code =
    error instanceof AppError
      ? error.errorCode
      : ErrorCode.INTERNAL_SERVER_ERROR;

  // AI SDK 6+ エラー形式で送信
  stream.write(
    `data: ${JSON.stringify({ type: "error", errorText: code || "INTERNAL_SERVER_ERROR" })}\n\n`
  );
  stream.write("data: [DONE]\n\n");
}
