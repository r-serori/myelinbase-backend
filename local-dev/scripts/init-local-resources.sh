#!/bin/bash
set -e

ENDPOINT_URL="http://dynamodb-local:8000"
REGION="us-east-1"

# テーブル名（template.yamlのローカル環境と一致させる）
DOCUMENT_TABLE="myelinbase-local-documents"
CHAT_TABLE="myelinbase-local-chat-history"

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

# ----------------------------------------
# DocumentTable作成
# ----------------------------------------
echo "Creating DocumentTable: ${DOCUMENT_TABLE}..."

aws dynamodb create-table \
    --table-name "${DOCUMENT_TABLE}" \
    --attribute-definitions \
        AttributeName=documentId,AttributeType=S \
        AttributeName=ownerId,AttributeType=S \
        AttributeName=fileName,AttributeType=S \
        AttributeName=createdAt,AttributeType=S \
    --key-schema \
        AttributeName=documentId,KeyType=HASH \
    --global-secondary-indexes \
        "[
            {
                \"IndexName\": \"OwnerIndex\",
                \"KeySchema\": [{\"AttributeName\":\"ownerId\",\"KeyType\":\"HASH\"},{\"AttributeName\":\"createdAt\",\"KeyType\":\"RANGE\"}],
                \"Projection\": {\"ProjectionType\":\"ALL\"},
                \"ProvisionedThroughput\": {\"ReadCapacityUnits\":5,\"WriteCapacityUnits\":5}
            },
            {
                \"IndexName\": \"FileNameIndex\",
                \"KeySchema\": [{\"AttributeName\":\"ownerId\",\"KeyType\":\"HASH\"},{\"AttributeName\":\"fileName\",\"KeyType\":\"RANGE\"}],
                \"Projection\": {\"ProjectionType\":\"KEYS_ONLY\"},
                \"ProvisionedThroughput\": {\"ReadCapacityUnits\":5,\"WriteCapacityUnits\":5}
            }
        ]" \
    --provisioned-throughput ReadCapacityUnits=5,WriteCapacityUnits=5 \
    --stream-specification StreamEnabled=true,StreamViewType=NEW_AND_OLD_IMAGES \
    --endpoint-url $ENDPOINT_URL \
    --region $REGION \
    2>/dev/null || echo "⚠️  DocumentTable already exists (skipped)"

echo "✅ DocumentTable ready: ${DOCUMENT_TABLE}"

# ----------------------------------------
# ChatHistoryTable作成
# ----------------------------------------
echo "Creating ChatHistoryTable: ${CHAT_TABLE}..."

aws dynamodb create-table \
    --table-name "${CHAT_TABLE}" \
    --attribute-definitions \
        AttributeName=pk,AttributeType=S \
        AttributeName=sk,AttributeType=S \
        AttributeName=gsi1pk,AttributeType=S \
        AttributeName=gsi1sk,AttributeType=S \
    --key-schema \
        AttributeName=pk,KeyType=HASH \
        AttributeName=sk,KeyType=RANGE \
    --global-secondary-indexes \
        "[
            {
                \"IndexName\": \"GSI1\",
                \"KeySchema\": [{\"AttributeName\":\"gsi1pk\",\"KeyType\":\"HASH\"},{\"AttributeName\":\"gsi1sk\",\"KeyType\":\"RANGE\"}],
                \"Projection\": {\"ProjectionType\":\"ALL\"},
                \"ProvisionedThroughput\": {\"ReadCapacityUnits\":5,\"WriteCapacityUnits\":5}
            }
        ]" \
    --provisioned-throughput ReadCapacityUnits=5,WriteCapacityUnits=5 \
    --endpoint-url $ENDPOINT_URL \
    --region $REGION \
    2>/dev/null || echo "⚠️  ChatHistoryTable already exists (skipped)"

echo "✅ ChatHistoryTable ready: ${CHAT_TABLE}"

echo ""
echo "=========================================="
echo "All DynamoDB tables created successfully!"
echo "=========================================="
echo ""
echo "Tables:"
aws dynamodb list-tables --endpoint-url $ENDPOINT_URL --region $REGION --output table