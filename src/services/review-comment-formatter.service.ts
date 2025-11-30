import type {
  StaticAnalysisResult,
  AIReviewComment,
} from "../models/github.model";

export interface CommentFormatterConfig {
  includeSeverityEmoji?: boolean;
  includeCategoryBadge?: boolean;
  includeAutoFixHint?: boolean;
  maxCommentLength?: number;
}

/**
 * Service for formatting static analysis results into structured review comments.
 * Provides a dedicated, efficient way to generate rule-based review comments
 * with consistent formatting and categorization.
 */
export class ReviewCommentFormatter {
  private config: Required<CommentFormatterConfig>;

  constructor(config: CommentFormatterConfig = {}) {
    this.config = {
      includeSeverityEmoji: config.includeSeverityEmoji ?? true,
      includeCategoryBadge: config.includeCategoryBadge ?? true,
      includeAutoFixHint: config.includeAutoFixHint ?? true,
      maxCommentLength: config.maxCommentLength ?? 63000,
    };
  }

  /**
   * Generate review comments from static analysis results.
   * Filters by severity and formats each result into a structured comment.
   */
  generateComments(
    staticAnalysisResults: StaticAnalysisResult[],
    options?: {
      minSeverity?: "error" | "warning" | "info";
      includeInfo?: boolean;
    }
  ): AIReviewComment[] {
    const minSeverity = options?.minSeverity ?? "warning";
    const includeInfo = options?.includeInfo ?? false;

    const severityOrder: Record<string, number> = {
      error: 0,
      warning: 1,
      info: 2,
    };

    const minSeverityLevel = severityOrder[minSeverity];

    return staticAnalysisResults
      .filter((result) => {
        const resultSeverityLevel = severityOrder[result.severity] ?? 2;
        return (
          resultSeverityLevel <= minSeverityLevel ||
          (includeInfo && result.severity === "info")
        );
      })
      .map((result) => this.formatComment(result))
      .filter((comment) => this.isValidComment(comment));
  }

  /**
   * Format a single static analysis result into a review comment.
   */
  private formatComment(result: StaticAnalysisResult): AIReviewComment {
    const body = this.buildCommentBody(result);
    const severity = this.mapSeverity(result.severity);
    const category = this.categorizeIssue(result);

    return {
      file: result.file,
      line: result.line,
      body: this.truncateComment(body),
      severity,
      category,
      fixSuggestion: result.suggestion || result.fix,
      autoFixable: result.fixable || false,
    };
  }

  /**
   * Build the comment body with all relevant information.
   */
  private buildCommentBody(result: StaticAnalysisResult): string {
    const parts: string[] = [];

    // Tool name and message
    const toolHeader = `**${result.tool.toUpperCase()}**: ${result.message}`;
    parts.push(toolHeader);

    // Rule information
    if (result.rule) {
      parts.push(`\n\nRule: \`${result.rule}\``);
    }

    // Severity indicator
    if (this.config.includeSeverityEmoji) {
      const severityEmoji = this.getSeverityEmoji(result.severity);
      if (severityEmoji) {
        parts.push(
          `\n\n${severityEmoji} ${this.getSeverityMessage(result.severity)}`
        );
      }
    }

    // Category badge
    if (this.config.includeCategoryBadge) {
      const category = this.categorizeIssue(result);
      const categoryBadge = this.getCategoryBadge(category);
      if (categoryBadge) {
        parts.push(`\n\n${categoryBadge}`);
      }
    }

    // Fix suggestions
    if (this.config.includeAutoFixHint) {
      if (result.fixable && result.fix) {
        parts.push(
          `\n\n🔧 **Auto-fix available**:\n\`\`\`bash\n${result.fix}\n\`\`\``
        );
      } else if (result.suggestion) {
        parts.push(`\n\n💡 **Suggestion**: ${result.suggestion}`);
      } else if (result.fix) {
        parts.push(`\n\n💡 **Fix**: ${result.fix}`);
      }
    }

    return parts.join("");
  }

  /**
   * Map static analysis severity to review comment severity.
   */
  private mapSeverity(
    severity: StaticAnalysisResult["severity"]
  ): AIReviewComment["severity"] {
    switch (severity) {
      case "error":
        return "blocker";
      case "warning":
        return "warning";
      case "info":
        return "suggestion";
      default:
        return "suggestion";
    }
  }

  /**
   * Categorize an issue based on rule and message content.
   */
  private categorizeIssue(
    result: StaticAnalysisResult
  ): AIReviewComment["category"] {
    const rule = result.rule?.toLowerCase() || "";
    const message = result.message.toLowerCase();

    // Security issues
    if (
      rule.includes("security") ||
      message.includes("security") ||
      message.includes("vulnerability") ||
      message.includes("xss") ||
      message.includes("sql injection") ||
      message.includes("csrf") ||
      message.includes("authentication")
    ) {
      return "security";
    }

    // Performance issues
    if (
      rule.includes("performance") ||
      message.includes("performance") ||
      message.includes("slow") ||
      message.includes("optimization") ||
      message.includes("memory leak") ||
      message.includes("timeout")
    ) {
      return "performance";
    }

    // Documentation issues
    if (
      rule.includes("doc") ||
      message.includes("documentation") ||
      message.includes("comment") ||
      message.includes("missing docstring")
    ) {
      return "documentation";
    }

    // Best practices
    if (
      rule.includes("best") ||
      rule.includes("practice") ||
      message.includes("best practice") ||
      message.includes("convention") ||
      message.includes("style")
    ) {
      return "best-practices";
    }

    // Default to code quality
    return "code-quality";
  }

  /**
   * Get emoji for severity level.
   */
  private getSeverityEmoji(severity: StaticAnalysisResult["severity"]): string {
    switch (severity) {
      case "error":
        return "🚨";
      case "warning":
        return "⚠️";
      case "info":
        return "ℹ️";
      default:
        return "";
    }
  }

  /**
   * Get human-readable severity message.
   */
  private getSeverityMessage(
    severity: StaticAnalysisResult["severity"]
  ): string {
    switch (severity) {
      case "error":
        return "This is a critical issue that should be addressed.";
      case "warning":
        return "This issue should be reviewed and fixed if possible.";
      case "info":
        return "This is a suggestion for improvement.";
      default:
        return "";
    }
  }

  /**
   * Get category badge for display.
   */
  private getCategoryBadge(category: AIReviewComment["category"]): string {
    if (!category) {
      return "";
    }

    const badges: Record<string, string> = {
      security: "🔒 **Category**: Security",
      performance: "⚡ **Category**: Performance",
      documentation: "📚 **Category**: Documentation",
      "best-practices": "✨ **Category**: Best Practices",
      "code-quality": "🔍 **Category**: Code Quality",
    };

    return badges[category] || "";
  }

  /**
   * Truncate comment if it exceeds max length.
   */
  private truncateComment(body: string): string {
    if (body.length <= this.config.maxCommentLength) {
      return body;
    }

    const truncated = body.substring(0, this.config.maxCommentLength - 3);
    return `${truncated}...`;
  }

  /**
   * Validate that a comment is valid and should be included.
   */
  private isValidComment(comment: AIReviewComment): boolean {
    return !!comment.file && !!comment.body && comment.body.trim().length > 0;
  }
}
