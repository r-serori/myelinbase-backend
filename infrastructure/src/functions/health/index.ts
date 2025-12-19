// src/functions/health/index.ts
// Health Check Lambda Function

import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify({
      status: "healthy",
      timestamp: new Date().toISOString(),
      service: "portfolio-rag-api",
    }),
  };
};
