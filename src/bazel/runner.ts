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
      initiateBazelTest(testItem.id, workspacePath, run, testItem)
    );

    //clear testresult window


    const { input: testLog } = parseBazelOutput(stdout);
    const { input: bazelLog } = parseBazelOutput(stderr);

    if (code === 0) {
      if (testLog.length > 0) {
        const outputBlock = [
          getStatusHeader(code, testItem.id),
          '----- BEGIN OUTPUT -----',
          ...testLog,
          '------ END OUTPUT ------'
        ].join("\n");

        run.appendOutput(outputBlock.replace(/\r?\n/g, '\r\n') + '\r\n', undefined, testItem);
      }
      run.passed(testItem);
    } else if (code === 3) {
      handleTestResult(run, testItem, code, bazelLog, testLog, workspacePath);
    } else if (code === 4) {
      run.skipped(testItem);
      vscode.window.showWarningMessage(`⚠️ Flaky tests: ${testItem.id}`);
    } else {
      const cleaned = bazelLog.filter(line => line.trim() !== "").join("\n");
      const cleaned_with_Header = getStatusHeader(code, testItem.id) + cleaned;
      run.failed(testItem, new vscode.TestMessage(`🧨 Errors during tests (Code ${code}):\n\n${cleaned_with_Header}`));
      const outputBlock = [
        getStatusHeader(code, testItem.id),
        '----- BEGIN OUTPUT -----',
        ...bazelLog,
        '------ END OUTPUT ------'
      ].join("\n");
      run.appendOutput(outputBlock.replace(/\r?\n/g, '\r\n') + '\r\n', undefined, testItem);
    }
  } catch (error) {
    const message = formatError(error);
    logWithTimestamp(`Error executing test ${testItem.id}: ${message}`, "error");
    run.failed(testItem, new vscode.TestMessage(message));
  }
};

export const initiateBazelTest = async (
  testId: string,
  cwd: string,
  run: vscode.TestRun,
  testItem: vscode.TestItem
): Promise<{ code: number; stdout: string; stderr: string }> => {
  let effectiveTestId = testId;

  if (/^\/\/[^:]*$/.test(testId)) {
    effectiveTestId = `${testId}//...`;
  }

  const config = vscode.workspace.getConfiguration("bazelTestRunner");
  const additionalArgs: string[] = config.get("testArgs", []);
  const args = ['test', effectiveTestId, '--test_output=all', ...additionalArgs];

  return runBazelCommand(
    args,
    cwd,
  );
};



export const parseBazelOutput = (stdout: string): { input: string[] } => {
  const input: string[] = [];
  stdout.split(/\r?\n/).forEach(line => {
    input.push(
      line
    );
  });
  return { input };
};

// ───────────────────────────────────────────────────────────────
// Analyse test results
// ───────────────────────────────────────────────

function handleTestResult(
  run: vscode.TestRun,
  testItem: vscode.TestItem,
  code: number,
  bazelLog: string[],
  testLog: string[],
  workspacePath: string
) {
  if (code === 0) {
    run.passed(testItem); // just to be sure
  } else {
    const messages = analyzeTestFailures(testLog, workspacePath, testItem);
    logWithTimestamp(`Analyzed test failures for ${testItem.id}: ${messages.length} messages found.`);
    if (messages.length > 0) {
      run.failed(testItem, messages);
      const outputBlock = [
        getStatusHeader(code, testItem.id),
        '----- BEGIN OUTPUT -----',
        ...testLog,
        '------ END OUTPUT ------'
      ].join("\n");

      run.appendOutput(outputBlock.replace(/\r?\n/g, '\r\n') + '\r\n', undefined, testItem);
    } else {
      const fallbackOutput = [
        getStatusHeader(code, testItem.id),
        '----- BEGIN OUTPUT -----',
        ...testLog.length ? testLog : bazelLog,
        '------ END OUTPUT ------'
      ].join("\n");

      run.failed(testItem, new vscode.TestMessage(fallbackOutput));
      run.appendOutput(fallbackOutput.replace(/\r?\n/g, '\r\n') + '\r\n', undefined, testItem);
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
    { pattern: /^(.+?):(\d+):.+?:FAIL:/, source: "Built-in" },
    { pattern: /^Error: (.+?):(\d+): /, source: "Built-in" },
    { pattern: /^\[FAIL\]\s+([^\s:]+\/[^\s:]+):\d+: Assertion Failed/, source: "Criterion (extended)" },
  ];

  const messages: vscode.TestMessage[] = [];
  const matchingLines = testLog.filter(line => failPatterns.some(({ pattern }) => pattern.test(line)));

  for (const line of matchingLines) {
    for (const { pattern, source } of failPatterns) {
      const match = line.match(pattern);
      if (match) {
        const [, file, lineStr] = match;
        // Robust path normalization and fallback
        const normalizedPath = path.normalize(file);
        const fullPath = path.isAbsolute(normalizedPath)
          ? normalizedPath
          : path.join(workspacePath, normalizedPath);
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
