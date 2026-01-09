import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent } from "aws-lambda";

import {
  DeleteSessionResponseDto,
  GetSessionMessagesQueryParamsDto,
  GetSessionMessagesResponseDto,
  GetSessionsResponseDto,
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
import {
  apiHandler,
  AppError,
  validateJson,
} from "../../shared/utils/api-handler";
import { toMessageDTO, toSessionDTO } from "../../shared/utils/dto-mapper";
import {
  createDynamoDBClient,
  decodeCursor,
  encodeCursor,
} from "../../shared/utils/dynamodb";

const TABLE_NAME = process.env.TABLE_NAME!;
const IS_LOCAL_STAGE = process.env.STAGE! === "local";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

const docClient = createDynamoDBClient();

/**
 * 非ストリーミングChat APIハンドラー
 * - GET /chat/sessions
 * - GET /chat/sessions/{sessionId}
 * - PATCH /chat/sessions/{sessionId}
 * - DELETE /chat/sessions/{sessionId}
 * - POST /chat/feedback
 */
export const handler = apiHandler(async (event: APIGatewayProxyEvent) => {
  const { httpMethod, path, queryStringParameters } = event;

  const ownerId = extractOwnerId(event);

  if (httpMethod === "POST" && path === "/chat/feedback") {
    const body = validateJson<SubmitFeedbackRequestDto>(
      event.body,
      SubmitFeedbackRequestSchema
    );
    return await submitFeedback(body, ownerId);
  }

  if (httpMethod === "GET" && path === "/chat/sessions") {
    return await getSessions(ownerId);
  }

  if (path.startsWith("/chat/sessions/")) {
    const parts = path.split("/");
    const sessionId = parts[3];

    if (!sessionId) {
      throw new AppError(400, ErrorCode.MISSING_PARAMETER);
    }

    if (httpMethod === "GET") {
      return await getSessionMessages(
        sessionId,
        ownerId,
        (queryStringParameters || {}) as GetSessionMessagesQueryParamsDto
      );
    }

    if (httpMethod === "PATCH") {
      const body = validateJson<UpdateSessionNameRequestDto>(
        event.body,
        UpdateSessionNameRequestSchema
      );
      return await updateSessionName(sessionId, ownerId, body.sessionName);
    }

    if (httpMethod === "DELETE") {
      return await deleteSession(sessionId, ownerId);
    }
  }

  throw new AppError(404);
});

/**
 * ユーザーID抽出
 */
function extractOwnerId(event: APIGatewayProxyEvent): string {
  if (IS_LOCAL_STAGE) {
    return "user-001";
  }

  const claims = event.requestContext?.authorizer?.claims;
  const ownerId = claims?.sub;

  if (!ownerId) {
    throw new AppError(401, ErrorCode.PERMISSION_DENIED);
  }

  return ownerId;
}

/**
 * フィードバック送信
 */
async function submitFeedback(
  body: SubmitFeedbackRequestDto,
  ownerId: string
): Promise<SubmitFeedbackResponseDto> {
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

  const result = await docClient.send(command);
  const updatedItem = result.Attributes as ChatMessageEntity;

  return {
    item: toMessageDTO(updatedItem),
  };
}

/**
 * セッション一覧取得
 */
async function getSessions(ownerId: string): Promise<GetSessionsResponseDto> {
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

  return {
    sessions: sessions.map((s) => toSessionDTO(s)),
  };
}

/**
 * セッションメッセージ取得
 */
async function getSessionMessages(
  sessionId: string,
  ownerId: string,
  queryParams: GetSessionMessagesQueryParamsDto
): Promise<GetSessionMessagesResponseDto> {
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

  if (items.length === 0 || items[0].ownerId !== ownerId) {
    throw new AppError(404);
  }

  const nextCursor = response.LastEvaluatedKey
    ? encodeCursor(response.LastEvaluatedKey)
    : undefined;

  return {
    sessionId,
    messages: items.map((m) => toMessageDTO(m)),
    nextCursor,
  };
}

/**
 * セッション名更新
 */
async function updateSessionName(
  sessionId: string,
  ownerId: string,
  sessionName: string
): Promise<UpdateSessionNameResponseDto> {
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

  const result = await docClient.send(command);
  const updatedSession = result.Attributes as ChatSessionEntity;

  return {
    session: toSessionDTO(updatedSession),
  };
}

/**
 * セッション削除
 */
async function deleteSession(
  sessionId: string,
  ownerId: string
): Promise<DeleteSessionResponseDto> {
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
  });

  await docClient.send(command);

  return { sessionId };
}
