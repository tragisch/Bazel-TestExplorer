/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { runBazelCommand } from './process';
import { logWithTimestamp, measure, formatError } from '../logging';

// ───────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────

export const executeBazelTest = async (
  testItem: vscode.TestItem,
  workspacePath: string,
  run: vscode.TestRun
) => {
  try {
    const { code, stdout, stderr } = await measure(`Execute test: ${testItem.id}`, () =>
      initiateBazelTest(testItem.id, workspacePath)
    );

    const output = generateTestResultMessage(testItem.id, code, stdout, stderr);

    run.appendOutput(output.replace(/\r?\n/g, '\r\n') + "\r\n");

    // Spezifische Behandlung basierend auf Exit-Code
    if (code === 0) {
      run.passed(testItem);
    } else if (code === 3) {
      run.failed(testItem, new vscode.TestMessage(`❌ Some tests fails.`));
    } else if (code === 4) {
      run.skipped(testItem);
      vscode.window.showWarningMessage(`⚠️ Flaky tests: ${testItem.id}`);
    } else {
      run.failed(testItem, new vscode.TestMessage(`🧨 Errors during tests (Code ${code}).`));
    }
  } catch (error) {
    const message = formatError(error);
    run.appendOutput(`Error executing test:\n${message}`.replace(/\r?\n/g, '\r\n') + "\r\n");
    run.failed(testItem, new vscode.TestMessage(message));
  }
};

export const initiateBazelTest = (testId: string, cwd: string): Promise<{ code: number, stdout: string, stderr: string }> => {
  let effectiveTestId = testId;

  // If the testId is a file path, we need to ensure it is in the correct format for Bazel
  if (/^\/\/[^:]*$/.test(testId)) {
    effectiveTestId = `${testId}//...`;
  }

  const args = ['test', effectiveTestId, '--test_output=all'];
  return runBazelCommand(args, cwd);
};

export const parseBazelStdoutOutput = (stdout: string): { bazelLog: string[], testLog: string[] } => {
  const bazelLog: string[] = [];
  const testLog: string[] = [];

  stdout.split("\n").forEach(line => {
    if (line.startsWith("INFO:") || line.startsWith("WARNING:") || line.includes("Test execution time")) {
      bazelLog.push(line);
    } else {
      testLog.push(line);
    }
  });

  return { bazelLog, testLog };
};

// ───────────────────────────────────────────────────────────────
// Analyse test results
// ───────────────────────────────────────────────

function handleTestResult(
  run: vscode.TestRun,
  testItem: vscode.TestItem,
  code: number,
  output: string,
  testLog: string[],
  workspacePath: string
) {
  if (code === 0) {
    run.passed(testItem);
  } else {
    const messages = analyzeTestFailures(testLog, workspacePath, testItem);
    if (messages.length > 0) {
      run.failed(testItem, messages);
    } else {
      run.failed(testItem, new vscode.TestMessage(output));
    }
  }
}

function analyzeTestFailures(testLog: string[], workspacePath: string, testItem: vscode.TestItem): vscode.TestMessage[] {
  const config = vscode.workspace.getConfiguration("bazelTestRunner");
  const customPatterns = config.get<string[]>("failLinePatterns", []);
  const failPatterns: { pattern: RegExp; source: string }[] = [
    ...customPatterns.map(p => {
      try {
        return { pattern: new RegExp(p), source: "Custom Setting" };
      } catch (e) {
        logWithTimestamp(`Invalid regex pattern in settings: "${p}"`, "warn");
        return null;
      }
    }).filter((p): p is { pattern: RegExp; source: string } => p !== null),
    { pattern: /^(.+?):(\d+): Failure/, source: "Built-in" },
    { pattern: /^(.+?):(\d+): FAILED/, source: "Built-in" },
    { pattern: /^(.+?)\((\d+)\): error/, source: "Built-in" },
    { pattern: /^(.+?):(\d+): error/, source: "Built-in" },
    { pattern: /^FAIL .*?\((.+?):(\d+)\)$/, source: "Built-in" },
    { pattern: /^Error: (.+?):(\d+): /, source: "Built-in" },
  ];

  const messages: vscode.TestMessage[] = [];
  const matchingLines = testLog.filter(line => failPatterns.some(({ pattern }) => pattern.test(line)));

  for (const line of matchingLines) {
    for (const { pattern, source } of failPatterns) {
      const match = line.match(pattern);
      if (match) {
        const [, file, lineStr] = match;
        const fullPath = path.isAbsolute(file)
          ? file
          : path.join(workspacePath, file);
        logWithTimestamp(`Pattern matched: [${source}] ${pattern}`);
        logWithTimestamp(`✔ Found & used: ${fullPath}:${lineStr}`);
        if (fs.existsSync(fullPath)) {
          const uri = vscode.Uri.file(fullPath);
          const location = new vscode.Location(uri, new vscode.Position(Number(lineStr) - 1, 0));
          const message = new vscode.TestMessage(line);
          message.location = location;
          messages.push(message);
          break;
        } else {
          logWithTimestamp(`File not found: ${fullPath}`);
        }
      }
    }
  }

  return messages;
}

function generateTestResultMessage(
  testId: string,
  code: number,
  stdout: string,
  stderr: string
): string {
  const header = getStatusHeader(code, testId);

  // Filtere redundante Informationen
  const { bazelLog, testLog } = parseBazelStdoutOutput(stdout);
  const formattedTestLog = testLog.length > 0
    ? `📄 **Test Log:**\n${testLog.join("\n")}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`
    : "";
  const formattedBazelLog = bazelLog.length > 0
    ? `📌 **Bazel Output:**\n${bazelLog.filter(line => !testLog.includes(line)).join("\n")}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`
    : "";
  const formattedStderr = stderr.trim()
    ? `📕 **Bazel stderr:**\n${stderr.trim()}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`
    : "";

  return `${header}${formattedTestLog}${formattedBazelLog}${formattedStderr}`;
}

// ───────────────────────────────────────────────────────────────
// Formatting functions
// ───────────────────────────────────────────────────────────────

const getStatusHeader = (code: number, testId: string): string => {
  const status = ({
    0: "✅ **Test Passed (Code 0)**",
    3: "❌ **Some Tests Failed (Code 3)**",
    4: "⚠️ **Flaky Test Passed (Code 4)**",
  })[code] ?? `🧨 **Build or Config Error (code ${code})**`;

  return `${status}: ${testId}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
};

const formatTestLog = (log: string[]): string =>
  log.length > 0 ? `📄 **Test Log:**\n${log.join("\n")}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` : "";

const formatBazelLog = (log: string[]): string =>
  log.length > 0 ? `📌 **Bazel Output:**\n${log.join("\n")}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` : "";

const formatStderr = (stderr: string): string =>
  `📕 **Bazel stderr:**\n${stderr.trim()}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;