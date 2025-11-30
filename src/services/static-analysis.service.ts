import { spawn } from "child_process";
import { readFile, writeFile, mkdir, rm } from "fs/promises";
import { join, resolve, relative } from "path";
import { platform, tmpdir } from "os";
import type { StaticAnalysisResult } from "../models/github.model";

export interface StaticAnalysisConfig {
  eslint?: {
    enabled: boolean;
    configPath?: string;
  };
  flake8?: {
    enabled: boolean;
    configPath?: string;
  };
}

export class StaticAnalysisService {
  private config: StaticAnalysisConfig;

  constructor(config: StaticAnalysisConfig = {}) {
    this.config = {
      eslint: { enabled: true, ...config.eslint },
      flake8: { enabled: true, ...config.flake8 },
    };
  }

  /**
   * Safely execute a command using spawn with argument arrays.
   * On Windows, shell: true is required for .cmd files, but we still pass
   * arguments as an array to prevent command injection.
   */
  private async spawnCommand(
    command: string,
    args: string[],
    options: {
      cwd: string;
      maxBuffer?: number;
    }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const errorChunks: Buffer[] = [];

      const isWindows = platform() === "win32";

      // On Windows, we need shell: true for .cmd files, but we still pass
      // arguments as an array which prevents most injection attacks
      const child = spawn(command, args, {
        cwd: options.cwd,
        shell: isWindows, // Enable shell on Windows for .cmd files
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout?.on("data", (chunk) => {
        chunks.push(chunk);
      });

      child.stderr?.on("data", (chunk) => {
        errorChunks.push(chunk);
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", (code) => {
        const stdout = Buffer.concat(chunks).toString("utf-8");
        const stderr = Buffer.concat(errorChunks).toString("utf-8");
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 0,
        });
      });
    });
  }

  /**
   * Validate and sanitize file path to prevent directory traversal attacks.
   */
  private validateFilePath(filePath: string, workingDir: string): string {
    // Resolve the path to ensure it's within the working directory
    const resolvedPath = resolve(workingDir, filePath);
    const resolvedWorkingDir = resolve(workingDir);

    // Check if the resolved path is within the working directory
    if (!resolvedPath.startsWith(resolvedWorkingDir)) {
      throw new Error(
        `Invalid file path: ${filePath} is outside working directory`
      );
    }

    // Return the relative path for use in commands
    return relative(workingDir, resolvedPath);
  }

  /**
   * Validate config path to prevent command injection.
   */
  private validateConfigPath(
    configPath: string | undefined
  ): string | undefined {
    if (!configPath) {
      return undefined;
    }

    // Reject paths with shell metacharacters
    if (/[;&|`$(){}[\]<>"']/.test(configPath)) {
      throw new Error(
        `Invalid config path: ${configPath} contains unsafe characters`
      );
    }

    return configPath;
  }

  async analyzeFile(
    filePath: string,
    content: string
  ): Promise<StaticAnalysisResult[]> {
    const results: StaticAnalysisResult[] = [];
    const fileExtension = this.getFileExtension(filePath);

    // Create temporary directory for analysis
    const workingDir = join(
      tmpdir(),
      `static-analysis-${Date.now()}-${Math.random().toString(36).substring(7)}`
    );
    await mkdir(workingDir, { recursive: true });

    try {
      // Write file to working directory for analysis
      const fullPath = join(workingDir, filePath);
      const dir = join(fullPath, "..");
      await mkdir(dir, { recursive: true });
      await writeFile(fullPath, content, "utf-8");

      // Run ESLint for JS/TS files
      if (
        this.config.eslint?.enabled &&
        (fileExtension === "js" ||
          fileExtension === "jsx" ||
          fileExtension === "ts" ||
          fileExtension === "tsx")
      ) {
        const eslintResults = await this.runESLint(fullPath, workingDir);
        results.push(...eslintResults);
      }

      // Run Flake8 for Python files
      if (this.config.flake8?.enabled && fileExtension === "py") {
        const flake8Results = await this.runFlake8(fullPath, workingDir);
        results.push(...flake8Results);
      }
    } catch (error) {
      console.error(`Error analyzing file ${filePath}:`, error);
    } finally {
      // Cleanup temporary directory
      await rm(workingDir, { recursive: true, force: true });
    }

    return results;
  }

  async attemptAutoFix(
    filePath: string,
    workingDir: string
  ): Promise<{ fixed: boolean; fixedContent?: string; fixes: string[] }> {
    const fixes: string[] = [];
    const fileExtension = this.getFileExtension(filePath);
    const fullPath = join(workingDir, filePath);
    let fixed = false;
    let fixedContent: string | undefined;

    try {
      // Attempt ESLint auto-fix
      if (
        this.config.eslint?.enabled &&
        (fileExtension === "js" ||
          fileExtension === "jsx" ||
          fileExtension === "ts" ||
          fileExtension === "tsx")
      ) {
        const eslintFixed = await this.attemptESLintFix(fullPath, workingDir);
        if (eslintFixed.fixed) {
          fixed = true;
          fixes.push(...eslintFixed.fixes);
        }
      }

      // Read the fixed content if any fixes were applied
      if (fixed) {
        fixedContent = await readFile(fullPath, "utf-8");
      }
    } catch (error) {
      console.error(`Error attempting auto-fix for ${filePath}:`, error);
    }

    return { fixed, fixedContent, fixes };
  }

  private async runESLint(
    filePath: string,
    workingDir: string
  ): Promise<StaticAnalysisResult[]> {
    const results: StaticAnalysisResult[] = [];

    try {
      // Validate and sanitize file path
      const safeFilePath = this.validateFilePath(filePath, workingDir);
      const safeConfigPath = this.validateConfigPath(
        this.config.eslint?.configPath
      );

      // Build argument array safely
      const args: string[] = ["eslint", safeFilePath, "--format", "json"];
      if (safeConfigPath) {
        args.push("--config", safeConfigPath);
      }

      const { stdout, stderr, exitCode } = await this.spawnCommand(
        "npx",
        args,
        {
          cwd: workingDir,
          maxBuffer: 10 * 1024 * 1024, // 10MB
        }
      );

      // ESLint may exit with non-zero code if issues are found, but still output JSON
      if (stderr && !stdout && exitCode !== 0) {
        // ESLint errors are often in stderr, but if there's no stdout, skip
        return results;
      }

      // Try to parse output even if exit code is non-zero (ESLint returns non-zero when issues found)
      if (stdout) {
        try {
          const eslintOutput = JSON.parse(stdout);
          const relativePath = safeFilePath;

          for (const file of eslintOutput) {
            for (const message of file.messages || []) {
              const isFixable = message.fix !== undefined;
              results.push({
                file: relativePath,
                line: message.line,
                column: message.column,
                severity:
                  message.severity === 2
                    ? "error"
                    : message.severity === 1
                      ? "warning"
                      : "info",
                message: message.message,
                rule: message.ruleId || undefined,
                tool: "eslint",
                fixable: isFixable,
                fix: isFixable
                  ? `Run: npx eslint --fix ${relativePath}`
                  : undefined,
                suggestion: this.generateESLintSuggestion(message),
              });
            }
          }
        } catch (parseError) {
          // Ignore parse errors - command may have failed for other reasons
          console.warn(
            `Failed to parse ESLint output for ${filePath}:`,
            parseError instanceof Error
              ? parseError.message
              : String(parseError)
          );
        }
      }
    } catch (error: any) {
      // Command execution failed (e.g., command not found, permission denied)
      // Log but don't throw - allow other analysis tools to continue
      const errorMessage =
        error?.message || error?.stderr || "Unknown ESLint execution error";
      console.warn(`ESLint execution failed for ${filePath}: ${errorMessage}`);
    }

    return results;
  }

  private async runFlake8(
    filePath: string,
    workingDir: string
  ): Promise<StaticAnalysisResult[]> {
    const results: StaticAnalysisResult[] = [];

    try {
      // Validate and sanitize file path
      const safeFilePath = this.validateFilePath(filePath, workingDir);
      const safeConfigPath = this.validateConfigPath(
        this.config.flake8?.configPath
      );

      // Build argument array safely
      const args: string[] = [safeFilePath, "--format=json"];
      if (safeConfigPath) {
        args.push("--config", safeConfigPath);
      }

      const { stdout } = await this.spawnCommand("flake8", args, {
        cwd: workingDir,
        maxBuffer: 10 * 1024 * 1024,
      });

      // Flake8 may exit with non-zero code if issues are found, but still output JSON
      if (stdout) {
        try {
          const flake8Output = JSON.parse(stdout);
          const relativePath = safeFilePath;

          for (const issue of flake8Output) {
            results.push({
              file: relativePath,
              line: issue.line_number,
              column: issue.column_number,
              severity: issue.code?.startsWith("E") ? "error" : "warning",
              message: issue.text,
              rule: issue.code,
              tool: "flake8",
              fixable: false,
              suggestion: this.generateFlake8Suggestion(issue),
            });
          }
        } catch (parseError) {
          // Ignore parse errors - command may have failed for other reasons
          console.warn(
            `Failed to parse Flake8 output for ${filePath}:`,
            parseError instanceof Error
              ? parseError.message
              : String(parseError)
          );
        }
      }
    } catch (error: any) {
      // Command execution failed (e.g., command not found, permission denied)
      // Log but don't throw - allow other analysis tools to continue
      const errorMessage =
        error?.message || error?.stderr || "Unknown Flake8 execution error";
      console.warn(`Flake8 execution failed for ${filePath}: ${errorMessage}`);
    }

    return results;
  }

  private async attemptESLintFix(
    filePath: string,
    workingDir: string
  ): Promise<{ fixed: boolean; fixes: string[] }> {
    const fixes: string[] = [];
    try {
      // Validate and sanitize file path
      const safeFilePath = this.validateFilePath(filePath, workingDir);
      const safeConfigPath = this.validateConfigPath(
        this.config.eslint?.configPath
      );

      // Build argument array safely
      const args: string[] = ["eslint", safeFilePath, "--fix"];
      if (safeConfigPath) {
        args.push("--config", safeConfigPath);
      }

      const { exitCode, stderr } = await this.spawnCommand("npx", args, {
        cwd: workingDir,
        maxBuffer: 10 * 1024 * 1024,
      });

      // ESLint may exit with non-zero even if some fixes were applied
      // Exit code 0 means success, non-zero could mean errors or partial fixes
      if (exitCode === 0) {
        fixes.push("ESLint auto-fixes applied");
        return { fixed: true, fixes };
      } else {
        // Command ran but may have errors - some fixes might have been applied
        const errorMsg = stderr ? `: ${stderr}` : "";
        console.warn(
          `ESLint fix command exited with code ${exitCode} for ${filePath}${errorMsg}`
        );
        // Assume some fixes may have been applied even with non-zero exit
        fixes.push("ESLint auto-fixes attempted (some errors may remain)");
        return { fixed: true, fixes };
      }
    } catch (error: any) {
      // Command execution failed (e.g., command not found, permission denied)
      const errorMessage =
        error?.message || error?.stderr || "Unknown ESLint fix error";

      if (error?.code === "ENOENT" || error?.code === 127) {
        // Command not found - no fixes applied
        console.warn(
          `ESLint fix command not found for ${filePath}: ${errorMessage}`
        );
        return { fixed: false, fixes };
      }

      console.warn(`ESLint fix failed for ${filePath}: ${errorMessage}`);
      return { fixed: false, fixes };
    }
  }

  private generateESLintSuggestion(message: any): string {
    const rule = message.ruleId || "";
    const msg = message.message || "";

    // Common ESLint rule suggestions
    if (rule.includes("no-unused")) {
      return "Remove unused variable or import.";
    }
    if (rule.includes("prefer-const")) {
      return "Use `const` instead of `let` if the variable is never reassigned.";
    }
    if (rule.includes("no-var")) {
      return "Use `let` or `const` instead of `var`.";
    }
    if (rule.includes("eqeqeq")) {
      return "Use strict equality (`===`) instead of loose equality (`==`).";
    }
    if (rule.includes("semi")) {
      return msg.includes("Missing semicolon")
        ? "Add a semicolon at the end of the statement."
        : "Remove the semicolon.";
    }
    if (rule.includes("quotes")) {
      return "Use consistent quote style (single or double quotes).";
    }
    if (rule.includes("indent")) {
      return "Fix indentation to match the project's style guide.";
    }

    // Generic suggestion based on message
    if (msg.includes("is defined but never used")) {
      return "Remove the unused variable or use it in your code.";
    }
    if (msg.includes("Unexpected")) {
      return `Fix the syntax error: ${msg}`;
    }

    return `Review the ESLint rule \`${rule}\` and fix the issue: ${msg}`;
  }

  private generateFlake8Suggestion(issue: any): string {
    const code = issue.code || "";
    const text = issue.text || "";

    // Common Flake8 error code suggestions
    if (code === "E501") {
      return "Line too long. Break it into multiple lines or use shorter variable names.";
    }
    if (code === "E302" || code === "E305") {
      return "Add blank lines to separate code sections as per PEP 8.";
    }
    if (code === "E303") {
      return "Remove extra blank lines.";
    }
    if (code === "E401") {
      return "Import statements should be on separate lines.";
    }
    if (code === "E402") {
      return "Move imports to the top of the file.";
    }
    if (code === "E501") {
      return "Line exceeds maximum length. Break it into multiple lines.";
    }
    if (code.startsWith("F")) {
      return "Pyflakes detected an issue. Review the code logic.";
    }
    if (code.startsWith("W")) {
      return "Code style warning. Follow PEP 8 guidelines.";
    }

    return `Fix the Flake8 issue: ${text}`;
  }

  private getFileExtension(filePath: string): string {
    const parts = filePath.split(".");
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
  }
}
