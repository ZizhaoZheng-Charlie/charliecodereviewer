import { Router, Request, Response } from "express";
import { WebhookController } from "../controllers/webhook.controller";
import {
  webhookInputSchema,
  webhookVerifyInputSchema,
} from "../models/webhook.model";

const router = Router();
const webhookController = new WebhookController();

// POST /api/webhook/receive - Receive webhook event
router.post("/receive", async (req: Request, res: Response) => {
  try {
    // Validate input using Zod schema
    const validatedInput = webhookInputSchema.parse(req.body);

    // Process webhook
    const result = await webhookController.receiveWebhook(validatedInput);

    res.status(200).json(result);
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      res.status(400).json({
        error: "Validation error",
        details: error.message,
      });
      return;
    }

    console.error("Error processing webhook:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

// POST /api/webhook/verify - Verify webhook signature
router.post("/verify", async (req: Request, res: Response) => {
  try {
    // Validate input using Zod schema
    const validatedInput = webhookVerifyInputSchema.parse(req.body);

    // Verify webhook
    const result = await webhookController.verifyWebhook(validatedInput);

    res.status(200).json(result);
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      res.status(400).json({
        error: "Validation error",
        details: error.message,
      });
      return;
    }

    console.error("Error verifying webhook:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

export default router;
