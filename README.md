# Charlie Code Reviewer

An automated code review service that integrates with GitHub webhooks to provide AI-powered code reviews on pull requests. The service uses Ollama for AI analysis and performs static code analysis to generate comprehensive review comments.

## Features

- 🤖 **AI-Powered Code Reviews**: Uses Ollama (default: qwen2.5-coder:7b) to analyze code and generate intelligent review comments
- 🔍 **Static Code Analysis**: Integrates ESLint and Flake8 for automated code quality checks
- 🔗 **GitHub Webhook Integration**: Automatically processes pull request events via GitHub webhooks
- 🔐 **GitHub App Authentication**: Secure authentication using GitHub App credentials
- 🚀 **Smee Integration**: Local development support with Smee for webhook forwarding
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
- `GITHUB_APP_PRIVATE_KEY_PATH`: Path to your GitHub App private key file (PEM format)

### Optional Variables

- `GITHUB_WEBHOOK_SECRET`: Secret for webhook signature verification (recommended for production)
- `OLLAMA_URL`: Ollama API URL (default: `http://localhost:11434`)
- `AI_MODEL`: AI model to use for code reviews (default: `qwen2.5-coder:7b`)
- `AI_MAX_COMMENTS`: Maximum number of review comments per file (default: `10`)
- `SMEE_URL`: Smee channel URL for local development (e.g., `https://smee.io/your-channel-id`)
- `PORT`: Server port (default: `3000`)

### Example `.env` file:

```env
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=./private-key.pem
GITHUB_WEBHOOK_SECRET=your-webhook-secret
OLLAMA_URL=http://localhost:11434
AI_MODEL=qwen2.5-coder:7b
AI_MAX_COMMENTS=10
SMEE_URL=https://smee.io/your-channel-id
PORT=3000
```

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
   - **For Local Development (using Smee)**:
     - Set Webhook URL to your Smee channel URL (e.g., `https://smee.io/your-channel-id`)
     - See [Local Development with Smee](#local-development-with-smee) section for detailed instructions
   - **For Production**:
     - Set Webhook URL to your production server endpoint (e.g., `https://your-domain.com/webhooks/github`)
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

### Local Development with Smee

For local development, you can use Smee to forward webhooks from GitHub to your local server:

1. **Create a Smee channel**:
   - Go to https://smee.io
   - Click "Start a new channel" or use an existing channel
   - Copy the channel URL (e.g., `https://smee.io/your-channel-id`)

2. **Configure your `.env` file**:
   - Add the Smee channel URL to your `.env` file:
     ```env
     SMEE_URL=https://smee.io/your-channel-id
     ```

3. **Configure GitHub App Webhook**:
   - Go to your GitHub App settings (Settings → Developer settings → GitHub Apps → Your App)
   - Navigate to the "Webhook" section
   - Set the **Webhook URL** to your Smee channel URL (the same URL from step 1)
   - Set the **Webhook secret** (optional, but recommended) - use the same value as `GITHUB_WEBHOOK_SECRET` in your `.env` if you set one
   - Under "Which events would you like to trigger this webhook?", select:
     - ✅ **Pull request** (required)
   - Click "Update webhook" or "Save changes"

4. **Start the server**:
   ```bash
   npm run dev
   ```
   The server will automatically:
   - Connect to the Smee channel
   - Forward webhooks from Smee to `http://localhost:3000/webhooks/github`
   - Process incoming GitHub webhook events

5. **Verify the connection**:
   - Check Smee connection status: `GET http://localhost:3000/smee/status`
   - The response should show `status: "connected"`
   - Test by creating a pull request in a repository where your GitHub App is installed

**Note**: The Smee client automatically forwards all webhooks from your Smee channel to the local endpoint. Make sure your local server is running before webhooks are sent, or they will be lost.

## API Endpoints

### Health Check
- `GET /health` - Returns server status

### Smee Status
- `GET /smee/status` - Returns Smee connection status
- `GET /smee/refresh` - Refreshes Smee connection state

### GitHub Webhook
- `GET /webhooks/github` - Webhook endpoint status
- `POST /webhooks/github` - Receives GitHub webhook events
- `POST /webhooks/github/test` - Test endpoint for webhook verification

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
│   │   ├── smee-webhook.controller.ts
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
│   │   ├── smee.service.ts            # Smee client
│   │   ├── static-analysis.service.ts # Static code analysis
│   │   ├── webhook-verification.service.ts
│   │   └── webhook.service.ts
│   ├── example-usage.ts     # Example usage documentation
│   └── server.ts            # Express server setup
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
   - Verify the webhook URL in GitHub App settings matches your Smee channel URL (for local dev) or production URL
   - Ensure "Pull request" event is selected
   - Check webhook delivery logs in GitHub App settings to see if events are being sent

2. **Verify Smee Connection** (for local development):
   - Check Smee connection status: `GET http://localhost:3000/smee/status`
   - The response should show `status: "connected"` and `connected: true`
   - If disconnected, try refreshing: `GET http://localhost:3000/smee/refresh`
   - Verify `SMEE_URL` in `.env` matches your Smee channel URL exactly

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


