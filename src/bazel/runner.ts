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
import { log } from 'console';

// ───────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────

export const executeBazelTest = async (
  testItem: vscode.TestItem,
  workspacePath: string,
  run: vscode.TestRun
) => {
  try {
    const typeMatch = testItem.label.match(/\[(.*?)\]/);
    const testType = typeMatch?.[1] ?? "";
    const isSuite = testType === "test_suite";

    const { code, stdout, stderr } = await measure(`Execute test: ${testItem.id}`, () =>
      initiateBazelTest(testItem.id, workspacePath, run, testItem)
    );

    if (isSuite) {
      const resultLines = stdout.split(/\r?\n/).filter(line => line.match(/^\/\/.* (PASSED|FAILED|TIMEOUT|FLAKY)/));

      let passed = 0;
      let failed = 0;

      const rows = resultLines.map(line => {
        const parts = line.trim().split(/\s+/);

        let target: string;
        let status: "PASSED" | "FAILED" | "TIMEOUT" | "FLAKY" | string;
        let isCached: string;
        let testTime: string;

        if (parts.length === 5) {
          target = parts[0];
          isCached = parts[1];
          status = parts[2];
          testTime = parts[4];
        } else {
          target = parts[0];
          status = parts[1];
          isCached = "";
          testTime = parts[3];
        }

        const symbolMap: Record<string, string> = {
          PASSED: "✅ Passed",
          FAILED: "❌ Failed",
          TIMEOUT: "⏱ Timeout",
          FLAKY: "⚠️ Flaky",
        };
        const symbol = symbolMap[status] ?? `${status}`;

        if (status === "PASSED") passed++;
        else if (status === "FAILED") failed++;

        return `${target}  : ${symbol} (${isCached ? "cached, " : ""}${testTime})`;
      });

      const summaryHeader = `🧪 Test-Suite: ${testItem.id} : ${passed} Passed / ${failed} Failed`;
      const resultBlock = [summaryHeader, "────────────────────────────────────────────", ...rows].join("\n");

      const statusMessage = new vscode.TestMessage(`🧪 Suite Result:\n\n${resultBlock}`);
      if (code === 0) {
        run.passed(testItem);
      } else {
        run.failed(testItem, statusMessage);
      }
      run.appendOutput(resultBlock.replace(/\r?\n/g, '\r\n') + '\r\n', undefined, testItem);
      return;
    }

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
  const args = ['test', effectiveTestId, '--test_output=all --test_verbose_timeout_warnings', ...additionalArgs];

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
    { pattern: /^(.+?):(\d+):\d+: error/, source: "Built-in" },
    { pattern: /^(.+?)\((\d+)\): error/, source: "Built-in" },
    { pattern: /^(.+?):(\d+): error/, source: "Built-in" },
    { pattern: /^FAIL .*?\((.+?):(\d+)\)$/, source: "Built-in" },
    { pattern: /^(.+?):(\d+):.+?:FAIL:/, source: "Built-in" },
    { pattern: /^Error: (.+?):(\d+): /, source: "Built-in" },
    { pattern: /^\s*File "(.*?)", line (\d+), in .+$/, source: "Python Traceback" },
    { pattern: /^(.+?):(\d+): AssertionError$/, source: "Python AssertionError" },
    { pattern: /^\[----\] (.+?):(\d+): Assertion Failed$/, source: "Built-in" },
    { pattern: /^.*panicked at .*?([^\s:]+):(\d+):\d+:$/, source: "Rust panic" },
    { pattern: /^(.*):(\d+):\s+ERROR:\s+(REQUIRE|CHECK|CHECK_EQ)\(\s*(.*?)\s*\)\s+is\s+NOT\s+correct!/, source: "Built-in" },
    { pattern: /^Assertion failed: .*?, function .*?, file (.+?), line (\d+)\./, source: "Built-in" },
  ];

  const messages: vscode.TestMessage[] = [];
  const matchingLines = testLog.filter(line => failPatterns.some(({ pattern }) => pattern.test(line)));

  for (const line of matchingLines) {
    let bestMatch: {
      match: RegExpMatchArray;
      pattern: RegExp;
      source: string;
    } | null = null;
    for (const { pattern, source } of failPatterns) {
      const match = line.match(pattern);
      if (match) {
        if (!bestMatch || match[0].length > bestMatch.match[0].length) {
          bestMatch = { match, pattern, source };
        }
      }
    }
    if (bestMatch) {
      const [, file, lineStr] = bestMatch.match;
      const normalizedPath = path.normalize(file);
      const trimmedPath = normalizedPath.includes(`${path.sep}_main${path.sep}`)
        ? normalizedPath.substring(normalizedPath.indexOf(`${path.sep}_main${path.sep}`) + "_main".length + 1)
        : normalizedPath;
      const fullPath = path.join(workspacePath, trimmedPath);
      logWithTimestamp(`Pattern matched: [${bestMatch.source}] ${bestMatch.pattern}`);
      logWithTimestamp(`✔ Found & used: ${file}:${lineStr}`);
      if (fs.existsSync(fullPath)) {
        const uri = vscode.Uri.file(fullPath);
        const location = new vscode.Location(uri, new vscode.Position(Number(lineStr) - 1, 0));
        const fullText = [line, '', ...testLog].join("\n");
        const message = new vscode.TestMessage(fullText);
        message.location = location;
        messages.push(message);
      } else {
        logWithTimestamp(`File not found: ${fullPath}`);
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
