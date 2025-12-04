#!/usr/bin/env node

/**
 * Lambda Packaging Script
 *
 * This script creates a deployment package for AWS Lambda by:
 * 1. Building the TypeScript project (if not already built)
 * 2. Creating a temporary directory with dist/ and node_modules/
 * 3. Creating a zip file ready for Lambda deployment
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist");
const nodeModulesDir = path.join(projectRoot, "node_modules");
const packageDir = path.join(projectRoot, "lambda-package");
const zipFile = path.join(projectRoot, "lambda-deployment.zip");

// Colors for console output
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
};

function log(message, color = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logStep(step, message) {
  log(`\n[${step}] ${message}`, "blue");
}

function logSuccess(message) {
  log(`✓ ${message}`, "green");
}

function logError(message) {
  log(`✗ ${message}`, "red");
}

function logWarning(message) {
  log(`⚠ ${message}`, "yellow");
}

// Check if dist directory exists
if (!fs.existsSync(distDir)) {
  logError('dist/ directory not found. Run "npm run build" first.');
  process.exit(1);
}

// Check if node_modules exists
if (!fs.existsSync(nodeModulesDir)) {
  logError('node_modules/ directory not found. Run "npm install" first.');
  process.exit(1);
}

logStep("1", "Cleaning up previous package...");
// Remove existing package directory and zip file
if (fs.existsSync(packageDir)) {
  fs.rmSync(packageDir, { recursive: true, force: true });
  logSuccess("Removed existing lambda-package/ directory");
}

if (fs.existsSync(zipFile)) {
  fs.unlinkSync(zipFile);
  logSuccess("Removed existing lambda-deployment.zip");
}

logStep("2", "Creating package directory...");
fs.mkdirSync(packageDir, { recursive: true });
logSuccess("Created lambda-package/ directory");

logStep("3", "Copying dist/ directory...");
copyDirectory(distDir, path.join(packageDir, "dist"));
logSuccess("Copied dist/ directory");

logStep("4", "Copying node_modules/ directory...");
copyDirectory(nodeModulesDir, path.join(packageDir, "node_modules"));
logSuccess("Copied node_modules/ directory");

logStep("5", "Creating deployment zip file...");
try {
  // Use native zip command if available, otherwise provide instructions
  const isWindows = process.platform === "win32";

  if (isWindows) {
    // On Windows, try PowerShell Compress-Archive
    try {
      execSync(
        `powershell -Command "Compress-Archive -Path '${packageDir}\\*' -DestinationPath '${zipFile}' -Force"`,
        { stdio: "inherit" }
      );
      logSuccess("Created lambda-deployment.zip using PowerShell");
    } catch (error) {
      logWarning(
        "PowerShell compression failed. Please manually zip the lambda-package/ directory."
      );
      logWarning(`Package directory: ${packageDir}`);
      logWarning(
        "You can use: powershell -Command \"Compress-Archive -Path 'lambda-package\\*' -DestinationPath 'lambda-deployment.zip'\""
      );
      process.exit(1);
    }
  } else {
    // On Unix-like systems, use zip command
    try {
      execSync(`cd ${packageDir} && zip -r ${zipFile} .`, { stdio: "inherit" });
      logSuccess("Created lambda-deployment.zip using zip command");
    } catch (error) {
      logWarning(
        "zip command not found. Please install zip or manually create the zip file."
      );
      logWarning(`Package directory: ${packageDir}`);
      logWarning(
        "You can use: cd lambda-package && zip -r ../lambda-deployment.zip ."
      );
      process.exit(1);
    }
  }
} catch (error) {
  logError("Failed to create zip file");
  console.error(error);
  process.exit(1);
}

// Get file size
const stats = fs.statSync(zipFile);
const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

logStep("6", "Package summary:");
logSuccess(`Deployment package created: ${zipFile}`);
logSuccess(`Package size: ${fileSizeMB} MB`);
logSuccess(`Handler: handler.handler`);
logSuccess(`Entry point: dist/handler.js`);

log("\n📦 Lambda deployment package is ready!", "green");
log("\nNext steps:", "blue");
log("1. Upload lambda-deployment.zip to AWS Lambda");
log("2. Set handler to: handler.handler");
log("3. Configure environment variables (see README.md)");
log("4. Set timeout to at least 5 minutes (300 seconds)");
log("5. Configure API Gateway to route to this Lambda function");

// Helper function to copy directory recursively
function copyDirectory(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
