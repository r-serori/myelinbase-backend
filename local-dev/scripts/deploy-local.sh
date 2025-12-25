#!/bin/bash
set -e

# ==========================================
# LocalStackデプロイスクリプト
# template-local.yaml を使用（Cognito完全除外版）
# ==========================================

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$SCRIPT_DIR/../../"
INFRA_DIR="$PROJECT_ROOT/infrastructure"

# ---------------------------------------------------
# 0. LocalStack起動確認
# ---------------------------------------------------
echo "🔍 Checking LocalStack availability..."
if ! curl -s http://127.0.0.1:4566/_localstack/health > /dev/null; then
    echo "❌ Error: LocalStack is not reachable at http://127.0.0.1:4566"
    echo "💡 Please ensure you have run 'npm run local:start' and the container is running."
    exit 1
fi
echo "✅ LocalStack is up and running!"

# ---------------------------------------------------
# 1. 環境変数による強制
# ---------------------------------------------------
export AWS_ENDPOINT_URL="http://127.0.0.1:4566"
export AWS_ACCESS_KEY_ID=local
export AWS_SECRET_ACCESS_KEY=local
export AWS_DEFAULT_REGION=us-east-1
export AWS_PAGER=""

# ---------------------------------------------------
# 2. Configファイルによる強制 & 互換性設定
# ---------------------------------------------------
export AWS_CONFIG_FILE=$(mktemp)
trap "rm -f $AWS_CONFIG_FILE" EXIT

cat <<EOF > $AWS_CONFIG_FILE
[default]
region = us-east-1
output = json
endpoint_url = http://127.0.0.1:4566
request_checksum_calculation = when_required
response_checksum_validation = when_required
s3 =
    endpoint_url = http://127.0.0.1:4566
    addressing_style = path
services = local-services

[services local-services]
s3 =
    endpoint_url = http://127.0.0.1:4566
cloudformation =
    endpoint_url = http://127.0.0.1:4566
lambda =
    endpoint_url = http://127.0.0.1:4566
EOF

# ---------------------------------------------------
# 3. ローカル専用テンプレートでビルド
# ---------------------------------------------------
echo "🚀 Building SAM application with template-local.yaml..."
cd $INFRA_DIR

# ローカル専用テンプレートの存在確認
if [ ! -f "template-local.yaml" ]; then
    echo "❌ Error: template-local.yaml not found in infrastructure/"
    echo "💡 Please create template-local.yaml for local development."
    exit 1
fi

sam build --template-file template-local.yaml

# ---------------------------------------------------
# 4. パッケージング
# ---------------------------------------------------
echo "📦 Packaging for LocalStack..."

# バケット作成
aws s3 mb s3://lambda-deploy-bucket 2>/dev/null || true

# パッケージング
aws cloudformation package \
  --template-file .aws-sam/build/template.yaml \
  --s3-bucket lambda-deploy-bucket \
  --output-template-file packaged-local.yaml \
  --region us-east-1

# ---------------------------------------------------
# 5. デプロイ
# ---------------------------------------------------
echo "🚀 Deploying to LocalStack..."

set +e # エラー即終了を一時的に無効化

aws cloudformation deploy \
  --template-file packaged-local.yaml \
  --stack-name myelinbase-local \
  --region us-east-1 \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ProjectName=myelinbase \
    FrontendUrl="http://localhost:3001" \
    DynamoDBEndpoint="http://dynamodb-local:8000" \
    S3Endpoint="http://localstack:4566" \
    LocalstackEndpoint="http://localstack:4566" \
    UseBedrock="false"

DEPLOY_STATUS=$?
set -e

if [ $DEPLOY_STATUS -ne 0 ]; then
    echo "❌ Deployment Failed!"
    echo "---------------------------------------------------"
    echo "🔍 Fetching stack events to diagnose the issue..."
    echo "---------------------------------------------------"
    aws cloudformation describe-stack-events \
      --stack-name myelinbase-local \
      --endpoint-url http://127.0.0.1:4566 \
      --output table
    exit 1
fi

# ---------------------------------------------------
# 6. 完了
# ---------------------------------------------------
echo ""
echo "✅ Deployment Complete!"
echo "---------------------------------------------------"
echo "Stack Outputs:"
aws cloudformation describe-stacks \
  --stack-name myelinbase-local \
  --endpoint-url http://127.0.0.1:4566 \
  --query 'Stacks[0].Outputs' \
  --output table

echo ""
echo "📋 ローカル開発情報:"
echo "---------------------------------------------------"
echo "API Endpoint: http://localhost:4566/restapis/<api-id>/local/_user_request_/"
echo "DynamoDB Admin: http://localhost:8001"
echo "認証: バイパス（user-001 として自動認証）"
echo "---------------------------------------------------"


echo "🔍 API IDを取得中..."

# 1. API IDを取得 (プロジェクト名に合わせて name を調整してください)
API_NAME="myelinbase-local-api"
API_ID=$(awslocal apigateway get-rest-apis --query "items[?name=='$API_NAME'].id" --output text)

# IDが取れなかった場合のエラーハンドリング
if [ -z "$API_ID" ] || [ "$API_ID" == "None" ]; then
  echo "❌ エラー: API IDが見つかりませんでした。デプロイが失敗している可能性があります。"
  exit 1
fi

# 2. LocalStack用の正しいURLを組み立てる
NEW_API_URL="http://localhost:4566/restapis/$API_ID/local/_user_request_"

echo "✅ 新しいAPIエンドポイント: $NEW_API_URL"

# 3. Frontendの .env.local を更新する
# PROJECT_ROOTは myelinbase-backend/ なので、その親ディレクトリから frontend/ にアクセス
FRONTEND_ENV_FILE="$PROJECT_ROOT/../frontend/.env.local"

echo "📝 Frontendの設定ファイルを更新中: $FRONTEND_ENV_FILE"

# ファイルが存在しない場合は新規作成
if [ ! -f "$FRONTEND_ENV_FILE" ]; then
    echo "NEXT_PUBLIC_API_BASE_URL=\"$NEW_API_URL\"" > "$FRONTEND_ENV_FILE"
    echo "✨ ファイルを新規作成しました。"
else
    # 該当の変数がファイル内に既に存在するか確認
    if grep -q "NEXT_PUBLIC_API_BASE_URL=" "$FRONTEND_ENV_FILE"; then
        # 存在する場合: その行だけを置換 (sedを使用)
        # URL内のスラッシュとの干渉を避けるため、区切り文字に '|' を使用
        # クロスプラットフォーム対応のため、一時ファイルを作成して mv する方式を採用
        sed "s|NEXT_PUBLIC_API_BASE_URL=.*|NEXT_PUBLIC_API_BASE_URL=\"$NEW_API_URL\"|" "$FRONTEND_ENV_FILE" > "${FRONTEND_ENV_FILE}.tmp" && mv "${FRONTEND_ENV_FILE}.tmp" "$FRONTEND_ENV_FILE"
        echo "🔄 既存の NEXT_PUBLIC_API_BASE_URL を更新しました。"
    else
        # 存在しない場合: 末尾に追記
        # 末尾に改行がない場合を考慮して一度改行を入れる
        echo "" >> "$FRONTEND_ENV_FILE"
        echo "NEXT_PUBLIC_API_BASE_URL=\"$NEW_API_URL\"" >> "$FRONTEND_ENV_FILE"
        echo "➕ NEXT_PUBLIC_API_BASE_URL を追記しました。"
    fi
fi

echo "🎉 完了! 反映のためにFrontendサーバーを再起動してください。"

# ---------------------------------------------------
# 7. S3イベント通知設定（Lambda トリガー）
# ---------------------------------------------------
echo ""
echo "🔗 S3イベント通知を設定中..."

# Lambda関数のARNを取得
TRIGGER_FUNCTION_NAME="myelinbase-local-trigger"
TRIGGER_FUNCTION_ARN=$(awslocal lambda get-function --function-name $TRIGGER_FUNCTION_NAME --query 'Configuration.FunctionArn' --output text 2>/dev/null || echo "")

if [ -z "$TRIGGER_FUNCTION_ARN" ] || [ "$TRIGGER_FUNCTION_ARN" == "None" ]; then
  echo "⚠️  警告: Lambda関数 $TRIGGER_FUNCTION_NAME が見つかりません。S3トリガーは設定されませんでした。"
else
  echo "📍 Lambda ARN: $TRIGGER_FUNCTION_ARN"
  
  # S3バケット通知設定
  BUCKET_NAME="myelinbase-local-docs"
  
  awslocal s3api put-bucket-notification-configuration \
    --bucket $BUCKET_NAME \
    --notification-configuration '{
      "LambdaFunctionConfigurations": [
        {
          "Id": "TriggerOnUpload",
          "LambdaFunctionArn": "'"$TRIGGER_FUNCTION_ARN"'",
          "Events": ["s3:ObjectCreated:*"],
          "Filter": {
            "Key": {
              "FilterRules": [
                {
                  "Name": "prefix",
                  "Value": "uploads/"
                }
              ]
            }
          }
        }
      ]
    }'
  
  echo "✅ S3イベント通知を設定しました: $BUCKET_NAME → $TRIGGER_FUNCTION_NAME"
  
  # 設定確認
  echo ""
  echo "📋 S3通知設定の確認:"
  awslocal s3api get-bucket-notification-configuration --bucket $BUCKET_NAME
fi