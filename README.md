# Charlie Code Reviewer

An automated code review service that integrates with GitHub webhooks to provide AI-powered code reviews on pull requests. The service uses Ollama for AI analysis and performs static code analysis to generate comprehensive review comments.

## Features

- 🤖 **AI-Powered Code Reviews**: Uses Ollama (default: qwen2.5-coder:7b) to analyze code and generate intelligent review comments
- 🔍 **Static Code Analysis**: Integrates ESLint and Flake8 for automated code quality checks
- 🔗 **GitHub Webhook Integration**: Automatically processes pull request events via GitHub webhooks
- 🔐 **GitHub App Authentication**: Secure authentication using GitHub App credentials
- ☁️ **AWS Lambda Support**: Deploy as serverless function on AWS Lambda
- 🔗 **AWS API Gateway Integration**: Webhook endpoint via AWS API Gateway
- 📝 **Automated PR Comments**: Posts review comments directly to GitHub pull requests
- 🛠️ **TypeScript**: Fully typed with TypeScript for better developer experience

## Prerequisites

- Node.js 20 or higher
- npm or yarn
- GitHub App with the following permissions:
  - Repository access (read/write)
  - Pull requests (read/write)
  - Contents (read)
- Ollama installed and running (for AI code reviews)
  - Default model: `qwen2.5-coder:7b`
  - Default URL: `http://localhost:11434`

## Installation

1. Clone the repository:

```bash
git clone <repository-url>
cd charliecodereviewer
```

2. Install dependencies:

```bash
npm install
```

3. Create a `.env` file in the root directory:

```bash
cp .env.example .env
```

4. Configure environment variables (see Configuration section below)

5. Build the project:

```bash
npm run build
```

## Configuration

Create a `.env` file in the project root with the following variables:

### Required Variables

- `GITHUB_APP_ID`: Your GitHub App ID (numeric)
- **For Local Development**: `GITHUB_APP_PRIVATE_KEY_PATH`: Path to your GitHub App private key file (PEM format)
- **For AWS Lambda**: `GITHUB_APP_PRIVATE_KEY`: Your GitHub App private key content (PEM format, can include `\n` for newlines)

### Optional Variables

- `GITHUB_WEBHOOK_SECRET`: Secret for webhook signature verification (recommended for production)
- `OLLAMA_URL`: Ollama API URL (default: `http://localhost:11434`)
- `AI_MODEL`: AI model to use for code reviews (default: `qwen2.5-coder:7b`)
- `AI_MAX_COMMENTS`: Maximum number of review comments per file (default: `10`)
  - `AWS_WEBHOOK_URL`: AWS API Gateway webhook URL for production (e.g., `https://your-api-gateway-url.amazonaws.com/github-webhook`)
- `PORT`: Server port for local development (default: `3000`)

### Example `.env` file (for local development):

```env
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=./private-key.pem
GITHUB_WEBHOOK_SECRET=your-webhook-secret
OLLAMA_URL=http://localhost:11434
AI_MODEL=qwen2.5-coder:7b
AI_MAX_COMMENTS=10
AWS_WEBHOOK_URL=https://your-api-gateway-url.amazonaws.com/webhooks/github
PORT=3000
```

**Note**: For AWS Lambda deployment, use `GITHUB_APP_PRIVATE_KEY` (with the key content) instead of `GITHUB_APP_PRIVATE_KEY_PATH`. See the [AWS Lambda Deployment](#aws-lambda-deployment) section for details.

### GitHub App Setup

1. **Create a GitHub App**:
   - Go to your organization or personal account settings
   - Navigate to Developer settings → GitHub Apps → New GitHub App
   - Fill in the basic information (name, description, homepage URL)

2. **Set Permissions**:
   - **Repository permissions**:
     - Contents: Read
     - Pull requests: Read & Write
     - Metadata: Read-only
   - **Subscribe to events**:
     - ✅ Pull request

3. **Configure Webhook**:
   - **For Local Development**:
     - Set Webhook URL to your local server endpoint (e.g., `http://localhost:3000/github-webhook` or use a tunneling service like ngrok)
   - **For Production (AWS Lambda)**:
     - Set Webhook URL to your AWS API Gateway endpoint (e.g., `https://your-api-gateway-url.amazonaws.com/github-webhook`)
     - Set Webhook secret (use the same value as `GITHUB_WEBHOOK_SECRET` in your `.env`)

4. **Save and Install**:
   - Click "Create GitHub App" or "Update" if editing existing app
   - Download the private key and save it to a file (e.g., `private-key.pem`)
   - Note your App ID from the GitHub App settings page
   - Install the app on repositories or organizations where you want code reviews

## Usage

### Development Mode

Run the server in development mode with hot reload:

```bash
npm run dev
```

The server will start on `http://localhost:3000` (or your configured PORT).

### Production Mode

1. Build the project:

```bash
npm run build
```

2. Start the server:

```bash
npm start
```

### AWS Lambda Deployment

For production deployment, you can deploy this service as an AWS Lambda function. The code now supports reading the private key from an environment variable, making Lambda deployment straightforward.

#### Prerequisites

- AWS CLI configured with appropriate permissions
- Node.js 20.x (Lambda runtime)
- AWS account with permissions to create Lambda functions and API Gateway

#### Step 1: Build the Project

```bash
npm run build
```

#### Step 2: Package for Lambda

Create a deployment package:

**Option A: Using the provided script (recommended)**

```bash
npm run package:lambda
```

**Option B: Manual packaging**

```bash
# Create a deployment directory
mkdir -p lambda-package
cd lambda-package

# Copy built files
cp -r ../dist .
cp -r ../node_modules .

# Create a zip file
zip -r ../lambda-deployment.zip .
cd ..
```

The Lambda handler is located at `dist/handler.js` and should be configured as `handler.handler` in your Lambda function.

#### Step 3: Create Lambda Function

1. **Via AWS Console**:
   - Go to AWS Lambda Console
   - Click "Create function"
   - Choose "Author from scratch"
   - Function name: `charlie-code-reviewer` (or your preferred name)
   - Runtime: Node.js 20.x
   - Architecture: x86_64 or arm64
   - Click "Create function"

2. **Upload deployment package**:
   - In the function configuration, go to "Code" tab
   - Click "Upload from" → ".zip file"
   - Upload your `lambda-deployment.zip` file
   - Set the handler to: `handler.handler`

3. **Configure function settings**:
   - **Timeout**: Set to at least 5 minutes (300 seconds) - code reviews can take time
   - **Memory**: 512 MB minimum (1024 MB recommended for better performance)
   - **Environment variables**: Add the following (see Step 4 for details)

#### Step 4: Configure Environment Variables

In your Lambda function configuration, go to "Configuration" → "Environment variables" and add:

**Required Variables**:

- `GITHUB_APP_ID`: Your GitHub App ID (numeric)
- `GITHUB_APP_PRIVATE_KEY`: Your GitHub App private key (PEM format)
  - Copy the entire private key content including `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----`
  - You can use newlines or `\n` - both are supported
  - **Note**: For Lambda, use `GITHUB_APP_PRIVATE_KEY` (not `GITHUB_APP_PRIVATE_KEY_PATH`)

**Optional Variables**:

- `GITHUB_WEBHOOK_SECRET`: Secret for webhook signature verification (recommended)
- `OLLAMA_URL`: Ollama API URL (if using external Ollama instance)
- `AI_MODEL`: AI model to use (default: `qwen2.5-coder:7b`)
- `AI_MAX_COMMENTS`: Maximum comments per file (default: `10`)

**Example environment variable setup**:

```
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\n
GITHUB_WEBHOOK_SECRET=your-webhook-secret
OLLAMA_URL=http://your-ollama-instance:11434
AI_MODEL=qwen2.5-coder:7b
AI_MAX_COMMENTS=10
```

**Security Best Practice**: For production, consider storing the private key in AWS Secrets Manager and reading it at runtime for better security.

#### Step 5: Configure AWS API Gateway

1. **Create API Gateway**:
   - Go to API Gateway Console
   - Click "Create API"
   - Choose "REST API" or "HTTP API" (HTTP API is simpler and cheaper)
   - For REST API: Choose "New API" → Name it → Click "Create"
   - For HTTP API: Choose "Build" → Name it → Click "Next"

2. **Create Routes**:
   - **GET `/github-webhook`**: For webhook verification
   - **POST `/github-webhook`**: For receiving webhook events
   - Connect both routes to your Lambda function

3. **For REST API**:
   - Create a resource: `/github-webhook`
   - Create methods: GET and POST
   - For each method:
     - Integration type: Lambda Function
     - Select your Lambda function
     - Enable CORS if needed
   - Deploy the API (create a stage, e.g., "prod")

4. **For HTTP API**:
   - Add routes: `GET /github-webhook` and `POST /github-webhook`
   - Attach your Lambda function as the integration
   - Deploy to a stage (e.g., "prod")

5. **Note the API Gateway URL**:
   - REST API: `https://{api-id}.execute-api.{region}.amazonaws.com/{stage}/github-webhook`
   - HTTP API: `https://{api-id}.execute-api.{region}.amazonaws.com/github-webhook`

#### Step 6: Configure GitHub App Webhook

1. Go to your GitHub App settings: `https://github.com/settings/apps/{your-app-name}`
2. Navigate to "Webhook" section
3. Set **Webhook URL** to your API Gateway endpoint:
   - Example: `https://abc123.execute-api.us-east-1.amazonaws.com/prod/github-webhook`
4. Set **Webhook secret** to match your `GITHUB_WEBHOOK_SECRET` environment variable
5. Under "Subscribe to events", ensure "Pull request" is checked
6. Click "Update webhook"

#### Step 7: Test the Deployment

1. **Test the GET endpoint**:

   ```bash
   curl https://your-api-gateway-url.amazonaws.com/github-webhook
   ```

   Should return: `{"status":"ok","message":"GitHub webhook endpoint is active","endpoint":"/github-webhook"}`

2. **Test with a Pull Request**:
   - Create a test pull request in a repository where your GitHub App is installed
   - Check CloudWatch Logs for your Lambda function to see the webhook processing

#### Step 8: Monitor and Debug

- **CloudWatch Logs**: View logs in AWS CloudWatch → Log groups → `/aws/lambda/{function-name}`
- **Lambda Metrics**: Monitor invocations, errors, and duration in Lambda console
- **API Gateway Logs**: Enable CloudWatch Logs for API Gateway to see request/response details

#### Troubleshooting Lambda Deployment

1. **Timeout Errors**:
   - Increase Lambda timeout (up to 15 minutes)
   - Check if Ollama is accessible from Lambda (may need VPC configuration)

2. **Memory Issues**:
   - Increase Lambda memory allocation
   - Check CloudWatch metrics for memory usage

3. **Private Key Errors**:
   - Ensure `GITHUB_APP_PRIVATE_KEY` is set (not `GITHUB_APP_PRIVATE_KEY_PATH`)
   - Verify the private key includes BEGIN/END markers
   - Check that newlines are properly formatted (`\n` or actual newlines)

4. **API Gateway 502 Errors**:
   - Check Lambda function logs in CloudWatch
   - Verify the handler is set to `handler.handler`
   - Ensure the deployment package includes all dependencies

### Local Development

For local development, you can run the Express server:

1. **Start the server**:

   ```bash
   npm run dev
   ```

2. **Configure GitHub App Webhook**:
   - For local testing, use a tunneling service like ngrok to expose your local server
   - Or configure GitHub App webhook to point to your local endpoint if GitHub can reach it
   - Set Webhook URL to `http://localhost:3000/github-webhook` (or your ngrok URL)

3. **Verify the connection**:
   - Check AWS webhook status: `GET http://localhost:3000/aws-webhook/status`
   - Test by creating a pull request in a repository where your GitHub App is installed

## API Endpoints

### Health Check

- `GET /health` - Returns server status

### AWS Webhook Status

- `GET /aws-webhook/status` - Returns AWS webhook configuration status

### GitHub Webhook

- `GET /github-webhook` - Webhook endpoint status
- `POST /github-webhook` - Receives GitHub webhook events

### Webhook API

- `POST /api/webhook/receive` - Generic webhook receiver
- `POST /api/webhook/verify` - Webhook signature verification

## How It Works

1. **Webhook Reception**: The server receives GitHub webhook events, particularly `pull_request` events
2. **Event Processing**: When a pull request is opened or updated, the service:
   - Fetches the pull request details and file changes
   - Clones the repository to a temporary directory
   - Analyzes each changed file
3. **Code Analysis**:
   - **Static Analysis**: Runs ESLint (for JavaScript/TypeScript) and Flake8 (for Python)
   - **AI Analysis**: Sends code to Ollama for intelligent code review
4. **Comment Generation**: Combines static analysis results with AI insights to generate review comments
5. **GitHub Integration**: Posts comments directly to the pull request using GitHub API

## Project Structure

```
charliecodereviewer/
├── src/
│   ├── controllers/          # Request controllers
│   │   └── webhook.controller.ts
│   ├── models/              # Data models and types
│   │   ├── github.model.ts
│   │   └── webhook.model.ts
│   ├── routes/              # Express routes
│   │   └── webhook.routes.ts
│   ├── services/            # Business logic services
│   │   ├── ai-review.service.ts      # AI code review service
│   │   ├── github-api.service.ts      # GitHub API integration
│   │   ├── github-webhook.service.ts  # Webhook processing
│   │   ├── static-analysis.service.ts # Static code analysis
│   │   ├── webhook-verification.service.ts
│   │   └── webhook.service.ts
│   ├── handler.ts           # AWS Lambda handler
│   ├── example-usage.ts     # Example usage documentation
│   └── server.ts            # Express server setup (for local dev)
├── .github/
│   └── workflows/           # GitHub Actions workflows
│       ├── ci.yml
│       ├── codeql-analysis.yml
│       └── dependency-review.yml
├── package.json
├── tsconfig.json
└── README.md
```

## Development

### Type Checking

Run TypeScript type checking without building:

```bash
npm run type-check
```

### Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build TypeScript to JavaScript
- `npm start` - Start production server
- `npm run type-check` - Run TypeScript type checking

## CI/CD

The project includes GitHub Actions workflows for:

- **CI**: Type checking and building on push/PR
- **CodeQL Analysis**: Security vulnerability scanning
- **Dependency Review**: Dependency security review

## Troubleshooting

### Webhook Not Receiving Events

1. **Check GitHub App Webhook Configuration**:
   - Verify the webhook URL in GitHub App settings matches your AWS API Gateway URL (for production) or local endpoint
   - Ensure "Pull request" event is selected
   - Check webhook delivery logs in GitHub App settings to see if events are being sent

2. **Verify AWS Webhook Configuration** (for local development):
   - Check AWS webhook status: `GET http://localhost:3000/aws-webhook/status`
   - Verify `AWS_WEBHOOK_URL` in `.env` matches your API Gateway URL exactly

3. **Check Server Logs**:
   - Look for "Received webhook request" messages in server logs
   - Check for any error messages related to webhook processing

4. **Test Webhook Endpoint**:
   - Test the endpoint directly: `POST http://localhost:3000/webhooks/github/test`
   - This verifies the endpoint is accessible

### AI Review Not Working

1. Ensure Ollama is running: `curl http://localhost:11434/api/tags`
2. Verify the model is installed: `ollama list`
3. Check `OLLAMA_URL` and `AI_MODEL` environment variables

### GitHub API Authentication Errors

1. Verify `GITHUB_APP_ID` is correct
2. Check that `GITHUB_APP_PRIVATE_KEY_PATH` points to a valid PEM file
3. Ensure the private key file is readable and in correct format
4. Verify the GitHub App has necessary permissions

## License

ISC

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
