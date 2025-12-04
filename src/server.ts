import express from "express";
import webhookRoutes from "./routes/webhook.routes";
import { WebhookController } from "./controllers/webhook.controller";

const app = express();
const PORT = process.env.PORT || "3000";
const AWS_WEBHOOK_URL = process.env.AWS_WEBHOOK_URL;
const GITHUB_WEBHOOK_ENDPOINT = `/github-webhook`;

// Middleware to log all incoming requests (for debugging)
app.use((req, _res, next) => {
  // Log all POST requests to webhook endpoints
  if (
    req.method === "POST" &&
    (req.path.includes("webhook") || req.path.includes("github"))
  ) {
    console.log("Received webhook request");
  }
  next();
});

// Middleware to parse JSON requests
app.use(express.json());

// Health check endpoint
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// AWS Webhook status endpoint
app.get("/aws-webhook/status", (_req, res) => {
  if (AWS_WEBHOOK_URL) {
    res.json({
      status: "configured",
      awsWebhookUrl: AWS_WEBHOOK_URL,
      message: "AWS webhook URL is configured",
    });
  } else {
    res.json({
      status: "not_configured",
      message: "AWS_WEBHOOK_URL environment variable is not set",
      awsWebhookUrl: null,
    });
  }
});

// API routes
app.use("/api/webhook", webhookRoutes);

// GitHub webhook GET endpoint (for webhook verification during setup)
app.get(GITHUB_WEBHOOK_ENDPOINT, (_req, res) => {
  res.status(200).json({
    status: "ok",
    message: "GitHub webhook endpoint is active",
    endpoint: GITHUB_WEBHOOK_ENDPOINT,
  });
});

// GitHub webhook POST endpoint
// This endpoint handles GitHub webhooks directly and transforms them to our webhook format
//
// IMPORTANT: GitHub App webhook payloads always include installation.id in the payload.
// This installation ID is required to generate installation access tokens for API calls.
// Reference: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
app.post(GITHUB_WEBHOOK_ENDPOINT, async (req, res) => {
  try {
    // Extract GitHub webhook headers
    const githubEvent = req.headers["x-github-event"] as string;
    const githubDelivery = req.headers["x-github-delivery"] as string;
    const githubSignature = req.headers["x-hub-signature-256"] as string;
    const githubHookId = req.headers[
      "x-github-hook-installation-target-id"
    ] as string;

    if (!githubEvent) {
      res.status(400).json({ error: "Missing x-github-event header" });
      return;
    }

    // Log PR opened events
    if (githubEvent === "pull_request" && req.body?.action === "opened") {
      console.log("Webhook received: opened");
    }

    // Verify installation ID is present in payload for GitHub App webhooks
    // According to GitHub docs, installation.id is always present in webhook payloads
    // This is required to generate installation access tokens for API calls
    if (githubEvent === "pull_request" && req.body) {
      const installationId = req.body.installation?.id;
      if (!installationId) {
        console.error("Missing installation ID in webhook payload", {
          event: githubEvent,
          action: req.body.action,
          repository: req.body.repository?.full_name,
          hasInstallation: !!req.body.installation,
        });
        res.status(400).json({
          error:
            "Missing installation ID in webhook payload. GitHub App webhook payloads must include installation.id.",
        });
        return;
      }
      console.log(
        `Webhook payload contains installation ID: ${installationId}`
      );
    }

    // Transform GitHub webhook to webhook input format
    const webhookInput = {
      event: githubEvent,
      data: {
        id: githubDelivery,
        type: githubEvent,
        timestamp: new Date().toISOString(),
        payload: req.body,
        metadata: {
          delivery: githubDelivery,
          hookId: githubHookId,
        },
      },
      signature: githubSignature,
      webhookId: githubDelivery,
      timestamp: new Date().toISOString(),
    };

    // Process webhook using controller
    const webhookController = new WebhookController();
    const result = await webhookController.receiveWebhook(webhookInput);

    res.status(200).json(result);
    return;
  } catch (error) {
    console.error("Error processing GitHub webhook:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
    return;
  }
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  if (AWS_WEBHOOK_URL) {
    console.log(`✅ AWS Webhook URL configured: ${AWS_WEBHOOK_URL}`);
    console.log(
      `   Configure your GitHub App webhook URL to: ${AWS_WEBHOOK_URL}`
    );
  } else {
    console.warn("⚠️  AWS_WEBHOOK_URL environment variable is not set.");
    console.warn(
      "   For local development, webhooks can be sent directly to: http://localhost:" +
        PORT +
        GITHUB_WEBHOOK_ENDPOINT
    );
    console.warn(
      "   For production, set AWS_WEBHOOK_URL in your .env file (e.g., AWS_WEBHOOK_URL=https://your-api-gateway-url.amazonaws.com/github_webhook)"
    );
  }
});

// Graceful shutdown
const shutdown = () => {
  console.log("\n🛑 Shutting down gracefully...");
  server.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
