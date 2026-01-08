/**
 * CORSヘッダー生成ユーティリティ
 * * 環境変数 ALLOWED_ORIGINS にカンマ区切りで許可するドメインを指定します。
 * 例: "https://myapp.com,http://localhost:3000"
 */

// 環境変数から許可オリジンを読み込み、空文字列を除外
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter((o) => o.length > 0);

export interface CorsHeaders {
  "Access-Control-Allow-Origin": string;
  "Access-Control-Allow-Credentials"?: boolean;
  "Access-Control-Allow-Headers": string;
  "Access-Control-Allow-Methods": string;
}

export function getCorsHeaders(origin: string): CorsHeaders | undefined {
  if (!origin && ALLOWED_ORIGINS.includes("*")) {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
      "Access-Control-Allow-Methods": "OPTIONS,POST,GET,PATCH,DELETE",
    };
  }

  if (ALLOWED_ORIGINS.includes("*")) {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
      "Access-Control-Allow-Methods": "OPTIONS,POST,GET,PATCH,DELETE",
    };
  }

  if (ALLOWED_ORIGINS.includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": true,
      "Access-Control-Allow-Headers":
        "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
      "Access-Control-Allow-Methods": "OPTIONS,POST,GET,PATCH,DELETE",
    };
  }

  return undefined;
}
