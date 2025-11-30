import type { Request, Response } from "express";
import { GitHubWebhookService } from "../services/github-webhook.service";

export class SmeeWebhookController {
  private githubWebhookService: GitHubWebhookService;

  constructor() {
    this.githubWebhookService = new GitHubWebhookService();
  }

  async handleSmeeWebhook(req: Request, res: Response): Promise<void> {
    try {
      const eventType = req.headers["x-github-event"] as string;
      const deliveryId = req.headers["x-github-delivery"] as string;
      const signature = req.headers["x-hub-signature-256"] as string;

      if (!eventType) {
        res.status(400).json({ error: "Missing x-github-event header" });
        return;
      }

      console.log(`Received GitHub webhook: ${eventType}`, {
        deliveryId,
        signature: signature ? "present" : "missing",
      });

      // Process the webhook asynchronously
      this.githubWebhookService
        .handleWebhookEvent(eventType, req.body, signature)
        .catch((error) => {
          console.error("Error processing GitHub webhook:", error);
        });

      // Respond immediately to GitHub
      res.status(200).json({ received: true, event: eventType });
    } catch (error) {
      console.error("Webhook handling error:", error);
      res.status(500).json({
        error: "Internal server error",
        message:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  }
}
