/**
 * GitHub API Service
 *
 * This service provides GitHub API functionality using GitHub App authentication.
 *
 * AUTHENTICATION FLOW (JWT → Installation Token):
 * ===============================================
 * GitHub Apps cannot use the App JWT directly for repository API calls.
 * The correct authentication flow is:
 *
 * 1. Generate JWT: Create a JWT using App ID + private key (via @octokit/auth-app)
 * 2. Exchange JWT: Exchange the JWT for an installation access token (via GitHub API)
 * 3. Use Installation Token: Use the installation token to authenticate all API calls
 *
 * All methods in this service automatically follow this flow through getAuthenticatedOctokit().
 * The JWT is never used directly - it's always exchanged for an installation token first.
 *
 * REQUIRED GITHUB APP PERMISSIONS:
 * ===============================
 * To use this service, your GitHub App must have the following permissions:
 *
 * Repository Permissions:
 * - Contents: Read (required for getFileContent, getPullRequestFiles)
 * - Pull requests: Read & write (required for createPRComment, createPRReview)
 * - Issues: Write (required for createIssueComment)
 *
 * To configure permissions:
 * 1. Go to https://github.com/settings/apps
 * 2. Select your app → "Permissions & events"
 * 3. Set the required permissions under "Repository permissions"
 * 4. Save and reinstall the app on repositories/organizations
 *
 * Reference: https://docs.github.com/en/apps/creating-github-apps/setting-permissions-and-access-in-settings-for-a-github-app
 */

import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { readFileSync } from "fs";
import { resolve } from "path";
import { existsSync } from "fs";
import type {
  GitHubPullRequest,
  GitHubFileChange,
  GitHubPRComment,
  GitHubAPIConfig,
  FetchPRFilesResponse,
} from "../models/github.model";

/**
 * Result of position calculation
 */
export interface PositionCalculationResult {
  position: number | null;
  isUnchanged: boolean; // true if line is unchanged (context line only)
  isAdded: boolean; // true if line is an addition (starts with "+" in diff)
  reason?: string; // reason if position is null
}

/**
 * Calculate the position in the diff hunk for a given file line number.
 * GitHub requires position (line number in diff hunk) not the raw file line number.
 *
 * Note: GitHub does NOT allow inline comments on unchanged lines (context lines).
 * If a line is unchanged, it should be posted as a general comment instead.
 *
 * @param patch - The patch string from GitHub API (files[i].patch)
 * @param fileLineNumber - The line number in the actual file (1-indexed)
 * @param side - "LEFT" for old file, "RIGHT" for new file (default: "RIGHT")
 * @returns Position calculation result with position and whether line is unchanged
 */
export function calculatePositionFromPatch(
  patch: string | undefined,
  fileLineNumber: number,
  side: "LEFT" | "RIGHT" = "RIGHT"
): PositionCalculationResult {
  if (!patch) {
    return {
      position: null,
      isUnchanged: false,
      isAdded: false,
      reason: "No patch provided",
    };
  }

  // Normalize line number (ensure it's 1-indexed)
  const targetLine = Math.max(1, Math.floor(fileLineNumber));
  if (targetLine !== fileLineNumber) {
    console.warn(`Line number ${fileLineNumber} normalized to ${targetLine}`);
  }

  const lines = patch.split("\n");
  let currentHunkStart: { oldStart: number; newStart: number } | null = null;
  let oldLineNumber = 0;
  let newLineNumber = 0;
  let positionInHunk = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      const oldStart = parseInt(hunkMatch[1], 10);
      const newStart = parseInt(hunkMatch[3], 10);
      const oldCount = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 0;
      const newCount = hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 0;

      // Check if target line could be in this hunk before processing
      if (side === "RIGHT") {
        // For newCount = 0, hunk has no new lines, skip it
        if (newCount === 0) {
          currentHunkStart = null;
          continue;
        }
        const hunkEnd = newStart + newCount - 1;
        if (targetLine < newStart || targetLine > hunkEnd) {
          // Skip this hunk entirely if target line is not in range
          // But we need to continue to check other hunks
          currentHunkStart = null;
          continue;
        }
      } else {
        // For oldCount = 0, hunk has no old lines, skip it
        if (oldCount === 0) {
          currentHunkStart = null;
          continue;
        }
        const hunkEnd = oldStart + oldCount - 1;
        if (targetLine < oldStart || targetLine > hunkEnd) {
          // Skip this hunk entirely if target line is not in range
          currentHunkStart = null;
          continue;
        }
      }

      // Reset counters for new hunk
      currentHunkStart = { oldStart, newStart };
      oldLineNumber = oldStart;
      newLineNumber = newStart;
      positionInHunk = 0;
      continue;
    }

    // If we're not in a relevant hunk, skip
    if (!currentHunkStart) {
      continue;
    }

    // Skip lines that aren't part of the diff (metadata, etc.)
    if (
      !line.startsWith("+") &&
      !line.startsWith("-") &&
      !line.startsWith(" ")
    ) {
      continue;
    }

    // Count position in hunk (all diff lines: +, -, and context)
    positionInHunk++;

    // Track line numbers and check for match
    if (side === "RIGHT") {
      // For new file (RIGHT side), match on + lines and context lines
      if (line.startsWith("+") || line.startsWith(" ")) {
        // Check if this is the line we're looking for (before incrementing)
        if (newLineNumber === targetLine) {
          // Check if this is an unchanged line (context line) or an addition
          const isUnchanged = line.startsWith(" ");
          const isAdded = line.startsWith("+");
          return {
            position: positionInHunk,
            isUnchanged,
            isAdded,
            reason: isUnchanged
              ? "Line is unchanged (context line). GitHub does not allow inline comments on unchanged lines."
              : undefined,
          };
        }
        newLineNumber++;
      } else if (line.startsWith("-")) {
        // Deletion lines don't exist in new file, but increment old counter
        oldLineNumber++;
      }
    } else {
      // For old file (LEFT side), match on - lines and context lines
      if (line.startsWith("-") || line.startsWith(" ")) {
        // Check if this is the line we're looking for (before incrementing)
        if (oldLineNumber === targetLine) {
          // Check if this is an unchanged line (context line) or a deletion
          const isUnchanged = line.startsWith(" ");
          const isAdded = false; // LEFT side (old file) doesn't have additions
          return {
            position: positionInHunk,
            isUnchanged,
            isAdded,
            reason: isUnchanged
              ? "Line is unchanged (context line). GitHub does not allow inline comments on unchanged lines."
              : undefined,
          };
        }
        oldLineNumber++;
      } else if (line.startsWith("+")) {
        // Addition lines don't exist in old file, but increment new counter
        newLineNumber++;
      }
    }
  }

  return {
    position: null,
    isUnchanged: false,
    isAdded: false,
    reason: "Line not found in diff patch",
  };
}

/**
 * GitHubAPIService - GitHub App API client
 *
 * IMPORTANT: This service uses the JWT → Installation Token flow for authentication.
 *
 * GitHub Apps CANNOT use the App JWT directly for repository API calls (like posting comments).
 * The correct flow is:
 * 1. Generate a JWT using App ID + private key (done internally by @octokit/auth-app)
 * 2. Exchange JWT for an installation access token (specific to each repository installation)
 * 3. Use the installation token to authenticate all GitHub REST API calls
 *
 * All API methods in this service automatically use getAuthenticatedOctokit() which
 * implements this flow. NEVER use the JWT directly - GitHub will reject it.
 */
/**
 * Cached installation token with expiration time
 */
interface CachedToken {
  token: string;
  expiresAt: number; // Unix timestamp in milliseconds
}

export class GitHubAPIService {
  private appId: number;
  private privateKey: string;
  private baseUrl: string;
  private installationId?: number;
  // Cache for installation tokens: installationId -> CachedToken
  private tokenCache: Map<number, CachedToken> = new Map();

  constructor(config: GitHubAPIConfig) {
    this.appId = config.appId;
    this.baseUrl = config.baseUrl || "https://api.github.com";
    this.installationId = config.installationId;

    // Read private key from file if path is provided, otherwise use direct string
    if (config.privateKeyPath) {
      // Resolve the path - handle both relative and absolute paths
      // If relative, resolve from project root (where package.json is)
      let resolvedPath: string;
      if (
        config.privateKeyPath.startsWith("/") ||
        /^[A-Z]:/.test(config.privateKeyPath)
      ) {
        // Absolute path (Unix or Windows)
        resolvedPath = config.privateKeyPath;
      } else {
        // Relative path - resolve from project root
        const projectRoot = process.cwd();
        resolvedPath = resolve(projectRoot, config.privateKeyPath);
      }

      try {
        // Check if file exists before trying to read
        if (!existsSync(resolvedPath)) {
          throw new Error(
            `Private key file not found: ${resolvedPath} (resolved from: ${config.privateKeyPath}). ` +
              `Current working directory: ${process.cwd()}`
          );
        }

        console.log(`Reading private key from: ${resolvedPath}`);
        let privateKey = readFileSync(resolvedPath, "utf-8");

        // Validate private key is not empty
        if (!privateKey || privateKey.trim().length === 0) {
          throw new Error(
            `Private key file ${config.privateKeyPath} is empty. Please ensure the file contains a valid GitHub App private key.`
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
            `Private key in ${config.privateKeyPath} does not appear to be in valid PEM format. ` +
              `Expected format: -----BEGIN RSA PRIVATE KEY----- ... -----END RSA PRIVATE KEY----- ` +
              `or -----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----`
          );
        }

        // Ensure the private key ends with a newline (some libraries expect this)
        if (!formattedPrivateKey.endsWith("\n")) {
          formattedPrivateKey += "\n";
        }

        this.privateKey = formattedPrivateKey;
        console.log(`Successfully loaded private key from: ${resolvedPath}`);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to read private key from file ${config.privateKeyPath}: ${errorMessage}. ` +
            `Resolved path: ${resolvedPath || "N/A"}. ` +
            `Current working directory: ${process.cwd()}`
        );
      }
    } else if (config.privateKey) {
      // Format private key even when passed directly (handle \n, ensure proper format)
      let formattedPrivateKey = config.privateKey.replace(/\\n/g, "\n").trim();

      // Validate private key format (should be PEM format)
      const hasBeginMarker =
        formattedPrivateKey.includes("-----BEGIN RSA PRIVATE KEY-----") ||
        formattedPrivateKey.includes("-----BEGIN PRIVATE KEY-----");
      const hasEndMarker =
        formattedPrivateKey.includes("-----END RSA PRIVATE KEY-----") ||
        formattedPrivateKey.includes("-----END PRIVATE KEY-----");

      if (!hasBeginMarker || !hasEndMarker) {
        throw new Error(
          "Private key does not appear to be in valid PEM format. " +
            "Expected format: -----BEGIN RSA PRIVATE KEY----- ... -----END RSA PRIVATE KEY----- " +
            "or -----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----"
        );
      }

      // Ensure the private key ends with a newline (some libraries expect this)
      if (!formattedPrivateKey.endsWith("\n")) {
        formattedPrivateKey += "\n";
      }

      this.privateKey = formattedPrivateKey;
    } else {
      throw new Error(
        "Either privateKey or privateKeyPath must be provided in GitHubAPIConfig"
      );
    }
  }

  /**
   * Exchange JWT for an installation access token
   *
   * This method implements the JWT → Installation Token flow:
   * 1. Internally generates JWT from GitHub App private key (via @octokit/auth-app)
   * 2. Exchanges JWT for installation access token (via GitHub API)
   * 3. Returns the installation token for API authentication
   *
   * CACHING:
   * =======
   * Installation tokens are cached to avoid regenerating JWTs on every API call.
   * Tokens are valid for 1 hour, and we refresh them 5 minutes before expiration
   * to ensure they're always valid.
   *
   * JWT CREATION (handled by @octokit/auth-app):
   * ============================================
   * According to GitHub documentation, the JWT must be signed using RS256 algorithm
   * and contain the following claims:
   * - iat (Issued At): Set 60 seconds in the past to allow for clock drift
   * - exp (Expires At): No more than 10 minutes into the future
   * - iss (Issuer): The GitHub App ID (this.appId)
   * - alg: RS256 (algorithm for signing)
   *
   * Reference: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
   *
   * The @octokit/auth-app library automatically generates the JWT with these claims
   * and handles the exchange for an installation access token.
   *
   * CRITICAL: The App JWT cannot be used directly for repository API calls.
   * It must be exchanged for an installation token first.
   *
   * @param installationId - The GitHub App installation ID (from webhook payload)
   * @returns Installation access token (not the JWT)
   */
  private async getInstallationToken(installationId: number): Promise<string> {
    try {
      // Check cache first
      const cached = this.tokenCache.get(installationId);
      const now = Date.now();
      const bufferTime = 5 * 60 * 1000; // 5 minutes buffer before expiration

      // Return cached token if it's still valid (with 5 minute buffer)
      if (cached && cached.expiresAt > now + bufferTime) {
        console.log(
          `Using cached installation token for installation ${installationId} (expires in ${Math.round((cached.expiresAt - now) / 1000 / 60)} minutes)`
        );
        return cached.token;
      }

      // Cache miss or expired - generate new token
      if (cached) {
        console.log(
          `Cached token expired for installation ${installationId}, generating new token`
        );
      } else {
        console.log(
          `No cached token for installation ${installationId}, generating new token`
        );
      }

      // Validate private key format before attempting to create JWT
      if (!this.privateKey || this.privateKey.trim().length === 0) {
        throw new Error("Private key is empty or not set");
      }

      // Check if private key has the expected PEM format markers
      const hasBeginMarker = this.privateKey.includes("-----BEGIN");
      const hasEndMarker = this.privateKey.includes("-----END");
      if (!hasBeginMarker || !hasEndMarker) {
        throw new Error(
          "Private key does not appear to be in PEM format. Expected format: -----BEGIN RSA PRIVATE KEY----- ... -----END RSA PRIVATE KEY-----"
        );
      }

      // Validate private key format one more time before creating JWT
      // Ensure it has proper PEM structure
      const privateKeyLines = this.privateKey.split("\n");
      const beginLine = privateKeyLines.find((line) =>
        line.includes("-----BEGIN")
      );
      const endLine = privateKeyLines.find((line) => line.includes("-----END"));

      if (!beginLine || !endLine) {
        throw new Error(
          "Private key is missing BEGIN or END markers. Ensure the key is in valid PEM format."
        );
      }

      // Log key info for debugging (without exposing the actual key)
      console.log("Creating JWT with App ID:", this.appId);

      // Additional validation: Check for common issues
      if (this.privateKey.includes("\r\n")) {
        console.warn(
          "Private key contains Windows line endings (\\r\\n). This should be fine, but ensure the key is valid."
        );
      }

      // Check if key appears to have base64 content between markers
      const keyContent = this.privateKey
        .split("\n")
        .filter(
          (line) => !line.includes("-----BEGIN") && !line.includes("-----END")
        )
        .join("");
      if (keyContent.length < 100) {
        console.warn(
          "Private key content appears very short. Ensure the full key is present."
        );
      }

      // createAppAuth automatically generates a JWT with the required claims:
      // - iat: 60 seconds in the past (for clock drift)
      // - exp: 10 minutes in the future (maximum)
      // - iss: this.appId (GitHub App ID)
      // - alg: RS256 (signing algorithm)
      // Then exchanges it for an installation access token
      const auth = createAppAuth({
        appId: this.appId,
        privateKey: this.privateKey,
        installationId: installationId,
      });

      // Exchange JWT for installation access token
      // The auth() call internally:
      // 1. Generates JWT with proper claims (iat, exp, iss, alg)
      // 2. Signs it with RS256 using the private key
      // 3. Exchanges JWT for installation access token via GitHub API
      const authResult = await auth({ type: "installation" });
      const token = authResult.token;

      // Cache the token with expiration time
      // Installation tokens are valid for 1 hour (3600 seconds)
      // expiresAt is provided by @octokit/auth-app, or we default to 1 hour from now
      const expiresAt = authResult.expiresAt
        ? new Date(authResult.expiresAt).getTime()
        : now + 3600 * 1000; // Default to 1 hour if not provided

      this.tokenCache.set(installationId, {
        token,
        expiresAt,
      });

      console.log(
        `Cached new installation token for installation ${installationId} (expires in ${Math.round((expiresAt - now) / 1000 / 60)} minutes)`
      );

      return token;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Provide more helpful error messages for common JWT issues
      if (
        errorMessage.includes("could not be decoded") ||
        errorMessage.includes("JWT") ||
        errorMessage.includes("json web token")
      ) {
        // This error typically means:
        // 1. The private key doesn't match the App ID
        // 2. The private key is corrupted or invalid
        // 3. The App ID is incorrect
        throw new Error(
          `Failed to create JWT token for GitHub App authentication (App ID: ${this.appId}). ` +
            `This error usually means the private key doesn't match your GitHub App ID. ` +
            `Please verify:\n` +
            `1. The private key file exists and is readable\n` +
            `2. The key is in valid PEM format with proper BEGIN/END markers\n` +
            `3. The key matches your GitHub App ID (${this.appId}) - download a new key from your app settings if needed\n` +
            `4. The App ID (${this.appId}) is correct\n` +
            `5. You're using the private key for the correct GitHub App\n\n` +
            `To fix: Go to your GitHub App settings and download a new private key, then update GITHUB_APP_PRIVATE_KEY_PATH.\n` +
            `Original error: ${errorMessage}`
        );
      }

      // Handle authentication errors
      if (
        errorMessage.includes("401") ||
        errorMessage.includes("Unauthorized") ||
        errorMessage.includes("Bad credentials")
      ) {
        throw new Error(
          `GitHub API authentication failed. The private key may not match App ID ${this.appId}. ` +
            `Please verify your GitHub App credentials are correct. Original error: ${errorMessage}`
        );
      }

      throw new Error(
        `Failed to get installation token for installation ${installationId}: ${errorMessage}`
      );
    }
  }

  /**
   * Get an authenticated Octokit instance for a specific installation
   *
   * Implements the JWT → Installation Token flow:
   * 1. Generate JWT from GitHub App private key (via getInstallationToken)
   * 2. Exchange JWT for installation access token (via getInstallationToken)
   * 3. Use that installation token (NOT the JWT) to authenticate Octokit API calls
   *
   * WARNING: Do NOT create Octokit instances with the JWT directly.
   * GitHub rejects JWT tokens for repository API calls. Always use this method
   * which properly exchanges the JWT for an installation token.
   *
   * @param installationId - The GitHub App installation ID (from webhook payload)
   * @returns Authenticated Octokit instance using installation token
   */
  private async getAuthenticatedOctokit(
    installationId?: number
  ): Promise<Octokit> {
    const targetInstallationId = installationId || this.installationId;
    if (!targetInstallationId) {
      throw new Error(
        "Installation ID is required. Provide it via config or method parameter."
      );
    }

    // Step 1 & 2: Generate JWT and exchange for installation token
    // The JWT is generated internally by @octokit/auth-app and immediately exchanged
    const installationToken =
      await this.getInstallationToken(targetInstallationId);

    // Step 3: Use installation token (NOT JWT) to authenticate Octokit
    // This token is specific to the installation and works for repository API calls
    return new Octokit({
      auth: installationToken, // Installation token, NOT the JWT
      baseUrl: this.baseUrl,
    });
  }

  async getPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
    installationId?: number
  ): Promise<GitHubPullRequest> {
    const octokit = await this.getAuthenticatedOctokit(installationId);
    const { data } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    return data as unknown as GitHubPullRequest;
  }

  async getPullRequestDiff(
    owner: string,
    repo: string,
    prNumber: number,
    installationId?: number
  ): Promise<string> {
    const octokit = await this.getAuthenticatedOctokit(installationId);
    const { data } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      mediaType: { format: "diff" },
    });
    return data as unknown as string;
  }

  async getPullRequestFiles(
    owner: string,
    repo: string,
    prNumber: number,
    installationId?: number
  ): Promise<FetchPRFilesResponse> {
    const octokit = await this.getAuthenticatedOctokit(installationId);
    const { data: files } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
    });

    const pr = await this.getPullRequest(owner, repo, prNumber, installationId);

    return {
      files: files as unknown as GitHubFileChange[],
      baseCommit: pr.base.sha,
      headCommit: pr.head.sha,
    };
  }

  /**
   * Get file content from a repository
   *
   * According to GitHub API documentation:
   * - Files 1 MB or smaller: All features supported
   * - Files 1-100 MB: Only 'raw' or 'object' media types supported
   *   When using 'object', content field is empty and encoding is 'none'
   *   Must use 'raw' media type to get actual content
   * - Files > 100 MB: Endpoint not supported
   *
   * Reference: https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28#get-repository-content
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param path - File path in repository
   * @param ref - Branch/tag/commit SHA
   * @param installationId - GitHub App installation ID
   * @returns File content as string
   */
  async getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
    installationId?: number
  ): Promise<string> {
    const octokit = await this.getAuthenticatedOctokit(installationId);

    try {
      // Use 'raw' media type to get actual file content, especially for larger files
      // This ensures we get the content even for files 1-100 MB
      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path,
        ref,
        mediaType: {
          format: "raw",
        },
      });

      // When using 'raw' media type, the response is the file content directly as a string
      if (typeof data === "string") {
        return data;
      }

      // Fallback: If response is not a string (shouldn't happen with 'raw'), try object format
      if (Array.isArray(data)) {
        throw new Error(`Path ${path} is a directory, not a file`);
      }

      // Handle object format response (for files < 1 MB)
      if (data.type !== "file") {
        throw new Error(`Path ${path} is not a file (type: ${data.type})`);
      }

      // Check if content is available
      if ("content" in data && "encoding" in data) {
        // For files 1-100 MB using 'object' format, content is empty and encoding is 'none'
        if (data.encoding === "none" || !data.content) {
          throw new Error(
            `File ${path} is too large (>1 MB). Content is not available via this endpoint. ` +
              `Consider using Git Trees API or cloning the repository instead.`
          );
        }

        if (data.encoding === "base64") {
          return Buffer.from(data.content, "base64").toString("utf-8");
        }

        // If encoding is not base64, return content as-is (shouldn't happen normally)
        return data.content;
      }

      throw new Error(
        `Unable to retrieve content for ${path}. File may be too large (>100 MB).`
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Handle file size errors
      if (
        errorMessage.includes("too large") ||
        errorMessage.includes("413") ||
        errorMessage.includes("Request Entity Too Large")
      ) {
        throw new Error(
          `File ${path} is too large (>100 MB). GitHub API does not support files larger than 100 MB via the contents endpoint. ` +
            `Consider using Git Trees API or cloning the repository instead.`
        );
      }

      // Handle permission/access errors (403)
      if (
        errorMessage.includes("403") ||
        errorMessage.includes("Forbidden") ||
        errorMessage.includes("Resource not accessible by integration") ||
        errorMessage.includes("not accessible")
      ) {
        throw new Error(
          `Permission denied: GitHub App does not have access to repository contents in ${owner}/${repo}. ` +
            `This error typically means:\n` +
            `1. The GitHub App is missing the "Contents: Read" permission\n` +
            `2. The app installation doesn't have access to this repository\n` +
            `3. The repository is private and the app wasn't granted access\n\n` +
            `To fix:\n` +
            `1. Go to your GitHub App settings: https://github.com/settings/apps\n` +
            `2. Select your app and go to "Permissions & events"\n` +
            `3. Under "Repository permissions", ensure "Contents" is set to "Read" (or "Read and write")\n` +
            `4. Save changes and reinstall the app on the repository/organization\n` +
            `5. Make sure the app is installed on the repository: ${owner}/${repo}\n\n` +
            `Reference: https://docs.github.com/en/apps/creating-github-apps/setting-permissions-and-access-in-settings-for-a-github-app`
        );
      }

      // Handle not found errors
      if (errorMessage.includes("404") || errorMessage.includes("Not Found")) {
        throw new Error(
          `File not found: ${path} in ${owner}/${repo} at ref ${ref}`
        );
      }

      // Re-throw with context
      throw new Error(
        `Failed to get file content for ${path} in ${owner}/${repo}: ${errorMessage}`
      );
    }
  }

  /**
   * Get the authenticated app's user information
   * Used to identify comments made by this bot
   */
  async getAppUser(
    installationId?: number
  ): Promise<{ id: number; login: string }> {
    const octokit = await this.getAuthenticatedOctokit(installationId);
    try {
      const { data } = await octokit.apps.getAuthenticated();
      // For GitHub Apps, we need to get the installation's user
      // The app itself doesn't have a user, but we can use the app slug
      // For identifying comments, we'll check by app ownership
      if (!data) {
        throw new Error("No data returned from apps.getAuthenticated");
      }
      return {
        id: data.id,
        login: data.slug || `app[${data.id}]`,
      };
    } catch (error) {
      // Fallback: try to get user info from a different endpoint
      try {
        const { data } = await octokit.users.getAuthenticated();
        if (!data) {
          throw new Error("No data returned from users.getAuthenticated");
        }
        return {
          id: data.id,
          login: data.login,
        };
      } catch (fallbackError) {
        console.warn(
          "Could not get app user info, will match comments by content",
          error
        );
        // Return a placeholder - we'll match comments by other means
        return { id: -1, login: "" };
      }
    }
  }

  /**
   * List all PR review comments for a pull request
   */
  async listPRReviewComments(
    owner: string,
    repo: string,
    prNumber: number,
    installationId?: number
  ): Promise<
    Array<{
      id: number;
      body: string;
      path: string;
      position: number | null;
      line: number | null;
      side: "LEFT" | "RIGHT";
      user: { id: number; login: string; type: string };
      commit_id: string;
    }>
  > {
    const octokit = await this.getAuthenticatedOctokit(installationId);
    try {
      const { data } = await octokit.pulls.listReviewComments({
        owner,
        repo,
        pull_number: prNumber,
      });
      return data.map((comment) => ({
        id: comment.id,
        body: comment.body,
        path: comment.path,
        position: comment.position ?? null,
        line: comment.line ?? null,
        side: comment.side as "LEFT" | "RIGHT",
        user: {
          id: comment.user?.id || 0,
          login: comment.user?.login || "",
          type: comment.user?.type || "",
        },
        commit_id: comment.commit_id,
      }));
    } catch (error) {
      console.error("Failed to list PR review comments:", {
        owner,
        repo,
        prNumber,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * List all issue comments (PR comments) for a pull request
   */
  async listPRIssueComments(
    owner: string,
    repo: string,
    prNumber: number,
    installationId?: number
  ): Promise<
    Array<{
      id: number;
      body: string;
      user: { id: number; login: string; type: string };
    }>
  > {
    const octokit = await this.getAuthenticatedOctokit(installationId);
    try {
      const { data } = await octokit.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
      });
      return data.map((comment) => ({
        id: comment.id,
        body: comment.body || "",
        user: {
          id: comment.user?.id || 0,
          login: comment.user?.login || "",
          type: comment.user?.type || "",
        },
      }));
    } catch (error) {
      console.error("Failed to list PR issue comments:", {
        owner,
        repo,
        prNumber,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Update an existing PR review comment
   */
  async updatePRReviewComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string,
    installationId?: number
  ): Promise<void> {
    const octokit = await this.getAuthenticatedOctokit(installationId);
    try {
      await octokit.pulls.updateReviewComment({
        owner,
        repo,
        comment_id: commentId,
        body,
      });
      console.log(
        `Successfully updated PR review comment ${commentId} on ${owner}/${repo}`
      );
    } catch (error) {
      console.error("Failed to update PR review comment:", {
        owner,
        repo,
        commentId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Find and update a PR review comment by matching criteria
   *
   * Common matching patterns:
   * - Match by bot user: (c) => c.user.type === "Bot" || c.user.login.includes("[bot]")
   * - Match by path: (c) => c.path === "src/file.ts"
   * - Match by body content: (c) => c.body.includes("ESLINT") || c.body.includes("FLAKE8")
   * - Match by path and position: (c) => c.path === "src/file.ts" && c.position === 42
   * - Match by multiple criteria: (c) => c.user.type === "Bot" && c.path === "src/file.ts"
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   * @param matchFn - Function to match the comment
   * @param newBody - New body content for the comment
   * @param installationId - GitHub App installation ID
   * @returns The updated comment ID if found and updated, null otherwise
   *
   * @example
   * // Find and update a bot comment on a specific file
   * await githubAPI.findAndUpdatePRReviewComment(
   *   owner, repo, prNumber,
   *   (c) => c.user.type === "Bot" && c.path === "src/file.ts",
   *   "Updated comment",
   *   installationId
   * );
   *
   * @example
   * // Find and update a comment by path and position
   * await githubAPI.findAndUpdatePRReviewComment(
   *   owner, repo, prNumber,
   *   (c) => c.path === "src/file.ts" && c.position === 42,
   *   "Updated comment",
   *   installationId
   * );
   */
  async findAndUpdatePRReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    matchFn: (comment: {
      id: number;
      body: string;
      path: string;
      position: number | null;
      line: number | null;
      side: "LEFT" | "RIGHT";
      user: { id: number; login: string; type: string };
      commit_id: string;
    }) => boolean,
    newBody: string,
    installationId?: number
  ): Promise<number | null> {
    // List all review comments on the PR
    const comments = await this.listPRReviewComments(
      owner,
      repo,
      prNumber,
      installationId
    );

    // Find the comment that matches the criteria
    const commentToEdit = comments.find(matchFn);

    if (!commentToEdit) {
      console.log(
        `No matching review comment found on ${owner}/${repo}#${prNumber}`
      );
      return null;
    }

    // Update the comment
    await this.updatePRReviewComment(
      owner,
      repo,
      commentToEdit.id,
      newBody,
      installationId
    );

    console.log(
      `Found and updated review comment ${commentToEdit.id} on ${owner}/${repo}#${prNumber}`
    );

    return commentToEdit.id;
  }

  /**
   * Find and update a PR review comment by path and position
   * Convenience method for the common case of matching by file path and line position
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   * @param path - File path to match
   * @param position - Position in the diff to match (or null to match any position on the file)
   * @param newBody - New body content for the comment
   * @param installationId - GitHub App installation ID
   * @returns The updated comment ID if found and updated, null otherwise
   */
  async findAndUpdatePRReviewCommentByPath(
    owner: string,
    repo: string,
    prNumber: number,
    path: string,
    position: number | null,
    newBody: string,
    installationId?: number
  ): Promise<number | null> {
    return this.findAndUpdatePRReviewComment(
      owner,
      repo,
      prNumber,
      (comment) => {
        const pathMatches = comment.path === path;
        if (position === null) {
          return pathMatches;
        }
        return (
          pathMatches &&
          (comment.position === position || comment.line === position)
        );
      },
      newBody,
      installationId
    );
  }

  /**
   * Find and update a PR review comment by bot user
   * Convenience method to find and update comments made by the bot/app
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   * @param path - Optional file path to match (if not provided, matches any bot comment)
   * @param newBody - New body content for the comment
   * @param installationId - GitHub App installation ID
   * @returns The updated comment ID if found and updated, null otherwise
   */
  async findAndUpdatePRReviewCommentByBot(
    owner: string,
    repo: string,
    prNumber: number,
    newBody: string,
    path?: string,
    installationId?: number
  ): Promise<number | null> {
    return this.findAndUpdatePRReviewComment(
      owner,
      repo,
      prNumber,
      (comment) => {
        const isFromBot =
          comment.user.type === "Bot" || comment.user.login.includes("[bot]");
        if (path) {
          return isFromBot && comment.path === path;
        }
        return isFromBot;
      },
      newBody,
      installationId
    );
  }

  /**
   * Update an existing PR issue comment
   */
  async updatePRIssueComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string,
    installationId?: number
  ): Promise<void> {
    const octokit = await this.getAuthenticatedOctokit(installationId);
    try {
      await octokit.issues.updateComment({
        owner,
        repo,
        comment_id: commentId,
        body,
      });
      console.log(
        `Successfully updated PR issue comment ${commentId} on ${owner}/${repo}`
      );
    } catch (error) {
      console.error("Failed to update PR issue comment:", {
        owner,
        repo,
        commentId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Create or update a PR comment (issue comment)
   * Checks for existing comments and updates if found, otherwise creates new
   */
  async createOrUpdatePRComment(
    owner: string,
    repo: string,
    prNumber: number,
    comment: GitHubPRComment,
    installationId?: number
  ): Promise<void> {
    // For general comments without path/line, check if we have a similar comment
    if (!comment.path && !comment.line) {
      const existingComments = await this.listPRIssueComments(
        owner,
        repo,
        prNumber,
        installationId
      );

      // Try to find a matching comment by the bot
      // Match ANY bot comment for general comments (to update the first one we created)
      const matchingComment = existingComments.find((c) => {
        // Check if comment is from the app (GitHub Apps have type "Bot")
        const isFromApp =
          c.user.type === "Bot" || c.user.login.includes("[bot]");

        if (!isFromApp) {
          return false;
        }

        // If the new comment has "## Code Review Summary", match comments with that header
        if (comment.body.includes("## Code Review Summary")) {
          return c.body.includes("## Code Review Summary");
        }

        // Otherwise, match the first bot comment (to update our aggregated review comment)
        // This ensures we update the first comment instead of creating multiple ones
        return true;
      });

      if (matchingComment) {
        console.log(
          `🔄 Updating existing PR comment ${matchingComment.id} on ${owner}/${repo}#${prNumber}`
        );
        await this.updatePRIssueComment(
          owner,
          repo,
          matchingComment.id,
          comment.body,
          installationId
        );
        return;
      }
    }

    // No matching comment found, create new one
    console.log(
      `➕ Creating new PR comment on ${owner}/${repo}#${prNumber} (no matching comment found)`
    );
    await this.createPRComment(owner, repo, prNumber, comment, installationId);
  }

  async createPRComment(
    owner: string,
    repo: string,
    prNumber: number,
    comment: GitHubPRComment,
    installationId?: number
  ): Promise<void> {
    const octokit = await this.getAuthenticatedOctokit(installationId);
    try {
      const response = await octokit.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: comment.body,
      });
      console.log(
        `Successfully created PR comment on ${owner}/${repo}#${prNumber}`,
        { commentId: response.data.id }
      );
    } catch (error) {
      console.error("Failed to create PR comment:", {
        owner,
        repo,
        prNumber,
        error: error instanceof Error ? error.message : String(error),
        details: error,
      });
      throw error;
    }
  }

  /**
   * Create or update a PR review comment (line-specific comment)
   * Checks for existing comments at the same path/position and updates if found
   */
  async createOrUpdatePRReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    comment: GitHubPRComment,
    installationId?: number
  ): Promise<void> {
    if (
      !comment.path ||
      (comment.position === undefined && comment.line === undefined)
    ) {
      // Fallback to issue comment if no line/path specified
      await this.createOrUpdatePRComment(
        owner,
        repo,
        prNumber,
        comment,
        installationId
      );
      return;
    }

    // Use position if provided, otherwise fallback to line
    const position =
      comment.position !== undefined ? comment.position : comment.line;

    if (position === undefined || position === null) {
      // Fallback to issue comment if no valid position/line
      await this.createOrUpdatePRComment(
        owner,
        repo,
        prNumber,
        comment,
        installationId
      );
      return;
    }

    // Check for existing comments at the same path and position
    const existingComments = await this.listPRReviewComments(
      owner,
      repo,
      prNumber,
      installationId
    );

    // Match by path and position/line
    // Prioritize matching by line (absolute line number) as it's more stable than position
    const matchingComment = existingComments.find((c) => {
      const isFromApp = c.user.type === "Bot" || c.user.login.includes("[bot]");
      const samePath = c.path === comment.path;
      const sameSide = c.side === (comment.side || "RIGHT");

      // Match by line (absolute line number) if both exist - this is more reliable
      // Line numbers are stable even when the diff changes
      const matchesByLine =
        comment.line !== undefined &&
        c.line !== null &&
        c.line !== undefined &&
        c.line === comment.line;

      // Match by position (diff hunk position) as fallback
      // Position can change when diff changes, so it's less reliable
      const matchesByPosition =
        position !== undefined &&
        position !== null &&
        c.position !== null &&
        c.position !== undefined &&
        c.position === position;

      const samePosition = matchesByLine || matchesByPosition;

      return isFromApp && samePath && samePosition && sameSide;
    });

    if (matchingComment) {
      // Update existing comment
      console.log(
        `🔄 Updating existing PR review comment ${matchingComment.id} on ${comment.path} at line ${comment.line || position}`
      );
      await this.updatePRReviewComment(
        owner,
        repo,
        matchingComment.id,
        comment.body,
        installationId
      );
      return;
    }

    // No matching comment found, create new one
    console.log(
      `➕ Creating new PR review comment on ${comment.path} at line ${comment.line || position} (no matching comment found)`
    );
    await this.createPRReviewComment(
      owner,
      repo,
      prNumber,
      comment,
      installationId
    );
  }

  async createPRReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    comment: GitHubPRComment,
    installationId?: number
  ): Promise<void> {
    const octokit = await this.getAuthenticatedOctokit(installationId);
    if (comment.path && (comment.position !== undefined || comment.line)) {
      // Get the PR to get the head commit SHA
      const pr = await this.getPullRequest(
        owner,
        repo,
        prNumber,
        installationId
      );

      // Use position if provided, otherwise fallback to line (for backward compatibility)
      // But note: position should be calculated from patch before calling this method
      const position =
        comment.position !== undefined ? comment.position : comment.line;

      if (position === undefined || position === null) {
        // Fallback to issue comment if no valid position/line
        await this.createPRComment(
          owner,
          repo,
          prNumber,
          comment,
          installationId
        );
        return;
      }

      try {
        const response = await octokit.pulls.createReviewComment({
          owner,
          repo,
          pull_number: prNumber,
          body: comment.body,
          commit_id: pr.head.sha,
          path: comment.path,
          position: position,
          side: (comment.side as "LEFT" | "RIGHT") || "RIGHT",
        });
        console.log(
          `Successfully created PR review comment on ${owner}/${repo}#${prNumber}`,
          {
            path: comment.path,
            position,
            commentId: response.data.id,
          }
        );
      } catch (error) {
        console.error("Failed to create PR review comment:", {
          owner,
          repo,
          prNumber,
          path: comment.path,
          position,
          commitId: pr.head.sha,
          error: error instanceof Error ? error.message : String(error),
          details: error,
        });
        throw error;
      }
    } else {
      // Fallback to issue comment if no line/path specified
      await this.createPRComment(
        owner,
        repo,
        prNumber,
        comment,
        installationId
      );
    }
  }

  async createIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
    installationId?: number
  ): Promise<void> {
    const octokit = await this.getAuthenticatedOctokit(installationId);
    try {
      const response = await octokit.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      });
      console.log(
        `Successfully created issue comment on ${owner}/${repo}#${issueNumber}`,
        { commentId: response.data.id }
      );
    } catch (error) {
      console.error("Failed to create issue comment:", {
        owner,
        repo,
        issueNumber,
        error: error instanceof Error ? error.message : String(error),
        details: error,
      });
      throw error;
    }
  }

  /**
   * Create or update PR review comments
   * Updates existing comments where possible, creates new ones otherwise
   */
  async createOrUpdatePRReview(
    owner: string,
    repo: string,
    prNumber: number,
    comments: GitHubPRComment[],
    body: string,
    _event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" = "COMMENT",
    installationId?: number
  ): Promise<void> {
    // Get existing comments
    const existingReviewComments = await this.listPRReviewComments(
      owner,
      repo,
      prNumber,
      installationId
    );

    // Separate comments into line-specific and general
    const lineComments = comments.filter(
      (c) => c.path && (c.position !== undefined || c.line !== undefined)
    );
    const generalComments = comments.filter(
      (c) => !c.path || (c.position === undefined && c.line === undefined)
    );

    // Process line-specific comments: update existing or create new
    for (const comment of lineComments) {
      if (!comment.path) continue;

      const position =
        comment.position !== undefined ? comment.position : comment.line;
      if (position === undefined || position === null) continue;

      // Find matching existing comment
      // Prioritize matching by line (absolute line number) as it's more stable than position
      const matchingComment = existingReviewComments.find((c) => {
        const isFromApp =
          c.user.type === "Bot" || c.user.login.includes("[bot]");
        const samePath = c.path === comment.path;
        const sameSide = c.side === (comment.side || "RIGHT");

        // Match by line (absolute line number) if both exist - this is more reliable
        // Line numbers are stable even when the diff changes
        const matchesByLine =
          comment.line !== undefined &&
          c.line !== null &&
          c.line !== undefined &&
          c.line === comment.line;

        // Match by position (diff hunk position) as fallback
        // Position can change when diff changes, so it's less reliable
        const matchesByPosition =
          position !== undefined &&
          position !== null &&
          c.position !== null &&
          c.position !== undefined &&
          c.position === position;

        const samePosition = matchesByLine || matchesByPosition;

        return isFromApp && samePath && samePosition && sameSide;
      });

      if (matchingComment) {
        // Update existing comment
        console.log(
          `🔄 Updating existing PR review comment ${matchingComment.id} on ${comment.path} at line ${comment.line || position}`
        );
        await this.updatePRReviewComment(
          owner,
          repo,
          matchingComment.id,
          comment.body,
          installationId
        );
      } else {
        // Create new comment
        console.log(
          `➕ Creating new PR review comment on ${comment.path} at line ${comment.line || position} (no matching comment found)`
        );
        await this.createPRReviewComment(
          owner,
          repo,
          prNumber,
          comment,
          installationId
        );
      }
    }

    // Handle general comments (review body and issue comments)
    // Check if there's an existing review with a similar body
    const existingIssueComments = await this.listPRIssueComments(
      owner,
      repo,
      prNumber,
      installationId
    );

    // Update or create review summary comment
    const reviewSummaryComment = existingIssueComments.find((c) => {
      const isFromApp = c.user.type === "Bot" || c.user.login.includes("[bot]");
      return (
        isFromApp &&
        body.includes("## Code Review Summary") &&
        c.body.includes("## Code Review Summary")
      );
    });

    if (reviewSummaryComment && lineComments.length === 0) {
      // Update existing review summary
      await this.updatePRIssueComment(
        owner,
        repo,
        reviewSummaryComment.id,
        body,
        installationId
      );
    } else if (lineComments.length === 0 && generalComments.length === 0) {
      // Only create review if we have line comments or need to create a new summary
      // For now, if we have line comments, they're already handled above
      // If no line comments, we'll create/update the review summary via issue comment
      if (!reviewSummaryComment) {
        await this.createPRComment(
          owner,
          repo,
          prNumber,
          { body },
          installationId
        );
      }
    }

    // Handle general comments that aren't the review summary
    for (const comment of generalComments) {
      if (comment.body.includes("## Code Review Summary")) {
        // Already handled above
        continue;
      }
      await this.createOrUpdatePRComment(
        owner,
        repo,
        prNumber,
        comment,
        installationId
      );
    }
  }

  async createPRReview(
    owner: string,
    repo: string,
    prNumber: number,
    comments: GitHubPRComment[],
    body: string,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" = "COMMENT",
    installationId?: number
  ): Promise<void> {
    const octokit = await this.getAuthenticatedOctokit(installationId);

    // Get the PR to get the head commit SHA
    const pr = await this.getPullRequest(owner, repo, prNumber, installationId);

    // Convert comments to the format expected by GitHub API
    // GitHub requires 'position' (line number in diff hunk), not 'line' (file line number)
    const reviewComments = comments
      .filter((comment) => {
        // Must have path and either position or line
        return (
          comment.path &&
          (comment.position !== undefined || comment.line !== undefined)
        );
      })
      .map((comment) => {
        // Use position if provided, otherwise use line (for backward compatibility)
        // Note: position should ideally be calculated from patch before calling this method
        const position =
          comment.position !== undefined ? comment.position : comment.line!;

        return {
          path: comment.path!,
          position: position,
          side: (comment.side as "LEFT" | "RIGHT") || "RIGHT",
          body: comment.body,
        };
      });

    // Create the PR review with all comments
    try {
      const requestPayload = {
        owner,
        repo,
        pull_number: prNumber,
        commit_id: pr.head.sha,
        body:
          body || (reviewComments.length > 0 ? "Code review completed" : ""),
        event: event,
        comments: reviewComments.length > 0 ? reviewComments : undefined,
      };

      console.log(`Creating PR review on ${owner}/${repo}#${prNumber}`, {
        event,
        commentCount: reviewComments.length,
        commitId: pr.head.sha,
      });

      const response = await octokit.pulls.createReview(requestPayload);
      console.log(
        `Successfully created PR review on ${owner}/${repo}#${prNumber}`,
        {
          reviewId: response.data.id,
          state: response.data.state,
          commentCount: reviewComments.length,
        }
      );
    } catch (error) {
      console.error("Failed to create PR review:", {
        owner,
        repo,
        prNumber,
        event,
        commentCount: reviewComments.length,
        commitId: pr.head.sha,
        error: error instanceof Error ? error.message : String(error),
        details: error,
        // Log comment details for debugging
        comments: reviewComments.map((c) => ({
          path: c.path,
          position: c.position,
          side: c.side,
        })),
      });
      throw error;
    }
  }

  parseRepositoryFullName(fullName: string): { owner: string; repo: string } {
    const [owner, repo] = fullName.split("/");
    if (!owner || !repo) {
      throw new Error(`Invalid repository full name: ${fullName}`);
    }
    return { owner, repo };
  }
}
