/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { runBazelCommand } from './process';
import { logWithTimestamp, measure, formatError } from '../logging';
import { analyzeTestFailures } from './parseFailures';
import { IndividualTestCase, TestCaseParseResult } from './types';
import { PATTERN_IDS_BY_TEST_TYPE, getAllTestPatterns, TestCasePattern } from './testPatterns';
import { discoverIndividualTestCases } from './discovery';
import { splitOutputLines, extractTestCasesFromOutput } from './parseOutput';

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
// Suite summary helpers
// ───────────────────────────────────────────────────────────────

const extractSuiteSummaryFromStdout = (stdout: string) => {
  const resultLines = stdout
    .split(/\r?\n/)
    .filter(line => line.match(/^\/\/.* (PASSED|FAILED|TIMEOUT|FLAKY)/));

  let passed = 0;
  let failed = 0;

  const rows = resultLines.map(line => {
    const parts = line.trim().split(/\s+/);

    let target: string;
    let status: 'PASSED' | 'FAILED' | 'TIMEOUT' | 'FLAKY' | string;
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
      isCached = '';
      testTime = parts[3];
    }

    const symbolMap: Record<string, string> = {
      PASSED: '✅ Passed',
      FAILED: '❌ Failed',
      TIMEOUT: '⏱ Timeout',
      FLAKY: '⚠️ Flaky',
    };
    const symbol = symbolMap[status] ?? `${status}`;

    if (status === 'PASSED') passed++;
    else if (status === 'FAILED') failed++;

    return `${target}  : ${symbol} (${isCached ? 'cached, ' : ''}${testTime})`;
  });

  return { rows, passed, failed };
};

const emitSuiteResult = (
  run: vscode.TestRun,
  testItem: vscode.TestItem,
  code: number,
  rows: string[],
  passed: number,
  failed: number
) => {
  const summaryHeader = `🗂️ Test-Suite: ${testItem.id} : ${passed} Passed / ${failed} Failed`;
  const resultBlock = [summaryHeader, '────────────────────────────────────────────', ...rows].join('\n');

  const statusMessage = new vscode.TestMessage(`Suite Result:\n\n${resultBlock}`);
  if (code === 0) {
    run.passed(testItem);
  } else {
    run.failed(testItem, statusMessage);
  }
  run.appendOutput(resultBlock.replace(/\r?\n/g, '\r\n') + '\r\n', undefined, testItem);
};

// ───────────────────────────────────────────────────────────────
// Small helpers to reduce duplication
// ───────────────────────────────────────────────────────────────

const combineOutputs = (stdout: string, stderr: string): string =>
  [stdout, stderr].filter(Boolean).join('\n');

const appendOutputBlock = (
  run: vscode.TestRun,
  testItem: vscode.TestItem,
  code: number,
  lines: string[]
) => {
  if (!lines || lines.length === 0) return;
  const block = [
    getStatusHeader(code, testItem.id),
    '----- BEGIN OUTPUT -----',
    ...lines,
    '------ END OUTPUT ------'
  ].join('\n');
  run.appendOutput(block.replace(/\r?\n/g, '\r\n') + '\r\n', undefined, testItem);
};

const parseCasesWithFallback = (
  combined: string,
  targetId: string,
  allowedPatternIds: string[] | undefined,
  warnContext?: string
) => {
  let result = extractTestCasesFromOutput(combined, targetId, allowedPatternIds);
  if (allowedPatternIds && result.testCases.length === 0) {
    if (warnContext) {
      logWithTimestamp(warnContext, 'warn');
    }
    result = extractTestCasesFromOutput(combined, targetId, undefined);
  }
  return result;
};

const setFailedWithLocation = (
  run: vscode.TestRun,
  item: vscode.TestItem,
  workspacePath: string,
  message: string,
  file?: string,
  line?: number
) => {
  const testMessage = new vscode.TestMessage(message);
  if (file) {
    const fullPath = path.isAbsolute(file) ? file : path.join(workspacePath, file);
    if (fs.existsSync(fullPath)) {
      const uri = vscode.Uri.file(fullPath);
      const lineZeroBased = Math.max(0, (line || 0) - 1);
      testMessage.location = new vscode.Location(uri, new vscode.Position(lineZeroBased, 0));
    }
  }
  run.failed(item, testMessage);
};

// Build a framework-aware filter for individual tests based on pattern templates.
function buildIndividualFilter(
  testCaseName: string,
  allowedPatternIds?: string[],
  context?: { suite?: string; className?: string; file?: string; targetId?: string; preferredPatternId?: string }
): string {
  const patterns = getAllTestPatterns();
  const byId = new Map<string, TestCasePattern>(patterns.map(p => [p.id, p]));
  // If a specific framework/pattern is known, use it directly
  if (context?.preferredPatternId && byId.has(context.preferredPatternId)) {
    const p = byId.get(context.preferredPatternId)!;
    const template = p.filterTemplate || '${name}';
    const replace = (tpl: string) =>
      tpl
        .replace(/\$\{name\}/g, testCaseName)
        .replace(/\$\{suite\}/g, (context?.suite && context.suite.length ? context.suite : '*'))
        .replace(/\$\{class\}/g, (context?.className && context.className.length ? context.className : '*'))
        .replace(/\$\{file\}/g, (context?.file && context.file.length ? context.file : '*'));
    return replace(template);
  }

  const pool: TestCasePattern[] = (allowedPatternIds && allowedPatternIds.length)
    ? allowedPatternIds.map(id => byId.get(id)).filter((p): p is TestCasePattern => !!p)
    : patterns;
  const candidates = pool.filter(p => p.supportsIndividual !== false && !!p.filterTemplate);
  // Prefer templates that require extra context (suite/class/file) over plain name-only templates
  const prefersContext = (tpl: string) => /\$\{suite\}|\$\{class\}|\$\{file\}/.test(tpl);
  const candidate = candidates.find(p => prefersContext(p.filterTemplate!)) || candidates[0];
  let template = candidate?.filterTemplate || '${name}';
  // Heuristic: if target path hints at gtest and no better template was chosen, prefer gtest style
  if (template === '${name}' && context?.targetId && /(^|\/)gtest(:|\/)/.test(context.targetId)) {
    template = '${suite}.${name}';
  }
  const replace = (tpl: string) =>
    tpl
      .replace(/\$\{name\}/g, testCaseName)
      .replace(/\$\{suite\}/g, (context?.suite && context.suite.length ? context.suite : '*'))
      .replace(/\$\{class\}/g, (context?.className && context.className.length ? context.className : '*'))
      .replace(/\$\{file\}/g, (context?.file && context.file.length ? context.file : '*'));
  return replace(template);
}

export function callRunBazelCommandForTest(opts: {
  testId: string;             // Bazel target id, e.g. //pkg:test or //pkg
  cwd: string;                // working directory (workspace root)
  filter?: string;            // optional --test_filter value for individual test case
  logCommand?: boolean;       // default true
  collectStdout?: boolean;    // default true
  collectStderr?: boolean;    // default true
  extraArgs?: string[];       // additional args appended after defaults
}): Promise<{ code: number; stdout: string; stderr: string }>;
export async function callRunBazelCommandForTest(
  opts: { testId: string; cwd: string; filter?: string; logCommand?: boolean; collectStdout?: boolean; collectStderr?: boolean; extraArgs?: string[] }
): Promise<{ code: number; stdout: string; stderr: string }> {

  let effectiveTestId = opts.testId;

  // Expand package paths like "//pkg" or "//" to recursive selectors
  if (/^\/\/[^:]*$/.test(effectiveTestId)) {
    if (effectiveTestId === '//') {
      effectiveTestId = '//...';
    } else if (!effectiveTestId.endsWith('/...')) {
      effectiveTestId = `${effectiveTestId}/...`;
    }
  }

  const config = vscode.workspace.getConfiguration('bazelTestRunner');
  const configArgs: string[] = config.get('testArgs', []);

  const args = ['test', effectiveTestId, ...DEFAULT_BAZEL_TEST_FLAGS];
  if (opts.filter && opts.filter.length > 0) {
    args.push(`--test_filter=${opts.filter}`);
  }
  if (Array.isArray(opts.extraArgs) && opts.extraArgs.length > 0) {
    args.push(...opts.extraArgs);
  }
  args.push(...configArgs);

  return runBazelCommand(args, opts.cwd, {
    logCommand: opts.logCommand !== false,
    collectStdout: opts.collectStdout !== false,
    collectStderr: opts.collectStderr !== false,
  });
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

    // Check if this is an individual test case (contains "::") and run
    const isIndividualTestCase = testItem.id.includes('::');

    if (isIndividualTestCase) {
      await executeIndividualTestCase(testItem, workspacePath, run);
    } else {
      await executeTestTarget(testItem, workspacePath, run);
    }

  } catch (error) {
    const message = formatError(error);
    logWithTimestamp(`Error executing test ${testItem.id}: ${message}`, "error");
    run.failed(testItem, new vscode.TestMessage(message));
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

    // try to discover test type from parent label
    const parentLabel = (testItem as any).parent?.label ?? testItem.label;
    const testType = /\[(.*?)\]/.exec(parentLabel)?.[1];
    const allowedPatternIds = PATTERN_IDS_BY_TEST_TYPE[testType || ''];

    // Try to discover exact framework/context for precise filter building
    let preferredPatternId: string | undefined;
    let suite: string | undefined;
    let className: string | undefined;
    let file: string | undefined;
    try {
      const discovery = await discoverIndividualTestCases(parentTarget, workspacePath, testType);
      const discovered = discovery.testCases.find(tc => tc.name === testCaseName);
      if (discovered) {
        preferredPatternId = discovered.frameworkId;
        suite = discovered.suite;
        className = discovered.className;
        file = discovered.file;
      }
    } catch {}

    const filter = buildIndividualFilter(testCaseName, allowedPatternIds, {
      targetId: parentTarget,
      preferredPatternId,
      suite,
      className,
      file,
    });

    const { code, stdout, stderr } = await callRunBazelCommandForTest({
      testId: parentTarget,
      cwd: workspacePath,
      filter
    });

    const combined = combineOutputs(stdout, stderr);
    const result = parseCasesWithFallback(
      combined,
      parentTarget,
      allowedPatternIds,
      `No test cases matched with restricted patterns for ${parentTarget} using --test_filter. Trying all patterns as fallback.`
    );

    const targetTestCase = result.testCases.find(tc => tc.name === testCaseName);

    const testLog = splitOutputLines(stdout);
    appendOutputBlock(run, testItem, code, testLog);

    if (!targetTestCase) {
      if (code === 0) {
        run.passed(testItem);
      } else {
        run.failed(testItem, new vscode.TestMessage(`Test case ${testCaseName} execution completed with code ${code}`));
      }
      return;
    }

    if (targetTestCase.status === 'PASS') {
      run.passed(testItem);
    } else if (targetTestCase.status === 'FAIL') {
      let message = `Test case failed: ${testCaseName}`;
      if (targetTestCase.errorMessage) message += `\n${targetTestCase.errorMessage}`;
      setFailedWithLocation(run, testItem, workspacePath, message, targetTestCase.file, targetTestCase.line);
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
export const executeTestTarget = async (
  testItem: vscode.TestItem,
  workspacePath: string,
  run: vscode.TestRun
): Promise<void> => {
  const { code, stdout, stderr } = await measure(`Execute test: ${testItem.id}`, () =>
    callRunBazelCommandForTest({ testId: testItem.id, cwd: workspacePath })
  );

  const testLog = splitOutputLines(stdout);
  const bazelLog = splitOutputLines(stderr);

  // Derive testType from label, i.e. "cc_test":
  const typeMatch = testItem.label.match(/\[(.*?)\]/);
  const testType = typeMatch?.[1];
  // check if this type is known:
  const allowedPatternIds = PATTERN_IDS_BY_TEST_TYPE[testType || ''];

  // Suite handling
  if (testType === "test_suite") {
    const { rows, passed, failed } = extractSuiteSummaryFromStdout(stdout);
    emitSuiteResult(run, testItem, code, rows, passed, failed);
    return;
  }

  // Parse individual test cases from the output (combine stdout/stderr)
  const combined = combineOutputs(stdout, stderr);
  
  const result = parseCasesWithFallback(
    combined,
    testItem.id,
    allowedPatternIds,
    `No test cases matched with restricted patterns for ${testItem.id} [${testType}]. Trying all patterns as fallback.`
  );

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

        setFailedWithLocation(run, childItem, workspacePath, message, testCase.file, testCase.line);
      } else {
        run.skipped(childItem);
      }
    }
  }

  // Handle the main test target status
  if (code === 0) {
    appendOutputBlock(run, testItem, code, testLog);
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
    appendOutputBlock(run, testItem, code, bazelLog);
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

// analyzeTestFailures moved to parseFailures.ts

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
