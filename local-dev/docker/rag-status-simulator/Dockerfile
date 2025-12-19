# docker/dynamodb-streams-worker/Dockerfile
# DynamoDB Streamsをエミュレートするワーカー

FROM node:22-alpine

WORKDIR /app

# パッケージファイルをコピー
COPY package*.json ./

# 依存関係インストール
RUN npm install

# ソースコードをコピー
COPY src ./src

# ヘルスチェック用
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "console.log('healthy')" || exit 1

# 実行
CMD ["npm", "start"]