#!/bin/bash
# localstack-init/init-localstack.sh
# LocalStack起動時に自動実行される初期化スクリプト

set -e

echo "=========================================="
echo "LocalStack 初期化開始"
echo "=========================================="

# エンドポイント設定（コンテナ内から自身を参照）
export AWS_ACCESS_KEY_ID=local
export AWS_SECRET_ACCESS_KEY=local
export AWS_DEFAULT_REGION=us-east-1
ENDPOINT="http://localhost:4566"

# awslocal コマンドの代わりに関数を定義
# これにより awslocal がない環境でも aws コマンドで代用可能
function awslocal() {
    aws --endpoint-url=${ENDPOINT} "$@"
}

# ----------------------------------------
# S3バケット作成
# ----------------------------------------
echo "Creating S3 buckets..."

# ドキュメント保存用バケット
awslocal s3 mb s3://dev-documents-bucket || true
echo "✅ Created: dev-documents-bucket"

# CORS設定
awslocal s3api put-bucket-cors --bucket dev-documents-bucket --cors-configuration '{
  "CORSRules": [
    {
      "AllowedHeaders": ["*"],
      "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
      "AllowedOrigins": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3000
    }
  ]
}'
echo "✅ CORS configured for dev-documents-bucket"

# ----------------------------------------
# Secrets Manager（Pinecone API Key用）
# ----------------------------------------
echo "Creating Secrets..."

# Pinecone API Key（ダミー値）
awslocal secretsmanager create-secret \
  --name pinecone-api-key \
  --secret-string '{"apiKey":"your-pinecone-api-key-here"}' || true
echo "✅ Created: pinecone-api-key secret"

# ----------------------------------------
# SQS キュー
# ----------------------------------------
echo "Creating SQS queues..."

awslocal sqs create-queue --queue-name dev-document-processing-queue || true
echo "✅ Created: dev-document-processing-queue"

# Dead Letter Queue
awslocal sqs create-queue --queue-name dev-document-processing-dlq || true
echo "✅ Created: dev-document-processing-dlq"

# ----------------------------------------
# IAMロール（Lambda用）
# ----------------------------------------
echo "Creating IAM roles..."

awslocal iam create-role \
  --role-name dev-lambda-execution-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Principal": {
          "Service": "lambda.amazonaws.com"
        },
        "Action": "sts:AssumeRole"
      }
    ]
  }' || true
echo "✅ Created: dev-lambda-execution-role"

echo "=========================================="
echo "LocalStack 初期化完了"
echo "=========================================="

# 確認
echo ""
echo "📦 S3 Buckets:"
awslocal s3 ls

echo ""
echo "🔐 Secrets:"
awslocal secretsmanager list-secrets --query 'SecretList[].Name' --output table

echo ""
echo "📬 SQS Queues:"
awslocal sqs list-queues --query 'QueueUrls' --output table