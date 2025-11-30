import axios from "axios";
import type {
  StaticAnalysisResult,
  AIReviewComment,
  GitHubFileChange,
} from "../models/github.model";
import { ReviewCommentFormatter } from "./review-comment-formatter.service";

export interface AIReviewConfig {
  apiUrl?: string;
  model?: string;
  maxComments?: number;
  maxPromptLength?: number; // Maximum prompt length in characters (default: 25000)
  chunkSize?: number; // Maximum chunk size in characters for splitting large files (default: 20000)
  maxTokens?: number; // Maximum tokens for AI response generation (default: 8000) - prevents truncation
}

export class AIReviewService {
  private config: AIReviewConfig;
  private ollamaUrl: string;
  private commentFormatter: ReviewCommentFormatter;

  constructor(config: AIReviewConfig = {}) {
    // Trim API URL and model to remove any whitespace
    const apiUrl = config.apiUrl?.trim();
    const model = config.model?.trim();

    this.config = {
      model: model || "qwen2.5-coder:7b",
      maxComments: config.maxComments || 10,
      apiUrl: apiUrl,
      maxPromptLength: config.maxPromptLength || 25000, // Default: ~25K chars (safe for 7B models)
      chunkSize: config.chunkSize || 20000, // Default: 20K chars per chunk
      maxTokens: config.maxTokens || 8000, // Default: 8000 tokens to prevent JSON truncation
    };

    // Default Ollama URL if not provided
    this.ollamaUrl = this.config.apiUrl || "http://localhost:11434";

    // Initialize comment formatter
    this.commentFormatter = new ReviewCommentFormatter({
      includeSeverityEmoji: true,
      includeCategoryBadge: true,
      includeAutoFixHint: true,
    });
  }

  async generateReviewComments(
    fileContent: string,
    filePath: string,
    staticAnalysisResults: StaticAnalysisResult[],
    fileChange: GitHubFileChange
  ): Promise<AIReviewComment[]> {
    const comments: AIReviewComment[] = [];
    const chunkSize = this.config.chunkSize || 20000;

    // Check if file needs to be split into chunks
    if (fileContent.length > chunkSize) {
      console.log(
        `📦 File ${filePath} is large (${fileContent.length} chars). Splitting into chunks of ≤${chunkSize} chars...`
      );

      // Split file into chunks
      const chunks = this.splitFileIntoChunks(fileContent, chunkSize);
      console.log(`  Split into ${chunks.length} chunk(s)`);

      // Process each chunk separately
      const chunkComments: AIReviewComment[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(
          `  Processing chunk ${i + 1}/${chunks.length} (${chunk.content.length} chars, lines ${chunk.startLine}-${chunk.endLine})...`
        );

        try {
          // Filter static analysis results for this chunk's line range
          const chunkStaticAnalysis = staticAnalysisResults.filter(
            (result) =>
              result.line !== undefined &&
              result.line >= chunk.startLine &&
              result.line <= chunk.endLine
          );

          // Create a modified file change object for this chunk
          const chunkFileChange: GitHubFileChange = {
            ...fileChange,
            // Adjust additions/deletions proportionally (rough estimate)
            additions: Math.floor(
              (fileChange.additions * chunk.content.length) / fileContent.length
            ),
            deletions: Math.floor(
              (fileChange.deletions * chunk.content.length) / fileContent.length
            ),
          };

          const aiComments = await this.callAIAPI(
            chunk.content,
            filePath,
            chunkStaticAnalysis,
            chunkFileChange,
            i + 1,
            chunks.length
          );
          chunkComments.push(...aiComments);
        } catch (error) {
          console.error(
            `Error processing chunk ${i + 1}/${chunks.length}:`,
            error
          );
          // Continue with other chunks even if one fails
        }
      }

      // Merge comments from all chunks
      comments.push(...chunkComments);
      console.log(
        `✅ Collected ${comments.length} comment(s) from ${chunks.length} chunk(s)`
      );
    } else {
      // File is small enough - process normally
      try {
        const aiComments = await this.callAIAPI(
          fileContent,
          filePath,
          staticAnalysisResults,
          fileChange
        );
        comments.push(...aiComments);
      } catch (error) {
        console.error("Error calling Ollama API:", error);
        // Fall back to rule-based comments using the dedicated formatter
        console.log(`⚠️ Falling back to rule-based comments for ${filePath}`);
        comments.push(
          ...this.commentFormatter.generateComments(staticAnalysisResults, {
            minSeverity: "warning",
            includeInfo: false,
          })
        );
      }
    }

    // Limit number of comments
    return comments.slice(0, this.config.maxComments);
  }

  /**
   * Split file content into chunks of specified size, trying to split at line boundaries
   */
  private splitFileIntoChunks(
    content: string,
    maxChunkSize: number
  ): Array<{ content: string; startLine: number; endLine: number }> {
    const chunks: Array<{
      content: string;
      startLine: number;
      endLine: number;
    }> = [];
    const lines = content.split("\n");
    let currentChunk: string[] = [];
    let currentChunkSize = 0;
    let startLine = 1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineSize = line.length + 1; // +1 for newline character

      // If adding this line would exceed the chunk size, finalize current chunk
      if (
        currentChunkSize + lineSize > maxChunkSize &&
        currentChunk.length > 0
      ) {
        chunks.push({
          content: currentChunk.join("\n"),
          startLine,
          endLine: startLine + currentChunk.length - 1,
        });
        startLine = startLine + currentChunk.length;
        currentChunk = [];
        currentChunkSize = 0;
      }

      // Add line to current chunk
      currentChunk.push(line);
      currentChunkSize += lineSize;
    }

    // Add remaining chunk
    if (currentChunk.length > 0) {
      chunks.push({
        content: currentChunk.join("\n"),
        startLine,
        endLine: startLine + currentChunk.length - 1,
      });
    }

    return chunks;
  }

  private async callAIAPI(
    fileContent: string,
    filePath: string,
    staticAnalysisResults: StaticAnalysisResult[],
    fileChange: GitHubFileChange,
    chunkNumber?: number,
    totalChunks?: number
  ): Promise<AIReviewComment[]> {
    const prompt = this._buildAIPrompt(
      fileContent,
      filePath,
      staticAnalysisResults,
      fileChange,
      chunkNumber,
      totalChunks
    );

    try {
      const modelName = this.config.model || "qwen2.5-coder:7b";
      const apiUrl = `${this.ollamaUrl}/api/generate`;

      const response = await axios.post(apiUrl, {
        model: modelName,
        prompt,
        stream: false,
        options: {
          temperature: 0.7,
          num_predict: this.config.maxTokens || 8000, // Use configurable token limit to prevent truncation
        },
      });

      const generatedText = response.data.response || "";

      // Check if response was truncated
      // For streaming=false, done should be true, but we'll also detect truncation from incomplete JSON
      const isTruncated = response.data.done === false;

      const parsedComments = this._parseAIResponse(
        generatedText,
        filePath,
        isTruncated
      );

      // If this is a chunk, adjust line numbers to account for chunk offset
      // Note: Line numbers are already relative to the chunk, so we need to adjust them
      // based on the chunk's start line. However, since we're processing chunks separately,
      // the line numbers in the response are relative to the chunk content.
      // We'll handle this in the chunking logic by tracking startLine.

      return parsedComments;
    } catch (error) {
      console.error("❌ Error calling Ollama API:", error);
      if (error instanceof Error) {
        console.error("Error message:", error.message);
        console.error("Error stack:", error.stack);

        // Check for connection errors
        if (
          error.message.includes("ECONNREFUSED") ||
          error.message.includes("connect") ||
          error.message.includes("ENOTFOUND")
        ) {
          console.error(
            "🔌 Connection failed - please ensure Ollama is running and accessible at " +
              this.ollamaUrl
          );
        }
      }
      throw error;
    }
  }

  /**
   * Parse GitHub patch to extract changed line numbers in the new file
   */
  private parseChangedLines(patch: string | undefined): number[] {
    if (!patch) {
      return [];
    }

    const changedLines: number[] = [];
    const lines = patch.split("\n");

    for (const line of lines) {
      // Match diff hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      const hunkMatch = line.match(
        /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/
      );
      if (hunkMatch) {
        const newStart = parseInt(hunkMatch[1], 10);

        // Track current line number in the new file
        let currentNewLine = newStart;

        // Process lines in this hunk
        for (let i = lines.indexOf(line) + 1; i < lines.length; i++) {
          const hunkLine = lines[i];

          // Stop if we hit another hunk header
          if (hunkLine.match(/^@@\s+-\d+/)) {
            break;
          }

          // Lines starting with + are additions (changed lines in new file)
          // Lines starting with - are deletions (not in new file)
          // Lines starting with space are unchanged context
          if (hunkLine.startsWith("+") && !hunkLine.startsWith("+++")) {
            changedLines.push(currentNewLine);
            currentNewLine++;
          } else if (hunkLine.startsWith("-") && !hunkLine.startsWith("---")) {
            // Deletion - don't increment new file line number
            // (this line doesn't exist in the new file)
          } else if (hunkLine.startsWith(" ") || hunkLine.startsWith("\\")) {
            // Context line - increment line number in both old and new
            currentNewLine++;
          }
        }
      }
    }

    return changedLines;
  }

  /**
   * Extract context around changed lines: changed lines + N lines above & below
   */
  private extractContext(
    fileContent: string,
    changedLines: number[],
    contextLines: number
  ): string {
    if (changedLines.length === 0) {
      // If no changed lines detected, return first 100 lines as fallback
      const lines = fileContent.split("\n");
      return lines.slice(0, 100).join("\n");
    }

    const allLines = fileContent.split("\n");
    const lineSet = new Set(changedLines);
    const includedLines = new Set<number>();

    // For each changed line, include context above and below
    for (const changedLine of changedLines) {
      const startLine = Math.max(1, changedLine - contextLines);
      const endLine = Math.min(allLines.length, changedLine + contextLines);

      for (let i = startLine; i <= endLine; i++) {
        includedLines.add(i);
      }
    }

    // Sort line numbers and build result
    const sortedLines = Array.from(includedLines).sort((a, b) => a - b);
    const result: string[] = [];
    let lastLine = 0;

    for (const lineNum of sortedLines) {
      // Add ellipsis if there's a gap
      if (lineNum > lastLine + 1 && lastLine > 0) {
        result.push(`... [${lineNum - lastLine - 1} lines omitted] ...`);
      }

      // Add line number comment for changed lines
      const prefix = lineSet.has(lineNum)
        ? `>>> Line ${lineNum} (changed): `
        : "";
      result.push(`${prefix}${allLines[lineNum - 1]}`);
      lastLine = lineNum;
    }

    return result.join("\n");
  }

  private _buildAIPrompt(
    fileContent: string,
    filePath: string,
    staticAnalysisResults: StaticAnalysisResult[],
    fileChange: GitHubFileChange,
    chunkNumber?: number,
    totalChunks?: number
  ): string {
    // Build chunk context message if this is a chunk
    const chunkContext =
      chunkNumber && totalChunks
        ? `\n\n⚠️ NOTE: This is chunk ${chunkNumber} of ${totalChunks} from a large file. Review this portion of the code in context. Line numbers in your response should be relative to this chunk (starting from 1).`
        : "";

    // Build the base prompt structure (without file content)
    const basePrompt = `You are a senior code reviewer. Review the following code change and provide constructive feedback.

File: ${filePath}${chunkContext}
Status: ${fileChange.status}
Additions: ${fileChange.additions}
Deletions: ${fileChange.deletions}

Static Analysis Results:
{ANALYSIS_SUMMARY}

Code${chunkNumber && totalChunks ? " (chunk content)" : " (showing only changed sections with context)"}:
\`\`\`
{FILE_CONTENT}
\`\`\`

Please provide code review comments focusing on:
1. Code quality and best practices
2. Potential bugs or issues
3. Performance improvements
4. Security concerns
5. Documentation needs

Format your response as a JSON array of comment objects. Each comment should have:
- file: string (the file path)
- line: number (optional, line number if applicable${chunkNumber && totalChunks ? " - relative to this chunk starting from line 1" : ""})
- body: string (the comment text)
- severity: string (optional, one of: "blocker", "warning", "info")
- category: string (optional, one of: "security", "performance", "documentation", "best-practices", "code-quality")

Example format:
[
  {
    "file": "${filePath}",
    "line": 10,
    "body": "Consider adding error handling here",
    "severity": "warning",
    "category": "code-quality"
  }
]

IMPORTANT: Respond ONLY with valid JSON. Do not include explanations, markdown code blocks, or any other text. If you cannot produce valid JSON, respond with: {"error": "failed"}.`;

    // Build analysis summary with limit
    const maxAnalysisResults = 50; // Limit analysis results to prevent prompt bloat
    const limitedAnalysisResults = staticAnalysisResults.slice(
      0,
      maxAnalysisResults
    );
    const analysisSummary = limitedAnalysisResults
      .map(
        (r) =>
          `- Line ${r.line}: [${r.severity}] ${r.message} (${r.rule || r.tool})`
      )
      .join("\n");

    if (staticAnalysisResults.length > maxAnalysisResults) {
      console.warn(
        `⚠️ Limiting static analysis results from ${staticAnalysisResults.length} to ${maxAnalysisResults} to keep prompt manageable`
      );
    }

    // For chunks, use the content directly. For full files, extract context.
    let contentToUse: string;
    if (chunkNumber && totalChunks) {
      // This is a chunk - use the chunk content directly
      contentToUse = fileContent;
    } else {
      // Extract changed lines from patch and get context
      const changedLines = this.parseChangedLines(fileChange.patch);
      contentToUse = this.extractContext(fileContent, changedLines, 10);

      const originalSize = fileContent.length;
      const contextSize = contentToUse.length;
      const reduction = (
        ((originalSize - contextSize) / originalSize) *
        100
      ).toFixed(1);

      console.log(
        `📊 Context extraction: ${originalSize} → ${contextSize} chars (${reduction}% reduction) for ${filePath}`
      );
    }

    const finalPrompt = basePrompt
      .replace("{ANALYSIS_SUMMARY}", analysisSummary || "No issues found")
      .replace("{FILE_CONTENT}", contentToUse);

    return finalPrompt;
  }

  private _parseAIResponse(
    response: string,
    defaultFilePath: string,
    isTruncated: boolean = false
  ): AIReviewComment[] {
    // Strip markdown code blocks if present (e.g., ```json ... ```)
    let cleanedResponse = response.trim();

    // Remove markdown code block markers (```json, ```, etc.)
    cleanedResponse = cleanedResponse.replace(/^```(?:json)?\s*/i, "");
    cleanedResponse = cleanedResponse.replace(/\s*```$/i, "");
    cleanedResponse = cleanedResponse.trim();

    // Try to parse as strict JSON first
    try {
      const json = JSON.parse(cleanedResponse);

      // Check if it's an error response
      if (json.error === "failed") {
        console.warn("AI returned error response: failed");
        return this._extractCommentsFromText(response, defaultFilePath);
      }

      // Check if it's an array of comments
      if (Array.isArray(json)) {
        return json.map((comment) => ({
          file: comment.file || defaultFilePath,
          line: comment.line,
          body: comment.body || "",
          severity: comment.severity || "suggestion",
          category: comment.category || "code-quality",
          fixSuggestion: comment.fixSuggestion,
          autoFixable: comment.autoFixable || false,
        }));
      }

      // If it's a single object, wrap it in an array
      if (json && typeof json === "object") {
        return [
          {
            file: json.file || defaultFilePath,
            line: json.line,
            body: json.body || "",
            severity: json.severity || "suggestion",
            category: json.category || "code-quality",
            fixSuggestion: json.fixSuggestion,
            autoFixable: json.autoFixable || false,
          },
        ];
      }
    } catch {
      // Fallback: try to extract JSON from the response or use text extraction
      console.warn(
        "Failed to parse AI response as strict JSON, attempting fallback..."
      );

      // Try to extract JSON array from the response
      const jsonMatch = this._extractJSONArray(cleanedResponse);
      if (jsonMatch) {
        try {
          const fixedJson = this._fixCommonJSONErrors(jsonMatch);
          const parsed = JSON.parse(fixedJson);
          if (Array.isArray(parsed)) {
            return parsed.map((comment) => ({
              file: comment.file || defaultFilePath,
              line: comment.line,
              body: comment.body || "",
              severity: comment.severity || "suggestion",
              category: comment.category || "code-quality",
              fixSuggestion: comment.fixSuggestion,
              autoFixable: comment.autoFixable || false,
            }));
          }
        } catch {
          // Continue to text extraction fallback
        }
      }

      // Check if this might be a truncation issue
      if (isTruncated || this._isLikelyTruncated(cleanedResponse)) {
        console.error(
          "❌ JSON response appears to be truncated. The AI response was cut off mid-JSON, which cannot be repaired."
        );
        console.error(
          `💡 Solution: Increase maxTokens in AIReviewConfig (current: ${this.config.maxTokens || 8000}). Truncation must be fixed at the source.`
        );
        // Return partial results if we can extract any valid comments
        return this._extractPartialComments(cleanedResponse, defaultFilePath);
      }

      // Final fallback: extract comments from text
      return this._extractCommentsFromText(response, defaultFilePath);
    }

    return [];
  }

  /**
   * Extract JSON array from text, handling nested brackets properly
   */
  private _extractJSONArray(text: string): string | null {
    // Find the first opening bracket
    const startIndex = text.indexOf("[");
    if (startIndex === -1) {
      return null;
    }

    // Count brackets to find the matching closing bracket
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = startIndex; i < text.length; i++) {
      const char = text[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === "\\") {
        escapeNext = true;
        continue;
      }

      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === "[") {
          depth++;
        } else if (char === "]") {
          depth--;
          if (depth === 0) {
            // Found the matching closing bracket
            return text.substring(startIndex, i + 1);
          }
        }
      }
    }

    return null;
  }

  /**
   * Fix common JSON syntax errors that AI models might produce
   * Only fixes safe, common issues like trailing commas, comments, and control characters
   */
  private _fixCommonJSONErrors(json: string): string {
    let fixed = json;

    // Remove trailing commas before closing brackets/braces
    // This is the most common JSON error from AI models
    fixed = fixed.replace(/,(\s*[}\]])/g, "$1");

    // Remove comments (JSON doesn't support comments, but AI might add them)
    fixed = fixed.replace(/\/\/.*$/gm, ""); // Single line comments
    fixed = fixed.replace(/\/\*[\s\S]*?\*\//g, ""); // Multi-line comments

    // Fix control characters within string literals
    fixed = this._escapeControlCharactersInStrings(fixed);

    return fixed;
  }

  /**
   * Escape control characters within JSON string literals
   * This handles unescaped newlines, tabs, and other control characters
   */
  private _escapeControlCharactersInStrings(json: string): string {
    let result = "";
    let inString = false;
    let escapeNext = false;
    let i = 0;

    while (i < json.length) {
      const char = json[i];
      const charCode = char.charCodeAt(0);

      if (escapeNext) {
        // We're escaping the next character, so add it as-is
        result += char;
        escapeNext = false;
        i++;
        continue;
      }

      if (char === "\\") {
        // Escape sequence - keep it and mark next char as escaped
        result += char;
        escapeNext = true;
        i++;
        continue;
      }

      if (char === '"') {
        // Toggle string state
        inString = !inString;
        result += char;
        i++;
        continue;
      }

      if (inString) {
        // We're inside a string literal
        // Check if this is a control character that needs escaping
        if (charCode < 0x20) {
          // Control character - escape it based on type
          if (char === "\n") {
            // Unescaped newline - escape it
            result += "\\n";
          } else if (char === "\r") {
            // Unescaped carriage return - escape it
            result += "\\r";
          } else if (char === "\t") {
            // Unescaped tab - escape it
            result += "\\t";
          } else {
            // Other control character - escape as Unicode
            result += `\\u${charCode.toString(16).padStart(4, "0")}`;
          }
        } else {
          // Regular character
          result += char;
        }
      } else {
        // Outside string - add as-is
        result += char;
      }

      i++;
    }

    return result;
  }

  private _extractCommentsFromText(
    text: string,
    defaultFilePath: string
  ): AIReviewComment[] {
    // Fallback: try to extract comments from plain text
    // Look for patterns like "Line X:", "Issue:", etc.
    const comments: AIReviewComment[] = [];
    const lines = text.split("\n");

    let currentComment: Partial<AIReviewComment> | null = null;

    for (const line of lines) {
      const lineMatch = line.match(/line\s+(\d+)/i);
      if (lineMatch) {
        if (currentComment) {
          comments.push({
            file: defaultFilePath,
            line: currentComment.line,
            body: currentComment.body || "",
            severity: "suggestion",
            category: "code-quality",
          });
        }
        currentComment = {
          line: parseInt(lineMatch[1], 10),
          body: line,
        };
      } else if (currentComment) {
        currentComment.body = (currentComment.body || "") + "\n" + line;
      }
    }

    if (currentComment) {
      comments.push({
        file: defaultFilePath,
        line: currentComment.line,
        body: currentComment.body || "",
        severity: "suggestion",
        category: "code-quality",
      });
    }

    // If no structured comments found, create a single general comment
    if (comments.length === 0 && text.trim().length > 0) {
      comments.push({
        file: defaultFilePath,
        body: text.trim(),
        severity: "suggestion",
        category: "code-quality",
      });
    }

    return comments;
  }

  /**
   * Check if JSON string is likely truncated (incomplete)
   */
  private _isLikelyTruncated(json: string): boolean {
    const trimmed = json.trim();

    // If JSON doesn't end with closing bracket/brace, it's likely truncated
    if (!trimmed.endsWith("]") && !trimmed.endsWith("}")) {
      return true;
    }

    // Count opening and closing brackets to check for imbalance
    const openBrackets = (trimmed.match(/\[/g) || []).length;
    const closeBrackets = (trimmed.match(/\]/g) || []).length;
    const openBraces = (trimmed.match(/\{/g) || []).length;
    const closeBraces = (trimmed.match(/\}/g) || []).length;

    // If brackets or braces are unbalanced, likely truncated
    if (openBrackets !== closeBrackets || openBraces !== closeBraces) {
      return true;
    }

    // Check if the last object/array appears incomplete (ends with comma or incomplete string)
    const lastChar = trimmed[trimmed.length - 1];
    if (lastChar === ",") {
      return true;
    }

    return false;
  }

  /**
   * Attempt to extract partial comments from truncated JSON
   * This is a fallback when truncation is detected
   */
  private _extractPartialComments(
    truncatedJson: string,
    defaultFilePath: string
  ): AIReviewComment[] {
    const comments: AIReviewComment[] = [];

    try {
      // Try to find complete comment objects before the truncation point
      // Look for complete objects: { ... }
      const objectPattern = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
      const matches = truncatedJson.match(objectPattern);

      if (matches) {
        for (const match of matches) {
          try {
            const parsed = JSON.parse(match);
            if (parsed.body || parsed.file) {
              comments.push({
                file: parsed.file || defaultFilePath,
                line: parsed.line,
                body: parsed.body || "",
                severity: parsed.severity || "suggestion",
                category: parsed.category || "code-quality",
                fixSuggestion: parsed.fixSuggestion,
                autoFixable: parsed.autoFixable || false,
              });
            }
          } catch {
            // Skip invalid objects
            continue;
          }
        }
      }

      if (comments.length > 0) {
        console.warn(
          `⚠️ Extracted ${comments.length} partial comment(s) from truncated response. Some comments may be missing.`
        );
      }
    } catch (error) {
      console.warn(
        "Failed to extract partial comments from truncated JSON:",
        error
      );
    }

    return comments;
  }
}
