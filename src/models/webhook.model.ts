import { z } from "zod";

export const webhookHeadersSchema = z
  .object({
    "x-webhook-signature": z.string().optional(),
    "x-webhook-id": z.string().optional(),
    "x-webhook-timestamp": z.string().optional(),
    "content-type": z.string().optional(),
  })
  .passthrough();

export const webhookEventDataSchema = z.object({
  id: z.string().optional(),
  type: z.string(),
  timestamp: z.string().or(z.date()).optional(),
  payload: z.record(z.unknown()),
  metadata: z.record(z.unknown()).optional(),
});

export const webhookInputSchema = z.object({
  event: z.string().min(1, "Event type is required"),
  data: webhookEventDataSchema,
  signature: z.string().optional(),
  webhookId: z.string().optional(),
  timestamp: z.string().or(z.date()).optional(),
});

export const webhookResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  eventId: z.string().optional(),
  processedAt: z.date(),
});

export const webhookVerifyInputSchema = z.object({
  signature: z.string(),
  payload: z.string(),
  timestamp: z.string().optional(),
});

export const webhookVerifyResponseSchema = z.object({
  valid: z.boolean(),
});

export interface WebhookContext {
  headers?: Record<string, string>;
  ip?: string;
  timestamp?: Date;
}

export const WebhookEventType = {
  USER_CREATED: "user.created",
  USER_UPDATED: "user.updated",
  USER_DELETED: "user.deleted",
  PAYMENT_RECEIVED: "payment.received",
  PAYMENT_FAILED: "payment.failed",
  ORDER_CREATED: "order.created",
  ORDER_COMPLETED: "order.completed",
  ORDER_CANCELLED: "order.cancelled",
} as const;

export type WebhookEventType =
  (typeof WebhookEventType)[keyof typeof WebhookEventType];

export type WebhookHeaders = z.infer<typeof webhookHeadersSchema>;
export type WebhookEventData = z.infer<typeof webhookEventDataSchema>;
export type WebhookInput = z.infer<typeof webhookInputSchema>;
export type WebhookResponse = z.infer<typeof webhookResponseSchema>;
export type WebhookVerifyInput = z.infer<typeof webhookVerifyInputSchema>;
export type WebhookVerifyResponse = z.infer<typeof webhookVerifyResponseSchema>;
