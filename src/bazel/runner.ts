// Mapping from Bazel rule/test type to allowed pattern IDs
// Note: Many C/C++ tests (cc_test) can use different frameworks (Unity, gtest, catch2, etc.).
// Therefore we include Unity patterns for cc_test as well.
const PATTERN_IDS_BY_TEST_TYPE: Record<string, string[]> = {
  unity_test: ["unity_c_standard", "unity_c_with_message"],
  cc_test: ["unity_c_standard", "unity_c_with_message", "gtest_cpp", "parentheses_format"],
  py_test: ["pytest_python"],
  rust_test: ["rust_test"],
  go_test: ["go_test"],
  java_test: ["junit_java"],
};

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
import { IndividualTestCase, TestCaseParseResult } from './types';
import { getAllTestPatterns, normalizeStatus, TestCasePattern } from './testPatterns';

// ───────────────────────────────────────────────────────────────
// Bazel Test Configuration
// ───────────────────────────────────────────────────────────────

/**
 * Default flags for Bazel test execution
 */
const DEFAULT_BAZEL_TEST_FLAGS = [
  '--test_output=all',
  '--test_summary=detailed',
  '--test_verbose_timeout_warnings'
] as const;

// ───────────────────────────────────────────────────────────────
// Discovery cache for test case discovery
// ───────────────────────────────────────────────────────────────

interface CacheEntry { result: TestCaseParseResult; stdoutHash: string; timestamp: number; }
const discoveryCache = new Map<string, CacheEntry>();
const DISCOVERY_CACHE_MS_DEFAULT = 15000;

// Get the discovery cache TTL from configuration or use default
function getDiscoveryTtlMs(): number {
  try {
    const vscode = require('vscode');
    const cfg = vscode.workspace.getConfiguration('bazelTestRunner');
    return (cfg.get('discoveryCacheMs', DISCOVERY_CACHE_MS_DEFAULT) as number);
  } catch { return DISCOVERY_CACHE_MS_DEFAULT; }
}

function sha1(input: string): string {
  const crypto = require('crypto');
  return crypto.createHash('sha1').update(input).digest('hex');
}

// ───────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────

export const executeBazelTest = async (
  testItem: vscode.TestItem,
  workspacePath: string,
  run: vscode.TestRun
) => {
  try {
    // Check if this is an individual test case (contains "::")
    const isIndividualTestCase = testItem.id.includes('::');

    if (isIndividualTestCase) {
      await executeIndividualTestCase(testItem, workspacePath, run);
      return;
    }

    const typeMatch = testItem.label.match(/\[(.*?)\]/);
    const testType = typeMatch?.[1] ?? "";
    const isSuite = testType === "test_suite";

    const { code, stdout, stderr } = await measure(`Execute test: ${testItem.id}`, () =>
      initiateBazelTest(testItem.id, workspacePath, run, testItem)
    );

    if (isSuite) {
      // ...existing suite handling code...
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

      const summaryHeader = `🗂️ Test-Suite: ${testItem.id} : ${passed} Passed / ${failed} Failed`;
      const resultBlock = [summaryHeader, "────────────────────────────────────────────", ...rows].join("\n");

      const statusMessage = new vscode.TestMessage(`Suite Result:\n\n${resultBlock}`);
      if (code === 0) {
        run.passed(testItem);
      } else {
        run.failed(testItem, statusMessage);
      }
      run.appendOutput(resultBlock.replace(/\r?\n/g, '\r\n') + '\r\n', undefined, testItem);
      return;
    }

    // Handle regular test targets - parse individual test cases and update their status
    await executeTargetWithIndividualTestCases(testItem, workspacePath, run, code, stdout, stderr);

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
  const args = ['test', effectiveTestId, ...DEFAULT_BAZEL_TEST_FLAGS, ...additionalArgs];

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

/**
 * Parses Bazel test output to extract individual test cases using configurable patterns
 * @param stdout 
 * @param parentTarget 
 * @param allowedPatternIds restricts patterns to those with matching id (optional)
 */
export const parseIndividualTestCases = (
  stdout: string,
  parentTarget: string,
  allowedPatternIds?: string[]
): TestCaseParseResult => {
  const lines = stdout.split(/\r?\n/);
  const testCases: IndividualTestCase[] = [];

  // Get all available test patterns, filter if allowedPatternIds given
  const all = getAllTestPatterns();
  const testPatterns = allowedPatternIds && allowedPatternIds.length
    ? all.filter(p => allowedPatternIds.includes(p.id))
    : all;

  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;
  let ignoredTests = 0;

  for (const line of lines) {
    let bestMatch: {
      match: RegExpMatchArray;
      pattern: TestCasePattern;
    } | null = null;

    // Try each pattern until we find a match
    for (const testPattern of testPatterns) {
      const match = line.match(testPattern.pattern);
      if (match) {
        // Prefer more specific matches (longer matched strings)
        if (!bestMatch || match[0].length > bestMatch.match[0].length) {
          bestMatch = { match, pattern: testPattern };
        }
      }
    }

    if (bestMatch) {
      const { match, pattern } = bestMatch;
      const groups = pattern.groups;

      // Extract information based on pattern configuration
      const file = groups.file > 0 ? match[groups.file] : '';
      const lineStr = groups.line > 0 ? match[groups.line] : '0';
      const testName = match[groups.testName] || '';
      const rawStatus = match[groups.status] || 'FAIL';
      const errorMessage = groups.message && groups.message > 0 ? match[groups.message] : undefined;

      // Normalize status to common format
      const status = normalizeStatus(rawStatus);

      // Skip if essential information is missing
      if (!testName) {
        continue;
      }

      const testCase: IndividualTestCase = {
        name: testName,
        file: file,
        line: parseInt(lineStr, 10) || 0,
        parentTarget: parentTarget,
        status: status,
        errorMessage: errorMessage?.trim()
      };

      testCases.push(testCase);
      totalTests++;

      // Log which pattern was used for debugging (only if debug env set)
      if (process.env.BAZEL_TESTEXPLORER_DEBUG === '1') {
        logWithTimestamp(`Matched test case "${testName}" using pattern: ${pattern.framework} (${pattern.id})`);
      }

      switch (status) {
        case 'PASS':
          passedTests++;
          break;
        case 'FAIL':
        case 'TIMEOUT':
          failedTests++;
          break;
        case 'SKIP':
          ignoredTests++;
          break;
      }
    }
  }

  // Parse summary line if available (e.g., "38 Tests 1 Failures 0 Ignored")
  const summaryPattern = /(\d+)\s+Tests?\s+(\d+)\s+Failures?\s+(\d+)\s+Ignored/;
  for (const line of lines) {
    const summaryMatch = line.match(summaryPattern);
    if (summaryMatch) {
      totalTests = parseInt(summaryMatch[1], 10);
      failedTests = parseInt(summaryMatch[2], 10);
      ignoredTests = parseInt(summaryMatch[3], 10);
      passedTests = totalTests - failedTests - ignoredTests;
      break;
    }
  }

  logWithTimestamp(`Parsed ${testCases.length} individual test cases from ${parentTarget}`);

  return {
    testCases,
    summary: {
      total: totalTests,
      passed: passedTests,
      failed: failedTests,
      ignored: ignoredTests
    }
  };
};

/**
 * Discovers individual test cases within a Bazel test target
 * by running the test with --test_output=all and parsing the results.
 * Uses a cache to avoid repeated discovery.
 * @param testTarget 
 * @param workspacePath 
 * @param testType - Bazel rule/test type (optional)
 */
export const discoverIndividualTestCases = async (
  testTarget: string,
  workspacePath: string,
  testType?: string
): Promise<TestCaseParseResult> => {
  try {
    const ttl = getDiscoveryTtlMs();
    const cache = discoveryCache.get(testTarget);
    if (cache && (Date.now() - cache.timestamp) < ttl) {
      logWithTimestamp(`Using cached test case discovery for ${testTarget}`);
      return cache.result;
    }

    logWithTimestamp(`Discovering individual test cases for ${testTarget}`);

    // Run the test to get output with individual test case results
    const { stdout, stderr } = await runBazelCommand(
      ['test', testTarget, ...DEFAULT_BAZEL_TEST_FLAGS],
      workspacePath
    );

    const combined = [stdout, stderr].filter(Boolean).join("\n");
    const allowed = testType ? PATTERN_IDS_BY_TEST_TYPE[testType] : undefined;
    let result = parseIndividualTestCases(combined, testTarget, allowed);
    if (allowed && result.testCases.length === 0) {
      logWithTimestamp(`No test cases matched with restricted patterns for ${testTarget} [${testType}]. Trying all patterns as fallback.`, "warn");
      result = parseIndividualTestCases(combined, testTarget, undefined);
    }
    const entry: CacheEntry = { result, stdoutHash: sha1(stdout), timestamp: Date.now() };
    discoveryCache.set(testTarget, entry);

    logWithTimestamp(`Found ${result.testCases.length} test cases in ${testTarget}`);
    return result;
  } catch (error) {
    logWithTimestamp(`Failed to discover test cases for ${testTarget}: ${formatError(error)}`);
    return {
      testCases: [],
      summary: { total: 0, passed: 0, failed: 0, ignored: 0 }
    };
  }
};

/**
 * Executes an individual test case within a Bazel test target
 */
export const executeIndividualTestCase = async (
  testItem: vscode.TestItem,
  workspacePath: string,
  run: vscode.TestRun
): Promise<void> => {
  const [parentTarget, testCaseName] = testItem.id.split('::');

  try {
    logWithTimestamp(`Executing individual test case: ${testCaseName} in ${parentTarget} using --test_filter`);

    // Use --test_filter to run only the specific test case
    const config = vscode.workspace.getConfiguration("bazelTestRunner");
    const additionalArgs: string[] = config.get("testArgs", []);

    const testTypeMatch = testItem.label.match(/\[(.*?)\]/);
    const testType = testTypeMatch?.[1];
    const allowedPatternIds = PATTERN_IDS_BY_TEST_TYPE[testType || ''];

    const testFilterArgs = [
      'test',
      parentTarget,
      ...DEFAULT_BAZEL_TEST_FLAGS,
      `--test_filter=${testCaseName}`,
      ...additionalArgs
    ];

    logWithTimestamp(`Running Bazel command: bazel ${testFilterArgs.join(' ')}`);

    const { code, stdout, stderr } = await runBazelCommand(testFilterArgs, workspacePath);

    const combined = [stdout, stderr].filter(Boolean).join("\n");
    let result = parseIndividualTestCases(combined, parentTarget, allowedPatternIds);
    if (allowedPatternIds && result.testCases.length === 0) {
      logWithTimestamp(`No test cases matched with restricted patterns for ${parentTarget} using --test_filter. Trying all patterns as fallback.`, "warn");
      result = parseIndividualTestCases(combined, parentTarget, undefined);
    }
    const targetTestCase = result.testCases.find(tc => tc.name === testCaseName);

    if (!targetTestCase) {
      // If the specific test case isn't found, it might still be in the summary
      // or the test runner might use different output format
      const { input: testLog } = parseBazelOutput(stdout);
      const { input: bazelLog } = parseBazelOutput(stderr);

      const combinedOutput = [...testLog, ...bazelLog].join('\n');

      if (code === 0) {
        run.passed(testItem);
      } else {
        run.failed(testItem, new vscode.TestMessage(`Test case ${testCaseName} execution completed with code ${code}`));
      }

      const outputBlock = [
        getStatusHeader(code, testItem.id),
        '----- BEGIN OUTPUT -----',
        ...testLog,
        '------ END OUTPUT ------'
      ].join("\n");
      run.appendOutput(outputBlock.replace(/\r?\n/g, '\r\n') + '\r\n', undefined, testItem);
      return;
    }

    const { input: testLog } = parseBazelOutput(stdout);
    const outputBlock = [
      getStatusHeader(code, testItem.id),
      '----- BEGIN OUTPUT -----',
      ...testLog,
      '------ END OUTPUT ------'
    ].join("\n");

    run.appendOutput(outputBlock.replace(/\r?\n/g, '\r\n') + '\r\n', undefined, testItem);

    if (targetTestCase.status === 'PASS') {
      run.passed(testItem);
    } else if (targetTestCase.status === 'FAIL') {
      let message = `Test case failed: ${testCaseName}`;
      if (targetTestCase.errorMessage) {
        message += `\n${targetTestCase.errorMessage}`;
      }

      const testMessage = new vscode.TestMessage(message);

      // Add location information if available
      if (targetTestCase.file) {
        const fullPath = path.join(workspacePath, targetTestCase.file);
        if (fs.existsSync(fullPath)) {
          const uri = vscode.Uri.file(fullPath);
          const location = new vscode.Location(uri, new vscode.Position(targetTestCase.line - 1, 0));
          testMessage.location = location;
        }
      }

      run.failed(testItem, testMessage);
    } else {
      run.skipped(testItem);
    }

  } catch (error) {
    const message = formatError(error);
    logWithTimestamp(`Error executing individual test case ${testItem.id}: ${message}`, "error");
    run.failed(testItem, new vscode.TestMessage(message));
  }
};

/**
 * Executes a test target and updates individual test case statuses
 */
export const executeTargetWithIndividualTestCases = async (
  testItem: vscode.TestItem,
  workspacePath: string,
  run: vscode.TestRun,
  code: number,
  stdout: string,
  stderr: string
): Promise<void> => {
  const { input: testLog } = parseBazelOutput(stdout);
  const { input: bazelLog } = parseBazelOutput(stderr);

  // Derive testType from label to restrict pattern IDs
  const typeMatch = testItem.label.match(/\[(.*?)\]/);
  const testType = typeMatch?.[1];
  const allowedPatternIds = PATTERN_IDS_BY_TEST_TYPE[testType || ''];

  // Parse individual test cases from the output (combine stdout/stderr)
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  let result = parseIndividualTestCases(combined, testItem.id, allowedPatternIds);
  if (allowedPatternIds && result.testCases.length === 0) {
    logWithTimestamp(`No test cases matched with restricted patterns for ${testItem.id} [${testType}]. Trying all patterns as fallback.`, "warn");
    result = parseIndividualTestCases(combined, testItem.id, undefined);
  }

  // Update individual test case statuses if they exist as children
  for (const testCase of result.testCases) {
    const testCaseId = `${testItem.id}::${testCase.name}`;
    const childItem = testItem.children.get(testCaseId);

    if (childItem) {
      if (testCase.status === 'PASS') {
        run.passed(childItem);
      } else if (testCase.status === 'FAIL') {
        let message = `Test case failed: ${testCase.name}`;
        if (testCase.errorMessage) {
          message += `\n${testCase.errorMessage}`;
        }

        const testMessage = new vscode.TestMessage(message);

        if (testCase.file) {
          const fullPath = path.join(workspacePath, testCase.file);
          if (fs.existsSync(fullPath)) {
            const uri = vscode.Uri.file(fullPath);
            const location = new vscode.Location(uri, new vscode.Position(testCase.line - 1, 0));
            testMessage.location = location;
          }
        }

        run.failed(childItem, testMessage);
      } else {
        run.skipped(childItem);
      }
    }
  }

  // Handle the main test target status
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
};

// ───────────────────────────────────────────────────────────────
// Analyse test results
// ───────────────────────────────────────────────────────────────

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
