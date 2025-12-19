#!/bin/bash
set -e
set -x

ENDPOINT_URL="http://dynamodb-local:8000"
REGION="us-east-1"

# 起動待機処理
echo "Waiting for DynamoDB Local..."
for i in {1..30}; do
  if aws dynamodb list-tables --endpoint-url $ENDPOINT_URL --region $REGION > /dev/null 2>&1; then
    echo "DynamoDB Local is ready."
    break
  fi
  echo "Waiting... ($i/30)"
  sleep 2
done

# DocumentTable作成
echo "Creating DocumentTable..."
aws dynamodb create-table \
    --cli-input-json file:///init-configs/document-table-config.json \
    --endpoint-url $ENDPOINT_URL \
    --region $REGION

echo "DocumentTable created."

# ChatHistoryTable作成
echo "Creating ChatHistoryTable..."
aws dynamodb create-table \
    --cli-input-json file:///init-configs/chat-table-config.json \
    --endpoint-url $ENDPOINT_URL \
    --region $REGION

echo "ChatHistoryTable created."
echo "All tables created successfully."