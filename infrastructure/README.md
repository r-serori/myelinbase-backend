# **インフラストラクチャ構成 (template.yaml)**

このプロジェクトは AWS SAM (Serverless Application Model) を使用してデプロイされるサーバーレスアーキテクチャです。

## **アーキテクチャ図 (Mermaid)**

graph TB  
    %% クライアント  
    Client\[Client (Frontend)\]

    %% 外部コンポーネント  
    CognitoUser\[Cognito User\]  
      
    subgraph "AWS Cloud (Myelin Base Backend)"  
        %% API Gateway  
        APIGW\[("API Gateway\<br/\>(ManagementApiGateway)")\]

        %% 認証  
        subgraph Auth \[Authentication\]  
            UserPool\[("Cognito User Pool")\]  
            UserPoolClient\[("Cognito User Pool Client")\]  
            UserPoolDomain\[("Cognito User Pool Domain")\]  
        end

        %% Lambda Functions  
        subgraph Lambdas \[Lambda Functions\]  
            DocFn\["Documents Function\<br/\>(Node.js 22.x)"\]  
            ChatFn\["Chat Agent Function\<br/\>(Node.js 22.x)\<br/\>Streaming URL"\]  
            TriggerFn\["Ingestion Trigger Function\<br/\>(Node.js 22.x)"\]  
            ProcFn\["Doc Processor Function\<br/\>(Node.js 22.x)"\]  
            HealthFn\["Health Check Function\<br/\>(Node.js 22.x)"\]  
        end

        %% ストレージ & DB  
        subgraph Storage \[Data Store\]  
            S3Bucket\[("S3 Bucket\<br/\>(DocumentsBucket)")\]  
            DocTable\[("DynamoDB\<br/\>(DocumentTable)")\]  
            ChatTable\[("DynamoDB\<br/\>(ChatHistoryTable)")\]  
        end

        %% ワークフロー  
        subgraph Workflow \[Orchestration\]  
            SFN\["Step Functions\<br/\>(RagIngestionStateMachine)"\]  
        end  
          
        %% 外部AIサービス連携 (AWS内からの呼び出し)  
        subgraph ExternalAI \[AI Services\]  
            Bedrock\[("AWS Bedrock\<br/\>(Claude 3 Haiku / Titan Embeddings)")\]  
            Pinecone\[("Pinecone\<br/\>(Vector Database)")\]  
            Secrets\[("Secrets Manager\<br/\>(Pinecone API Key)")\]  
        end  
    end

    %% 接続関係

    %% 1\. 認証フロー  
    Client \--\>|Auth| UserPool  
    Client \--\>|Auth| UserPoolClient  
    UserPoolClient \-.-\> UserPoolDomain  
    APIGW \-.-\>|Authorizer| UserPool

    %% 2\. API Gateway 経由のアクセス  
    Client \--\>|REST API /documents| APIGW  
    Client \--\>|REST API /health| APIGW  
      
    APIGW \--\>|Invoke| DocFn  
    APIGW \--\>|Invoke| HealthFn

    %% 3\. Chat Agent (Function URL)  
    Client \--\>|Streaming API /chat| ChatFn

    %% 4\. ドキュメント管理フロー  
    DocFn \--\>|Metadata CRUD| DocTable  
    DocFn \--\>|Presigned URL| S3Bucket

    %% 5\. データ取り込みフロー (S3 Trigger)  
    Client \--\>|Direct Upload| S3Bucket  
    S3Bucket \--\>|s3:ObjectCreated| TriggerFn  
    TriggerFn \--\>|Start Execution| SFN

    %% 6\. Step Functions 処理フロー  
    SFN \--\>|Task: UpdateStatus| ProcFn  
    SFN \--\>|Task: Extract & Chunk| ProcFn  
    SFN \--\>|Task: Embed & Upsert| ProcFn

    %% 7\. Processor Function の依存関係  
    ProcFn \--\>|Read File| S3Bucket  
    ProcFn \--\>|Update Status| DocTable  
    ProcFn \--\>|Generate Embedding| Bedrock  
    ProcFn \--\>|Get API Key| Secrets  
    ProcFn \--\>|Upsert Vectors| Pinecone

    %% 8\. Chat Function の依存関係  
    ChatFn \--\>|Save History| ChatTable  
    ChatFn \--\>|Generate Response| Bedrock  
    ChatFn \--\>|Get API Key| Secrets  
    ChatFn \--\>|Search Vectors| Pinecone  
    ChatFn \--\>|Read Metadata| DocTable

    %% スタイル定義  
    classDef aws fill:\#FF9900,stroke:\#232F3E,stroke-width:2px,color:white;  
    classDef db fill:\#3B48CC,stroke:\#232F3E,stroke-width:2px,color:white;  
    classDef storage fill:\#3F8624,stroke:\#232F3E,stroke-width:2px,color:white;  
    classDef ai fill:\#C925D1,stroke:\#232F3E,stroke-width:2px,color:white;  
      
    class APIGW,SFN,UserPool,UserPoolClient,UserPoolDomain aws;  
    class DocTable,ChatTable db;  
    class S3Bucket storage;  
    class Bedrock,Pinecone ai;

## **リソース詳細**

### **Compute (Lambda)**

* **ChatAgentFunction**: ユーザーとの対話、RAG検索、回答生成を行う。Function URLを使用してストリーミングレスポンスを実現。  
* **DocumentsFunction**: ドキュメントのCRUD操作、署名付きURLの発行。  
* **IngestionTriggerFunction**: S3へのアップロード検知し、Step Functionsを起動。  
* **DocProcessorFunction**: Step Functionsから呼び出され、テキスト抽出・Embedding・Pinecone登録を実行するワーカー。  
* **HealthCheckFunction**: 死活監視用。

### **Storage**

* **DocumentTable (DynamoDB)**: ドキュメントのメタデータ（ファイル名、ステータス、S3キーなど）を管理。  
* **ChatHistoryTable (DynamoDB)**: チャットセッションとメッセージ履歴を管理。  
* **DocumentsBucket (S3)**: アップロードされたPDFなどの実ファイルを保存。

### **Orchestration**

* **RagIngestionStateMachine (Step Functions)**: RAGデータ取り込みのワークフロー（ステータス更新 → 抽出 → Embedding → 完了）を制御。エラーハンドリングとリトライを担当。

### **Authentication**

* **Cognito User Pool**: ユーザー認証基盤。

### **AI & Vector Search**

* **AWS Bedrock**: LLM (Claude 3\) および Embedding (Titan) モデルの提供。  
* **Pinecone**: ベクトルデータベース。ドキュメントのベクトルとメタデータを保存し、類似検索に使用。