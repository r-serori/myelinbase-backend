#!/bin/bash
# localstack-init/init-localstack.sh
# LocalStack起動時に自動実行される初期化スクリプト

set -e

echo "=========================================="
echo "LocalStack 初期化開始"
echo "=========================================="

# エンドポイント設定
export AWS_ACCESS_KEY_ID=local
export AWS_SECRET_ACCESS_KEY=local
export AWS_DEFAULT_REGION=ap-northeast-1
ENDPOINT="http://localhost:4566"

function awslocal() {
    aws --endpoint-url=${ENDPOINT} "$@"
}

# ----------------------------------------
# S3バケット作成
# ----------------------------------------
echo "Creating S3 buckets..."

# デプロイ用バケット
awslocal s3 mb s3://lambda-deploy-bucket 2>/dev/null || true
echo "✅ Created: lambda-deploy-bucket"

# ドキュメント用バケット（ローカル環境用）
awslocal s3 mb s3://myelinbase-local-docs 2>/dev/null || true
echo "✅ Created: myelinbase-local-docs"

# CORS設定
awslocal s3api put-bucket-cors --bucket myelinbase-local-docs --cors-configuration '{
  "CORSRules": [
    {
      "AllowedHeaders": ["*"],
      "AllowedMethods": ["PUT", "POST", "GET", "DELETE", "HEAD"],
      "AllowedOrigins": ["http://localhost:3000", "http://localhost:3001"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3000
    }
  ]
}'
echo "✅ CORS configured for myelinbase-local-docs"

# ----------------------------------------
# Secrets Manager (ダミーシークレット)
# ----------------------------------------
echo "Creating Secrets Manager secrets..."

# Pinecone API Key (ダミー)
awslocal secretsmanager create-secret \
    --name pinecone-api-key \
    --secret-string '{"apiKey":"local-dummy-pinecone-key"}' 2>/dev/null || \
awslocal secretsmanager put-secret-value \
    --secret-id pinecone-api-key \
    --secret-string '{"apiKey":"local-dummy-pinecone-key"}'

echo "✅ Created: pinecone-api-key secret"

echo "=========================================="
echo "LocalStack 初期化完了"
echo "=========================================="
echo ""
echo "📋 ローカル環境設定:"
echo "--------------------------------------------------"
echo "S3 Endpoint      : http://localhost:4566"
echo "DynamoDB Endpoint: http://localhost:8000"
echo "Region           : ap-northeast-1"
echo "--------------------------------------------------"
echo ""
echo "🔐 認証について:"
echo "ローカル環境ではCognito認証はバイパスされます。"
echo "Lambda関数は自動的にモックユーザー(user-001)を使用します。"
echo "--------------------------------------------------"