import type {
  WebhookInput,
  WebhookResponse,
  WebhookEventType,
} from "../models/webhook.model";
import { WebhookEventType as EventType } from "../models/webhook.model";
import { GitHubWebhookService } from "./github-webhook.service";
import {
  GitHubEventType,
  type GitHubWebhookPayload,
} from "../models/github.model";

export class WebhookService {
  private githubWebhookService: GitHubWebhookService | null = null;

  async processWebhookEvent(input: WebhookInput): Promise<WebhookResponse> {
    const eventId = input.webhookId || this.generateEventId();
    const timestamp = input.timestamp
      ? typeof input.timestamp === "string"
        ? new Date(input.timestamp)
        : input.timestamp
      : new Date();

    console.log(`Processing webhook event: ${input.event}`, {
      eventId,
      repository: (input.data.payload as GitHubWebhookPayload).repository.full_name,
      action: input.data.payload.action,
      timestamp,
    });

    // Check if this is a GitHub event
    const isGitHubEvent = this.isGitHubEvent(input.event);
    if (isGitHubEvent) {
      await this.handleGitHubEvent(input);
    } else {
      await this.routeEventByType(input.event as WebhookEventType, input.data);
    }

    return {
      success: true,
      message: `Webhook event ${input.event} processed successfully`,
      eventId,
      processedAt: new Date(),
    };
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

  private async handleGitHubEvent(input: WebhookInput): Promise<void> {
    try {
      // Lazy initialize GitHubWebhookService to avoid constructor errors if env vars are missing
      if (!this.githubWebhookService) {
        try {
          this.githubWebhookService = new GitHubWebhookService();
        } catch (initError) {
          const errorMessage =
            initError instanceof Error
              ? initError.message
              : "Unknown initialization error";
          console.error(
            "Failed to initialize GitHubWebhookService:",
            errorMessage
          );
          throw new Error(
            `GitHub webhook service initialization failed: ${errorMessage}. Please check your GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, and GITHUB_WEBHOOK_SECRET environment variables.`
          );
        }
      }

      // Extract the actual GitHub payload from the webhook data
      const githubPayload = (input.data.payload ||
        input.data) as GitHubWebhookPayload;
      const eventType = input.event;

      // Handle the GitHub webhook event
      await this.githubWebhookService.handleWebhookEvent(
        eventType,
        githubPayload,
        input.signature
      );
    } catch (error) {
      console.error("Error handling GitHub webhook event:", error);
      // Re-throw to allow error handling upstream
      throw error;
    }
  }

  private async routeEventByType(
    eventType: WebhookEventType,
    data: any
  ): Promise<void> {
    switch (eventType) {
      case EventType.USER_CREATED:
        await this.handleUserCreated(data);
        break;
      case EventType.USER_UPDATED:
        await this.handleUserUpdated(data);
        break;
      case EventType.USER_DELETED:
        await this.handleUserDeleted(data);
        break;
      case EventType.PAYMENT_RECEIVED:
        await this.handlePaymentReceived(data);
        break;
      case EventType.PAYMENT_FAILED:
        await this.handlePaymentFailed(data);
        break;
      case EventType.ORDER_CREATED:
        await this.handleOrderCreated(data);
        break;
      case EventType.ORDER_COMPLETED:
        await this.handleOrderCompleted(data);
        break;
      case EventType.ORDER_CANCELLED:
        await this.handleOrderCancelled(data);
        break;
      default:
        console.log(`Unhandled event type: ${eventType}`);
    }
  }

  private async handleUserCreated(data: any): Promise<void> {
    // Business logic for user created event
    console.log("Handling user.created event", data);
    // Add your implementation here
  }

  private async handleUserUpdated(data: any): Promise<void> {
    // Business logic for user updated event
    console.log("Handling user.updated event", data);
    // Add your implementation here
  }

  private async handleUserDeleted(data: any): Promise<void> {
    // Business logic for user deleted event
    console.log("Handling user.deleted event", data);
    // Add your implementation here
  }

  private async handlePaymentReceived(data: any): Promise<void> {
    // Business logic for payment received event
    console.log("Handling payment.received event", data);
    // Add your implementation here
  }

  private async handlePaymentFailed(data: any): Promise<void> {
    // Business logic for payment failed event
    console.log("Handling payment.failed event", data);
    // Add your implementation here
  }

  private async handleOrderCreated(data: any): Promise<void> {
    // Business logic for order created event
    console.log("Handling order.created event", data);
    // Add your implementation here
  }

  private async handleOrderCompleted(data: any): Promise<void> {
    // Business logic for order completed event
    console.log("Handling order.completed event", data);
    // Add your implementation here
  }

  private async handleOrderCancelled(data: any): Promise<void> {
    // Business logic for order cancelled event
    console.log("Handling order.cancelled event", data);
    // Add your implementation here
  }

  private generateEventId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}
