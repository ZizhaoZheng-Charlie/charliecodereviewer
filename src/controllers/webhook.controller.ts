import type {
  WebhookInput,
  WebhookResponse,
  WebhookVerifyInput,
  WebhookVerifyResponse,
} from "../models/webhook.model";
import { WebhookService } from "../services/webhook.service";
import { WebhookVerificationService } from "../services/webhook-verification.service";
import { GitHubEventType } from "../models/github.model";

export class WebhookController {
  private webhookService: WebhookService;
  private verificationService: WebhookVerificationService;

  constructor() {
    this.webhookService = new WebhookService();
    this.verificationService = new WebhookVerificationService();
  }

  private isGitHubEvent(eventType: string): boolean {
    const githubEvents = [
      GitHubEventType.PULL_REQUEST,
      GitHubEventType.PULL_REQUEST_REVIEW,
      GitHubEventType.PUSH,
      "pull_request",
      "pull_request_review",
      "push",
    ];
    return githubEvents.includes(eventType);
  }

  async receiveWebhook(input: WebhookInput): Promise<WebhookResponse> {
    try {
      // Skip generic signature verification for GitHub events
      // GitHubWebhookService handles its own signature verification via @octokit/webhooks
      const isGitHub = this.isGitHubEvent(input.event);

      if (!isGitHub && input.signature) {
        // Optional: Verify signature before processing (for non-GitHub webhooks)
        const verification = await this.verificationService.verifySignature({
          signature: input.signature,
          payload: JSON.stringify(input.data),
          timestamp:
            typeof input.timestamp === "string"
              ? input.timestamp
              : input.timestamp?.toISOString(),
        });

        if (!verification.valid) {
          throw new Error("Invalid webhook signature");
        }
      }

      const result = await this.webhookService.processWebhookEvent(input);
      return result;
    } catch (error) {
      console.error("Webhook processing error:", error);

      // Provide more context for GitHub-related errors
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Check if it's a JWT/authentication error
      if (
        errorMessage.includes("JWT") ||
        errorMessage.includes("could not be decoded") ||
        errorMessage.includes("private key") ||
        errorMessage.includes("GITHUB_APP")
      ) {
        throw new Error(
          `GitHub authentication error: ${errorMessage}. ` +
            `Please verify your GitHub App credentials are correctly configured.`
        );
      }

      throw new Error(
        error instanceof Error
          ? errorMessage
          : "Failed to process webhook event"
      );
    }
  }

  async verifyWebhook(
    input: WebhookVerifyInput
  ): Promise<WebhookVerifyResponse> {
    try {
      const result = await this.verificationService.verifySignature(input);
      return result;
    } catch (error) {
      console.error("Webhook verification error:", error);
      throw new Error(
        error instanceof Error
          ? error.message
          : "Failed to verify webhook signature"
      );
    }
  }
}
