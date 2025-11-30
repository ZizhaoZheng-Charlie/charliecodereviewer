import { z } from "zod";

// GitHub Webhook Event Types
export const GitHubEventType = {
  PULL_REQUEST: "pull_request",
  PULL_REQUEST_REVIEW: "pull_request_review",
  PUSH: "push",
} as const;

export type GitHubEventType =
  (typeof GitHubEventType)[keyof typeof GitHubEventType];

// GitHub Pull Request Action Types
export const PullRequestAction = {
  OPENED: "opened",
  CLOSED: "closed",
  REOPENED: "reopened",
  SYNCHRONIZE: "synchronize",
  EDITED: "edited",
  ASSIGNED: "assigned",
  UNASSIGNED: "unassigned",
  LABELED: "labeled",
  UNLABELED: "unlabeled",
} as const;

export type PullRequestAction =
  (typeof PullRequestAction)[keyof typeof PullRequestAction];

// GitHub PR Schema
export const githubPullRequestSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed", "merged"]),
  head: z.object({
    ref: z.string(),
    sha: z.string(),
    repo: z.object({
      full_name: z.string(),
      clone_url: z.string(),
    }),
  }),
  base: z.object({
    ref: z.string(),
    sha: z.string(),
    repo: z.object({
      full_name: z.string(),
      clone_url: z.string(),
    }),
  }),
  user: z.object({
    login: z.string(),
  }),
  html_url: z.string(),
});

// GitHub Repository Schema
export const githubRepositorySchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  owner: z.object({
    login: z.string(),
  }),
  clone_url: z.string(),
  default_branch: z.string(),
});

// GitHub File Change Schema
export const githubFileChangeSchema = z.object({
  filename: z.string(),
  status: z.enum(["added", "removed", "modified", "renamed"]),
  additions: z.number(),
  deletions: z.number(),
  changes: z.number(),
  patch: z.string().optional(),
  blob_url: z.string(),
  contents_url: z.string(),
});

// GitHub Webhook Payload Schema
// Note: According to GitHub documentation, installation.id is always present in webhook payloads
// for GitHub App installations. It's marked as optional here for flexibility, but should be
// validated as required when processing PR events.
// Reference: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
export const githubWebhookPayloadSchema = z.object({
  action: z.string().optional(),
  pull_request: githubPullRequestSchema.optional(),
  repository: githubRepositorySchema,
  sender: z.object({
    login: z.string(),
  }),
  installation: z
    .object({
      id: z.number(),
    })
    .optional()
    .describe(
      "Installation ID is required for GitHub App webhooks. Used to generate installation access tokens."
    ),
});

// GitHub PR Comment Schema
export const githubPRCommentSchema = z.object({
  body: z.string(),
  path: z.string().optional(),
  line: z.number().optional(), // File line number (for backward compatibility)
  position: z.number().optional(), // Position in diff hunk (required by GitHub API)
  side: z.enum(["LEFT", "RIGHT"]).optional(),
  start_line: z.number().optional(),
  start_side: z.enum(["LEFT", "RIGHT"]).optional(),
});

// Static Analysis Result Schema
export const staticAnalysisResultSchema = z.object({
  file: z.string(),
  line: z.number().optional(),
  column: z.number().optional(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  rule: z.string().optional(),
  tool: z.enum(["eslint", "prettier", "flake8", "other"]),
  fixable: z.boolean().optional(),
  fix: z.string().optional(),
  suggestion: z.string().optional(),
});

// AI Review Comment Schema
export const aiReviewCommentSchema = z.object({
  file: z.string(),
  line: z.number().optional(),
  body: z.string(),
  severity: z.enum(["suggestion", "warning", "blocker"]).optional(),
  category: z
    .enum([
      "code-quality",
      "performance",
      "security",
      "best-practices",
      "documentation",
    ])
    .optional(),
  fixSuggestion: z.string().optional(),
  autoFixable: z.boolean().optional(),
});

export type GitHubPullRequest = z.infer<typeof githubPullRequestSchema>;
export type GitHubRepository = z.infer<typeof githubRepositorySchema>;
export type GitHubFileChange = z.infer<typeof githubFileChangeSchema>;
export type GitHubWebhookPayload = z.infer<typeof githubWebhookPayloadSchema>;
export type GitHubPRComment = z.infer<typeof githubPRCommentSchema>;
export type StaticAnalysisResult = z.infer<typeof staticAnalysisResultSchema>;
export type AIReviewComment = z.infer<typeof aiReviewCommentSchema>;

// GitHub API Configuration
export interface GitHubAPIConfig {
  appId: number;
  privateKey?: string;
  privateKeyPath?: string;
  installationId?: number;
  baseUrl?: string;
}

// GitHub API Response Types
export interface FetchPRFilesResponse {
  files: GitHubFileChange[];
  baseCommit: string;
  headCommit: string;
}
