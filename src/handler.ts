import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { WebhookController } from "./controllers/webhook.controller";
import type { WebhookInput } from "./models/webhook.model";

/**
 * AWS Lambda handler for processing GitHub webhooks via API Gateway
 */
const WEBHOOK_PATH = "/github-webhook";
const SECRET_NAME = "charlieprivatekey";
const AWS_REGION = "us-west-2";

// Cache for the private key to avoid repeated Secrets Manager calls
let cachedPrivateKey: string | null = null;

/**
 * Retrieves the GitHub App private key from AWS Secrets Manager
 */
async function getPrivateKeyFromSecretsManager(): Promise<string> {
  // Return cached key if available
  if (cachedPrivateKey) {
    return cachedPrivateKey;
  }

  try {
    const client = new SecretsManagerClient({ region: AWS_REGION });
    const command = new GetSecretValueCommand({ SecretId: SECRET_NAME });
    const data = await client.send(command);

    let privateKey: string;

    if (data.SecretString) {
      privateKey = data.SecretString;
    } else if (data.SecretBinary) {
      privateKey = Buffer.from(data.SecretBinary).toString("ascii");
    } else {
      throw new Error("Secret value is empty");
    }

    console.log("Retrieved private key length:", privateKey.length);

    // Cache the private key for subsequent invocations
    cachedPrivateKey = privateKey;

    // Set as environment variable so existing services can use it
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey;

    return privateKey;
  } catch (err) {
    console.error("Failed to retrieve private key from Secrets Manager:", err);
    throw new Error(
      `Failed to retrieve private key from Secrets Manager: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> => {
  // Retrieve private key from AWS Secrets Manager if not already set
  if (
    !process.env.GITHUB_APP_PRIVATE_KEY &&
    !process.env.GITHUB_APP_PRIVATE_KEY_PATH
  ) {
    try {
      await getPrivateKeyFromSecretsManager();
    } catch (error) {
      console.error(
        "Error retrieving private key from Secrets Manager:",
        error
      );
      return {
        statusCode: 500,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          error:
            "Failed to retrieve GitHub App private key from Secrets Manager",
          message: error instanceof Error ? error.message : "Unknown error",
          requestId: context.awsRequestId,
        }),
      };
    }
  }
  console.log("Lambda handler invoked", {
    requestId: context.awsRequestId,
    httpMethod: event.httpMethod,
    path: event.path,
    headers: event.headers,
  });

  try {
    // Validate path for webhook endpoint
    if (event.path !== WEBHOOK_PATH) {
      return {
        statusCode: 404,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          error: "Not found",
          message: `Path ${event.path} is not a supported webhook endpoint`,
          expectedPath: WEBHOOK_PATH,
        }),
      };
    }

    // Handle GET requests (webhook verification during setup)
    if (event.httpMethod === "GET") {
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          status: "ok",
          message: "GitHub webhook endpoint is active",
          endpoint: WEBHOOK_PATH,
        }),
      };
    }

    // Handle POST requests (webhook events)
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          error: "Method not allowed",
          allowedMethods: ["GET", "POST"],
        }),
      };
    }

    // Extract GitHub webhook headers
    const githubEvent =
      event.headers["x-github-event"] || event.headers["X-GitHub-Event"];
    const githubDelivery =
      event.headers["x-github-delivery"] || event.headers["X-GitHub-Delivery"];
    const githubSignature =
      event.headers["x-hub-signature-256"] ||
      event.headers["X-Hub-Signature-256"];
    const githubHookId =
      event.headers["x-github-hook-installation-target-id"] ||
      event.headers["X-GitHub-Hook-Installation-Target-Id"];

    if (!githubEvent) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          error: "Missing x-github-event header",
        }),
      };
    }

    // Parse request body
    let body: any;
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch (parseError) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          error: "Invalid JSON in request body",
          details:
            parseError instanceof Error
              ? parseError.message
              : String(parseError),
        }),
      };
    }

    // Log PR opened events
    if (githubEvent === "pull_request" && body?.action === "opened") {
      console.log("Webhook received: pull_request opened");
    }

    // Verify installation ID is present in payload for GitHub App webhooks
    if (githubEvent === "pull_request" && body) {
      const installationId = body.installation?.id;
      if (!installationId) {
        console.error("Missing installation ID in webhook payload", {
          event: githubEvent,
          action: body.action,
          repository: body.repository?.full_name,
          hasInstallation: !!body.installation,
        });
        return {
          statusCode: 400,
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            error:
              "Missing installation ID in webhook payload. GitHub App webhook payloads must include installation.id.",
          }),
        };
      }
      console.log(
        `Webhook payload contains installation ID: ${installationId}`
      );
    }

    // Transform API Gateway event to webhook input format
    const webhookInput: WebhookInput = {
      event: githubEvent,
      data: {
        id: githubDelivery || context.awsRequestId,
        type: githubEvent,
        timestamp: new Date().toISOString(),
        payload: body,
        metadata: {
          delivery: githubDelivery,
          hookId: githubHookId,
          requestId: context.awsRequestId,
          source: "aws-api-gateway",
        },
      },
      signature: githubSignature,
      webhookId: githubDelivery || context.awsRequestId,
      timestamp: new Date().toISOString(),
    };

    // Process webhook using controller
    const webhookController = new WebhookController();
    const result = await webhookController.receiveWebhook(webhookInput);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(result),
    };
  } catch (error) {
    console.error("Error processing webhook in Lambda:", error);

    const errorMessage =
      error instanceof Error ? error.message : "Internal server error";
    const statusCode =
      errorMessage.includes("Validation error") ||
      errorMessage.includes("Missing")
        ? 400
        : 500;

    return {
      statusCode,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        error: errorMessage,
        requestId: context.awsRequestId,
      }),
    };
  }
};
