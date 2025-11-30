import type {
  GitHubWebhookPayload,
  GitHubFileChange,
  StaticAnalysisResult,
} from "../models/github.model";
import { PullRequestAction } from "../models/github.model";
import {
  GitHubAPIService,
  calculatePositionFromPatch,
} from "./github-api.service";
import { StaticAnalysisService } from "./static-analysis.service";
import { AIReviewService } from "./ai-review.service";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { Webhooks } from "@octokit/webhooks";

export class GitHubWebhookService {
  private githubAPI: GitHubAPIService;
  private staticAnalysis: StaticAnalysisService;
  private aiReview: AIReviewService;
  private webhooks: Webhooks | null = null;
  private webhooksPromise: Promise<Webhooks> | null = null;
  private webhookSecret: string;

  constructor() {
    // GitHub App credentials
    const appId = process.env.GITHUB_APP_ID;
    if (!appId || appId.trim() === "") {
      throw new Error(
        "GITHUB_APP_ID environment variable is required and cannot be empty"
      );
    }

    // Validate that appId is a valid number
    const parsedAppId = parseInt(appId.trim(), 10);
    if (isNaN(parsedAppId) || parsedAppId <= 0) {
      throw new Error(
        `GITHUB_APP_ID must be a valid positive number, got: "${appId}"`
      );
    }

    // Read private key from file
    const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
    if (!privateKeyPath) {
      throw new Error(
        "GITHUB_APP_PRIVATE_KEY_PATH environment variable is required"
      );
    }

    // Load private key from file
    // Resolve the path - handle both relative and absolute paths
    let resolvedPrivateKeyPath: string;
    if (privateKeyPath.startsWith("/") || /^[A-Z]:/.test(privateKeyPath)) {
      // Absolute path (Unix or Windows)
      resolvedPrivateKeyPath = privateKeyPath;
    } else {
      // Relative path - resolve from project root
      const projectRoot = process.cwd();
      resolvedPrivateKeyPath = resolve(projectRoot, privateKeyPath);
    }

    // Check if file exists before trying to read
    if (!existsSync(resolvedPrivateKeyPath)) {
      throw new Error(
        `Private key file not found: ${resolvedPrivateKeyPath} (resolved from: ${privateKeyPath}). ` +
          `Current working directory: ${process.cwd()}`
      );
    }

    let privateKey: string;
    try {
      privateKey = readFileSync(resolvedPrivateKeyPath, "utf-8");
    } catch (error) {
      throw new Error(
        `Failed to read private key from file ${privateKeyPath} (resolved: ${resolvedPrivateKeyPath}): ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Validate private key is not empty
    if (!privateKey || privateKey.trim().length === 0) {
      throw new Error(
        `Private key file ${privateKeyPath} is empty. Please ensure the file contains a valid GitHub App private key.`
      );
    }

    // Parse private key - handle both with and without newlines (for env var case)
    // Replace literal \n with actual newlines, then trim any extra whitespace
    let formattedPrivateKey = privateKey.replace(/\\n/g, "\n").trim();

    // Validate private key format (should be PEM format)
    const hasBeginMarker =
      formattedPrivateKey.includes("-----BEGIN RSA PRIVATE KEY-----") ||
      formattedPrivateKey.includes("-----BEGIN PRIVATE KEY-----");
    const hasEndMarker =
      formattedPrivateKey.includes("-----END RSA PRIVATE KEY-----") ||
      formattedPrivateKey.includes("-----END PRIVATE KEY-----");

    if (!hasBeginMarker || !hasEndMarker) {
      throw new Error(
        `Private key in ${privateKeyPath} does not appear to be in valid PEM format. ` +
          `Expected format: -----BEGIN RSA PRIVATE KEY----- ... -----END RSA PRIVATE KEY----- ` +
          `or -----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----`
      );
    }

    // Ensure the private key ends with a newline (some libraries expect this)
    if (!formattedPrivateKey.endsWith("\n")) {
      formattedPrivateKey += "\n";
    }

    this.webhookSecret = process.env.GITHUB_WEBHOOK_SECRET || "";

    this.githubAPI = new GitHubAPIService({
      appId: parsedAppId,
      privateKey: formattedPrivateKey,
    });

    this.staticAnalysis = new StaticAnalysisService({
      eslint: { enabled: true },
      flake8: { enabled: true },
    });

    // Trim API URL and model to remove any whitespace
    const ollamaUrl = process.env.OLLAMA_URL?.trim();
    const aiModel = process.env.AI_MODEL?.trim();

    this.aiReview = new AIReviewService({
      apiUrl: ollamaUrl,
      model: aiModel,
      maxComments: parseInt(process.env.AI_MAX_COMMENTS || "10"),
    });
  }

  private async getWebhooks(): Promise<Webhooks> {
    if (this.webhooks) {
      return this.webhooks;
    }

    if (this.webhooksPromise) {
      return this.webhooksPromise;
    }

    // Initialize Octokit webhooks for signature verification
    // Use dynamic import to handle ESM module in CommonJS context
    this.webhooksPromise = (async () => {
      const { Webhooks: WebhooksClass } = await import("@octokit/webhooks");
      const webhooks = new WebhooksClass({
        secret: this.webhookSecret,
      });

      // Register webhook event handlers
      this.setupWebhookHandlers(webhooks);

      this.webhooks = webhooks;
      return webhooks;
    })();

    return this.webhooksPromise;
  }

  private setupWebhookHandlers(webhooks: Webhooks): void {
    webhooks.on("pull_request", async ({ payload }) => {
      await this.handlePullRequestEvent(
        payload as unknown as GitHubWebhookPayload
      );
    });

    webhooks.on("pull_request_review", async ({ payload }) => {
      console.log("PR review event received:", payload);
      // Handle PR review events if needed
    });

    webhooks.on("push", async ({ payload }) => {
      console.log("Push event received:", payload);
      // Handle push events if needed
    });

    webhooks.onError((error) => {
      console.error("Webhook error:", error);
    });
  }

  async handleWebhookEvent(
    eventType: string,
    payload: GitHubWebhookPayload,
    signature?: string
  ): Promise<void> {
    // Verify installation ID is present in payload
    // According to GitHub docs, installation.id is always present in webhook payloads
    const installationId = payload.installation?.id;
    if (!installationId) {
      const errorMessage =
        `Missing installation ID in webhook payload for event: ${eventType}. ` +
        "GitHub App webhook payloads must include installation.id to generate installation access tokens.";
      console.error(errorMessage, {
        eventType,
        action: payload.action,
        repository: payload.repository?.full_name,
        hasInstallation: !!payload.installation,
      });
      throw new Error(errorMessage);
    }

    // Verify webhook signature using @octokit/webhooks
    if (signature) {
      try {
        const webhooks = await this.getWebhooks();
        // Use installation ID for webhook verification
        const id = installationId.toString();
        const payloadString = JSON.stringify(payload);

        // @octokit/webhooks verifies signature automatically when using .verifyAndReceive()
        await webhooks.verifyAndReceive({
          id,
          name: eventType as any,
          signature: signature,
          payload: payloadString,
        });

        // If verification succeeds, the event handlers will be called automatically
        return;
      } catch (error) {
        console.error("Webhook signature verification failed:", error);
        throw new Error("Invalid webhook signature");
      }
    }

    // Manually trigger the appropriate handler based on event type
    switch (eventType) {
      case "pull_request":
        await this.handlePullRequestEvent(payload);
        break;
      case "pull_request_review":
        console.log("PR review event received");
        break;
      case "push":
        console.log("Push event received");
        break;
      default:
        console.log(`Unhandled event type: ${eventType}`);
    }
  }

  private async handlePullRequestEvent(
    payload: GitHubWebhookPayload
  ): Promise<void> {
    // Normalize action to lowercase for comparison
    const action = (payload.action?.toLowerCase() || "") as PullRequestAction;
    const pr = payload.pull_request;

    if (!pr) {
      console.error("No pull request in payload");
      return;
    }

    // Extract installation ID from payload
    // According to GitHub docs, installation ID is always present in PR webhook payloads
    // https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
    const installationId = payload.installation?.id;
    if (!installationId) {
      const errorMessage =
        "No installation ID in webhook payload. GitHub App webhook payloads must include installation.id. " +
        "This is required to generate an installation access token for API calls.";
      console.error(errorMessage, {
        event: "pull_request",
        action: payload.action,
        repository: payload.repository?.full_name,
        hasInstallation: !!payload.installation,
        installationKeys: payload.installation
          ? Object.keys(payload.installation)
          : [],
      });
      throw new Error(errorMessage);
    }

    // Only process opened and synchronize (updates) PRs
    if (
      action !== PullRequestAction.OPENED &&
      action !== PullRequestAction.SYNCHRONIZE
    ) {
      console.log(`Skipping PR action: ${action}`);
      return;
    }

    const { owner, repo } = this.githubAPI.parseRepositoryFullName(
      payload.repository.full_name
    );

    console.log(`Processing PR #${pr.number}: ${pr.title}`);

    try {
      // Fetch PR files and verify commit SHA
      const { files, headCommit, baseCommit } =
        await this.githubAPI.getPullRequestFiles(
          owner,
          repo,
          pr.number,
          installationId
        );

      // Verify we're using the correct commit SHA from PR head
      if (pr.head.sha !== headCommit) {
        console.warn(
          `Commit SHA mismatch: PR head SHA (${pr.head.sha}) != fetched headCommit (${headCommit}). Using PR head SHA.`
        );
      }
      const verifiedHeadCommit = pr.head.sha;

      // Log PR diff information for debugging
      console.log(`PR Diff Info:`, {
        prNumber: pr.number,
        baseCommit,
        headCommit: verifiedHeadCommit,
        fileCount: files.length,
      });

      // Filter to only added/modified files (skip deleted)
      // Also exclude GitHub workflow files (.github/workflows/)
      const filesToReview = files.filter(
        (f) =>
          (f.status === "added" || f.status === "modified") &&
          !f.filename.startsWith(".github/workflows/")
      );

      if (filesToReview.length === 0) {
        console.log("No files to review");
        return;
      }

      // Collect all review comments from all files
      const allComments: Array<{
        body: string;
        file: string;
        line?: number;
      }> = [];

      console.log(
        `📝 Processing ${filesToReview.length} file(s) and collecting all comments into a single aggregated review...`
      );

      // Process each file and collect comments
      for (const fileChange of filesToReview) {
        console.log(`  🔍 Reviewing file: ${fileChange.filename}`);
        const fileComments = await this.reviewFile(
          owner,
          repo,
          fileChange,
          verifiedHeadCommit,
          installationId
        );
        console.log(
          `  ✅ Collected ${fileComments.length} comment(s) from ${fileChange.filename}`
        );

        // Validate file exists in PR diff
        const fileExistsInDiff = filesToReview.some(
          (f) => f.filename === fileChange.filename
        );
        if (!fileExistsInDiff) {
          console.warn(
            `File ${fileChange.filename} not found in PR diff, skipping comments`
          );
          continue;
        }

        // Collect all comments, verifying they're for added/modified lines in the diff
        for (const comment of fileComments) {
          // Validate comment file matches the file being reviewed
          const filePath =
            comment.file === fileChange.filename
              ? comment.file
              : fileChange.filename;

          // If comment has a line number, verify it's an added/modified line in the diff
          if (comment.line) {
            // GitHub only allows inline comments on lines that are part of the PR diff
            // Check if this line exists in the diff and is an addition
            if (!fileChange.patch) {
              // No patch available (e.g., binary file) - convert to general comment
              allComments.push({
                body: comment.body,
                file: filePath,
                // No line number - will be posted as general comment
              });
              continue;
            }

            // Calculate position from patch to check if line is in diff and is added
            const positionResult = calculatePositionFromPatch(
              fileChange.patch,
              comment.line,
              "RIGHT" // Default to RIGHT side (new file)
            );

            // Check if line is in the diff and is an addition
            if (positionResult.position === null) {
              // Line not found in diff - convert to general comment instead of skipping
              console.log(`Line ${comment.line} not found in diff`);
              continue;
            }

            if (positionResult.isUnchanged) {
              // Line is unchanged (context line) - GitHub doesn't allow inline comments
              // Skip unchanged lines - only include comments for added/modified lines
              console.log(
                `Skipping comment for unchanged line ${comment.line} in ${filePath} (context line)`
              );
              continue;
            }

            if (!positionResult.isAdded) {
              // Line is not an addition (likely a deletion) - convert to general comment
              allComments.push({
                body: comment.body,
                file: filePath,
                // No line number - will be posted as general comment
              });
              continue;
            }

            // Line is in diff and is an addition - include with line number
            allComments.push({
              body: comment.body,
              file: filePath,
              line: comment.line,
            });
          } else {
            // Comment has no line number - include as general comment
            allComments.push({
              body: comment.body,
              file: filePath,
            });
          }
        }
      }

      // Build a single aggregated comment from all files
      console.log(
        `📋 Combining ${allComments.length} comment(s) from ${filesToReview.length} file(s) into a single aggregated review...`
      );
      if (allComments.length > 0) {
        const aggregatedComment = this.buildAggregatedComment(allComments);

        console.log(
          `💬 Posting single aggregated PR comment with all review comments...`
        );
        // Post as a single PR comment
        await this.githubAPI.createOrUpdatePRComment(
          owner,
          repo,
          pr.number,
          {
            body: aggregatedComment,
          },
          installationId
        );
      } else {
        // No comments found - post a positive message
        await this.githubAPI.createOrUpdatePRComment(
          owner,
          repo,
          pr.number,
          {
            body: this.buildNoIssuesComment(filesToReview.length),
          },
          installationId
        );
      }
    } catch (error) {
      console.error("Error processing PR:", error);
      throw error;
    }
  }

  private async reviewFile(
    owner: string,
    repo: string,
    fileChange: GitHubFileChange,
    headCommit: string,
    installationId: number
  ): Promise<Array<{ file: string; line?: number; body: string }>> {
    try {
      // Get file content
      const fileContent = await this.githubAPI.getFileContent(
        owner,
        repo,
        fileChange.filename,
        headCommit,
        installationId
      );

      // Run static analysis
      const staticResults = await this.staticAnalysis.analyzeFile(
        fileChange.filename,
        fileContent
      );

      // Skip AI review for JSON and markdown files
      if (this.shouldSkipAIReview(fileChange.filename)) {
        console.log(
          `Skipping AI review for ${fileChange.filename} (JSON/Markdown file)`
        );
        // Only return static analysis results converted to comments
        return this.staticAnalysisResultsToComments(
          staticResults,
          fileChange.filename
        );
      }

      // Generate AI review comments
      const reviewComments = await this.aiReview.generateReviewComments(
        fileContent,
        fileChange.filename,
        staticResults,
        fileChange
      );

      // Return comments instead of posting them immediately
      return reviewComments.map((comment) => ({
        file: comment.file,
        line: comment.line,
        body: comment.body,
      }));
    } catch (error) {
      console.error(`Error reviewing file ${fileChange.filename}:`, error);
      return [];
    }
  }

  /**
   * Check if a file should be excluded from AI review
   * Excludes JSON and Markdown files
   */
  private shouldSkipAIReview(filename: string): boolean {
    const lowerFilename = filename.toLowerCase();
    return (
      lowerFilename.endsWith(".json") ||
      lowerFilename.endsWith(".md") ||
      lowerFilename.endsWith(".markdown")
    );
  }

  /**
   * Convert static analysis results to review comments format
   */
  private staticAnalysisResultsToComments(
    staticResults: StaticAnalysisResult[],
    filename: string
  ): Array<{ file: string; line?: number; body: string }> {
    return staticResults
      .filter(
        (result) => result.severity === "error" || result.severity === "warning"
      )
      .map((result) => ({
        file: result.file || filename,
        line: result.line,
        body: `**${result.tool.toUpperCase()}**: ${result.message}${
          result.rule ? `\n\nRule: \`${result.rule}\`` : ""
        }`,
      }));
  }

  /**
   * Build a single aggregated comment from all review comments across all files
   */
  private buildAggregatedComment(
    comments: Array<{ body: string; file: string; line?: number }>
  ): string {
    // Group comments by file
    const commentsByFile = new Map<
      string,
      Array<{ body: string; line?: number }>
    >();

    for (const comment of comments) {
      if (!commentsByFile.has(comment.file)) {
        commentsByFile.set(comment.file, []);
      }
      commentsByFile.get(comment.file)!.push({
        body: comment.body,
        line: comment.line,
      });
    }

    // Build the aggregated comment
    // Start with a header to make it easier to match for updates
    const totalFiles = commentsByFile.size;
    const totalComments = comments.length;
    let aggregatedBody = `## Code Review Summary\n\n`;
    aggregatedBody += `Reviewed **${totalFiles} file${totalFiles !== 1 ? "s" : ""}** with **${totalComments} comment${totalComments !== 1 ? "s" : ""}**.\n\n`;
    aggregatedBody += `---\n\n`;

    // Add comments grouped by file
    for (const [file, fileComments] of commentsByFile.entries()) {
      const fileCommentCount = fileComments.length;
      aggregatedBody += `### 📄 ${file} (${fileCommentCount} comment${fileCommentCount !== 1 ? "s" : ""})\n\n`;

      for (const comment of fileComments) {
        // Format: line number if available, then comment body
        if (comment.line) {
          aggregatedBody += `**Line ${comment.line}:**\n`;
        }

        // Add the comment body
        aggregatedBody += `${comment.body}\n\n`;
      }

      // Add separator between files (except after the last file)
      if (
        Array.from(commentsByFile.keys()).indexOf(file) <
        commentsByFile.size - 1
      ) {
        aggregatedBody += `---\n\n`;
      }
    }

    return aggregatedBody.trim();
  }

  /**
   * Build a comment when no issues are found
   */
  private buildNoIssuesComment(fileCount: number): string {
    if (fileCount <= 0) {
      throw new Error(
        `buildNoIssuesComment called with invalid fileCount: ${fileCount}. ` +
          `This function should only be called when there are files to review.`
      );
    }

    return (
      `## Code Review Summary\n\n` +
      `Reviewed ${fileCount} file${fileCount !== 1 ? "s" : ""}.\n\n` +
      `✅ No issues found. Great work!`
    );
  }
}
