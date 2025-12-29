#!/bin/bash
# LocalStack Lambda関数のログを取得するスクリプト

set -e

FUNCTION_NAME="${1:-myelinbase-local-documents}"
FOLLOW="${2:-false}"

export AWS_ENDPOINT_URL="http://127.0.0.1:4566"
export AWS_ACCESS_KEY_ID=local
export AWS_SECRET_ACCESS_KEY=local
export AWS_DEFAULT_REGION=us-east-1

echo "🔍 Fetching logs for Lambda function: $FUNCTION_NAME"
echo "---------------------------------------------------"
echo ""
echo "⚠️  注意: LocalStackでは、Lambda関数のログがCloudWatch Logsに正しく保存されない場合があります。"
echo "   実際のログを確認するには、LocalStackコンテナのログを直接確認してください。"
echo ""
echo "📋 推奨されるログ確認方法:"
echo "   1. LocalStackコンテナのログを確認:"
echo "      npm run local:logs:localstack"
echo ""
echo "   2. Documents関数関連のエラーログをフィルタリング:"
echo "      npm run local:logs:documents"
echo ""
echo "   3. すべてのコンテナのログを確認:"
echo "      npm run local:logs"
echo ""
echo "---------------------------------------------------"
echo ""

# ロググループ名を構築
LOG_GROUP_NAME="/aws/lambda/$FUNCTION_NAME"

# ロググループが存在するか確認
LOG_GROUPS=$(aws logs describe-log-groups \
  --log-group-name-prefix "$LOG_GROUP_NAME" \
  --endpoint-url "$AWS_ENDPOINT_URL" \
  --query "logGroups[?logGroupName=='$LOG_GROUP_NAME']" \
  --output text 2>/dev/null || echo "")

if [ -z "$LOG_GROUPS" ]; then
  echo "⚠️  Log group not found: $LOG_GROUP_NAME"
  echo "💡 The function may not have been invoked yet, or logs may not be available."
  echo ""
  echo "Available log groups:"
  aws logs describe-log-groups \
    --endpoint-url "$AWS_ENDPOINT_URL" \
    --query "logGroups[*].logGroupName" \
    --output table 2>/dev/null || echo "No log groups found"
  echo ""
  echo "💡 Tip: LocalStackではLambda関数のログがCloudWatch Logsに保存されない場合があります。"
  echo "   代わりに、LocalStackコンテナのログを確認してください:"
  echo "   npm run local:logs:localstack"
  exit 1
fi

# ログストリームを取得
echo "📋 Available log streams:"
aws logs describe-log-streams \
  --log-group-name "$LOG_GROUP_NAME" \
  --endpoint-url "$AWS_ENDPOINT_URL" \
  --order-by LastEventTime \
  --descending \
  --max-items 5 \
  --query "logStreams[*].[logStreamName, lastEventTime]" \
  --output table 2>/dev/null || echo "No log streams found"

echo ""
echo "📜 Attempting to fetch log events..."
echo "---------------------------------------------------"

# 最新のログストリームを取得
LATEST_STREAM=$(aws logs describe-log-streams \
  --log-group-name "$LOG_GROUP_NAME" \
  --endpoint-url "$AWS_ENDPOINT_URL" \
  --order-by LastEventTime \
  --descending \
  --max-items 1 \
  --query "logStreams[0].logStreamName" \
  --output text 2>/dev/null)

if [ -z "$LATEST_STREAM" ] || [ "$LATEST_STREAM" = "None" ]; then
  echo "⚠️  No log streams found"
  echo ""
  echo "💡 LocalStackでは、Lambda関数のログがCloudWatch Logsに保存されない場合があります。"
  echo "   実際のログを確認するには、LocalStackコンテナのログを直接確認してください:"
  echo "   npm run local:logs:localstack"
  exit 1
fi

# ログイベントを取得（過去1時間）
START_TIME=$(($(date +%s) * 1000 - 3600000))
END_TIME=$(($(date +%s) * 1000))

LOG_EVENTS=$(aws logs get-log-events \
  --log-group-name "$LOG_GROUP_NAME" \
  --log-stream-name "$LATEST_STREAM" \
  --endpoint-url "$AWS_ENDPOINT_URL" \
  --start-time "$START_TIME" \
  --end-time "$END_TIME" \
  --query "events[*].[timestamp,message]" \
  --output text 2>/dev/null || echo "")

if [ -z "$LOG_EVENTS" ]; then
  echo "⚠️  No log events found in CloudWatch Logs"
  echo ""
  echo "💡 LocalStackでは、Lambda関数のログがCloudWatch Logsに保存されない場合があります。"
  echo "   実際のログを確認するには、LocalStackコンテナのログを直接確認してください:"
  echo "   npm run local:logs:localstack | grep -i 'error\\|ERROR\\|documents'"
  exit 1
fi

echo "$LOG_EVENTS" | while read -r timestamp message; do
  if [ -n "$timestamp" ] && [ -n "$message" ]; then
    # タイムスタンプを読みやすい形式に変換
    date_str=$(date -r $((timestamp / 1000)) "+%Y-%m-%d %H:%M:%S" 2>/dev/null || echo "$timestamp")
    echo "[$date_str] $message"
  fi
done

echo ""
echo "💡 To see real-time logs, check LocalStack container logs:"
echo "   npm run local:logs:localstack | grep -i 'error\\|ERROR\\|documents'"

