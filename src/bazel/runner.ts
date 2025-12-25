/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/**
 * Test runner - executes Bazel tests and processes results for VS Code test controller
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { finishTest, publishOutput } from '../explorer/events';
import { runBazelCommand } from '../infrastructure/process';
import { logWithTimestamp, measure, formatError } from '../logging';
import { ConfigurationService } from '../configuration';
import { analyzeTestFailures } from './parseFailures';
import { TestFramework } from './testFilterStrategies';
import { parseUnifiedTestResult, UnifiedTestResult } from './testcase/testResultParser';
import { stripAnsi } from './testcase/parseOutput';
import { IndividualTestCase } from './types';
import { getTestTargetById } from './queries';

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

const EMPTY_UNIFIED_RESULT: UnifiedTestResult = {
  testCases: [],
  summary: { total: 0, passed: 0, failed: 0, ignored: 0 },
  source: 'none'
};

/**
 * Merge flag arrays with override semantics: later arrays override earlier ones
 * for flags that share the same key (e.g. --test_output=all vs --test_output=errors).
 */
function mergeFlags(...arrays: string[][]): string[] {
  const map = new Map<string, string>();
  const order: string[] = [];

  for (const arr of arrays) {
    for (const arg of arr) {
      const key = arg.startsWith('--') ? arg.split('=')[0] : arg;
      if (map.has(key)) {
        const idx = order.indexOf(key);
        if (idx !== -1) order.splice(idx, 1);
      }
      map.set(key, arg);
      order.push(key);
    }
  }

  return order.map(k => map.get(k)!) as string[];
}

/**
 * Maps Bazel test type to test framework identifier
 */
function mapTestTypeToFramework(testType: string): TestFramework {
  const lowerType = testType.toLowerCase();
  
  if (lowerType.includes('gtest') || lowerType === 'cc_test') {
    return 'gtest';
  }
  if (lowerType.includes('pytest') || lowerType.includes('py_test')) {
    return 'pytest';
  }
  if (lowerType.includes('criterion')) {
    return 'criterion';
  }
  if (lowerType.includes('doctest')) {
    return 'doctest';
  }
  if (lowerType.includes('rust')) {
    return 'rust';
  }
  if (lowerType.includes('go')) {
    return 'go';
  }
  if (lowerType.includes('java') || lowerType.includes('junit')) {
    return 'java';
  }
  
  return 'other';
}

/**
 * Compute per-target flags based on Bazel target metadata (tags, attributes).
 * Implements Bazel Test Encyclopedia semantics for exclusive/external/sharding.
 * 
 * @param targetId Bazel target label
 * @returns Array of Bazel flags to apply only for this target
 */
export function computePerTargetFlags(targetId: string): string[] {
  const flags: string[] = [];
  const metadata = getTestTargetById(targetId);
  
  if (!metadata) {
    return flags;
  }
  
  const tags = metadata.tags ?? [];
  
  // Tag: exclusive → serialize test execution
  if (tags.includes('exclusive')) {
    flags.push('--test_strategy=exclusive');
    logWithTimestamp(`Target ${targetId} has 'exclusive' tag → --test_strategy=exclusive`);
  }
  
  // Tag: external → disable caching (non-hermetic)
  if (tags.includes('external')) {
    flags.push('--cache_test_results=no');
    logWithTimestamp(`Target ${targetId} has 'external' tag → --cache_test_results=no`);
  }
  
  // Flaky attribute → enable automatic retry attempts
  if (metadata.flaky) {
    flags.push('--flaky_test_attempts=2');
    logWithTimestamp(`Target ${targetId} has 'flaky' attribute → --flaky_test_attempts=2`);
  }
  
  // Shard count (if defined)
  if (metadata.shard_count && metadata.shard_count > 1) {
    // Bazel uses the shard_count target attribute internally and exposes sharding via
    // TEST_SHARD_INDEX/TEST_TOTAL_SHARDS, so no additional CLI flags are required here;
    // we just log the configured shard_count for visibility.
    logWithTimestamp(`Target ${targetId} has shard_count=${metadata.shard_count}`);
  }
  
  return flags;
}

// ───────────────────────────────────────────────────────────────
// Suite Results Parsing
// ───────────────────────────────────────────────────────────────

type TestStatus = 'PASSED' | 'FAILED' | 'TIMEOUT' | 'FLAKY';

/**
 * Parses and reports test suite results
 */
function parseSuiteResults(
  testItem: vscode.TestItem,
  run: vscode.TestRun,
  code: number,
  stdout: string
): void {
  const resultLines = stdout.split(/\r?\n/).filter(line => line.match(/^\/\/.* (PASSED|FAILED|TIMEOUT|FLAKY)/));

  let passed = 0;
  let failed = 0;

  const rows = resultLines.map(line => {
    const parts = line.trim().split(/\s+/);

    let target: string;
    let status: TestStatus | string;
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

    const symbolMap: Record<TestStatus, string> = {
      PASSED: "✅ Passed",
      FAILED: "❌ Failed",
      TIMEOUT: "⏱ Timeout",
      FLAKY: "⚠️ Flaky",
    };
    const symbol = symbolMap[status as TestStatus] ?? `${status}`;

    if (status === "PASSED") passed++;
    else if (status === "FAILED") failed++;

    return `${target}  : ${symbol} (${isCached ? "cached, " : ""}${testTime})`;
  });

  const summaryHeader = `🧰 Test-Suite: ${testItem.id} : ${passed} Passed / ${failed} Failed`;
  const resultBlock = [summaryHeader, "────────────────────────────────────────────", ...rows].join("\n");

  const statusMessage = new vscode.TestMessage(`🧪 Suite Result:\n\n${resultBlock}`);
  if (code === 0) {
    run.passed(testItem);
    try { finishTest(testItem.id, 'passed'); } catch {}
  } else {
    run.failed(testItem, statusMessage);
    try { finishTest(testItem.id, 'failed', statusMessage.message); } catch {}
  }
  const suiteOutput = resultBlock.replace(/\r?\n/g, '\r\n') + '\r\n';
  run.appendOutput(suiteOutput, undefined, testItem);
  try { publishOutput(testItem.id, suiteOutput); } catch {}
}

// ───────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────

/**
 * Processes successful test execution (exit code 0)
 */
function processSuccessfulTest(
  run: vscode.TestRun,
  testItem: vscode.TestItem,
  code: number,
  displayLog: string[]
): void {
  if (displayLog.length > 0) {
    const outputBlock = [
      getStatusHeader(code, testItem.id),
      '----- BEGIN OUTPUT -----',
      ...displayLog,
      '------ END OUTPUT ------'
    ].join("\n");

    const out = outputBlock.replace(/\r?\n/g, '\r\n') + '\r\n';
    run.appendOutput(out, undefined, testItem);
    try { publishOutput(testItem.id, out); } catch {}
  }

  // Only mark the parent test item as passed here.
  // Child test items should be marked based on their own execution results,
  // to avoid incorrectly treating unexecuted children as having passed.
  run.passed(testItem);
  try { finishTest(testItem.id, 'passed'); } catch {}
}

/**
 * Processes failure of an individual test case (when running a specific test case from children)
 */
function processIndividualTestCaseFailure(
  run: vscode.TestRun,
  testItem: vscode.TestItem,
  testCase: IndividualTestCase,
  displayLog: string[],
  workspacePath: string
): void {
  const statusLabel = testCase.status === 'TIMEOUT' ? 'Timeout' : 'Failed';
  const segments = [`${testCase.name} (${statusLabel})`];
  if (testCase.errorMessage) {
    segments.push(testCase.errorMessage);
  }
  const message = new vscode.TestMessage(segments.join('\n\n'));
  const location = resolveLocationFromTestCase(testCase, workspacePath);
  if (location) {
    message.location = location;
  }
  
  run.failed(testItem, message);
  
  if (displayLog.length > 0) {
    const outputBlock = [
      `❌ Test Failed: ${testItem.id}`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '----- BEGIN OUTPUT -----',
      ...displayLog,
      '------ END OUTPUT ------'
    ].join("\n");
    const out = outputBlock.replace(/\r?\n/g, '\r\n') + '\r\n';
    run.appendOutput(out, undefined, testItem);
    try { publishOutput(testItem.id, out); } catch {}
  }
  
  try { finishTest(testItem.id, 'failed', segments.join('\n\n')); } catch {}
}

/**
 * Processes failed or flaky test execution (exit codes 3, 4, other)
 */
function processFailedTest(
  run: vscode.TestRun,
  testItem: vscode.TestItem,
  code: number,
  bazelLog: string[],
  testLog: string[],
  workspacePath: string,
  unifiedResult: UnifiedTestResult,
  scopedCases: IndividualTestCase[]
): void {
  if (code === 4) {
    // Bazel Test Encyclopedia: exit code 4 indicates tests passed only after retries (flaky)
    const cleaned = bazelLog.filter(line => line.trim() !== "").join("\n");
    const cleaned_with_Header = getStatusHeader(code, testItem.id) + cleaned;
    vscode.window.showWarningMessage(`⚠️ Flaky tests detected; run marked unsuccessful: ${testItem.id}`);
    run.failed(
      testItem,
      new vscode.TestMessage(
        `⚠️ Flaky tests: passed after retries. Treating as failure (Code ${code}).\n\n${cleaned_with_Header}`
      )
    );
    try { finishTest(testItem.id, 'failed', cleaned_with_Header); } catch {}
  } else if (code === 3) {
    handleTestResult(
      run,
      testItem,
      code,
      bazelLog,
      testLog,
      workspacePath,
      unifiedResult,
      scopedCases
    );
  } else {
    const cleaned = bazelLog.filter(line => line.trim() !== "").join("\n");
    const cleaned_with_Header = getStatusHeader(code, testItem.id) + cleaned;
    run.failed(testItem, new vscode.TestMessage(`🧨 Errors during tests (Code ${code}):\n\n${cleaned_with_Header}`));
    try { finishTest(testItem.id, 'failed', cleaned_with_Header); } catch {}
    const outputBlock = [
      getStatusHeader(code, testItem.id),
      '----- BEGIN OUTPUT -----',
      ...bazelLog,
      '------ END OUTPUT ------'
    ].join("\n");
    const out = outputBlock.replace(/\r?\n/g, '\r\n') + '\r\n';
    run.appendOutput(out, undefined, testItem);
    try { publishOutput(testItem.id, out); } catch {}
  }
}

// ───────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────

export const executeBazelTest = async (
  testItem: vscode.TestItem,
  workspacePath: string,
  run: vscode.TestRun,
  config: ConfigurationService,
  cancellationToken?: vscode.CancellationToken
) => {
  try {
    const typeMatch = testItem.label.match(/\[(.*?)\]/);
    const testType = typeMatch?.[1] ?? "";
    const isSuite = testType === "test_suite";
    const isIndividualTestCase = testItem.id.includes('::');

    const { code, stdout, stderr, filterSupported, filterUsed } = await measure(`Execute test: ${testItem.id}`, () =>
      initiateBazelTest(testItem.id, workspacePath, run, testItem, config, cancellationToken)
    );

    if (isSuite) {
      parseSuiteResults(testItem, run, code, stdout);
      return;
    }

    const shouldParseStructured = code === 0 || code === 3 || code === 4;
    const baseTargetId = isIndividualTestCase ? testItem.id.split('::')[0] : testItem.id;
    const unifiedResult = shouldParseStructured
      ? await parseUnifiedTestResult({
          targetLabel: baseTargetId,
          workspacePath,
          bazelPath: config.bazelPath,
        })
      : null;

    const { input: testLog } = parseBazelOutput(stdout);
    const { input: bazelLog } = parseBazelOutput(stderr);
    const relevantCases = unifiedResult ? filterTestCasesForItem(testItem, unifiedResult.testCases) : [];
    const baseDisplayLog = filterLogLinesForItem(testItem, relevantCases.length > 0 ? relevantCases : undefined, testLog);

    const noFilterNote = isIndividualTestCase && !filterSupported
      ? '⚠️ Framework does not support test_filter; entire target was executed. Output may include other tests.'
      : undefined;
    // For unsupported filter on individual case, show full test log to avoid hiding relevant lines
    const caseDisplayLog = isIndividualTestCase && !filterSupported ? testLog : baseDisplayLog;
    const logWithNote = noFilterNote ? [noFilterNote, ...caseDisplayLog] : caseDisplayLog;

    // For individual test cases, determine status from parsed result, not exit code
    // because Bazel returns code 3 if ANY test in the target fails, not just this specific case
    if (isIndividualTestCase) {
      if (!unifiedResult || relevantCases.length === 0) {
        const warningText = noFilterNote
          ? `${noFilterNote}\nNo structured test results found for this test case.`
          : 'No structured test results found for this test case.';
        const warningMsg = new vscode.TestMessage(warningText);
        if (code === 0) {
          run.passed(testItem);
          try { finishTest(testItem.id, 'passed'); } catch {}
        } else {
          run.failed(testItem, warningMsg);
          try { finishTest(testItem.id, 'failed', warningText); } catch {}
        }
        if (logWithNote.length > 0) {
          const outputBlock = [
            getStatusHeader(code, testItem.id),
            '----- BEGIN OUTPUT -----',
            ...logWithNote,
            '------ END OUTPUT ------'
          ].join("\n");
          const out = outputBlock.replace(/\r?\n/g, '\r\n') + '\r\n';
          run.appendOutput(out, undefined, testItem);
          try { publishOutput(testItem.id, out); } catch {}
        }
        return;
      }

      if (relevantCases.length > 1) {
        logWithTimestamp(`Multiple parsed cases matched ${testItem.id}; using first match.`, 'warn');
      }

      const testCase = relevantCases[0];
      const testPassed = testCase.status === 'PASS';
      
      if (testPassed) {
        processSuccessfulTest(run, testItem, 0, logWithNote);
      } else {
        // Test case failed - use parsed result to report the failure
        processIndividualTestCaseFailure(run, testItem, testCase, logWithNote, workspacePath);
      }
    } else if (code === 0) {
      processSuccessfulTest(run, testItem, code, baseDisplayLog);
    } else {
      const scopedDisplayLog = relevantCases.length > 0
        ? filterLogLinesForItem(testItem, relevantCases, testLog)
        : baseDisplayLog;
      processFailedTest(
        run,
        testItem,
        code,
        bazelLog,
        scopedDisplayLog,
        workspacePath,
        unifiedResult ?? EMPTY_UNIFIED_RESULT,
        relevantCases
      );
    }
  } catch (error) {
    const message = formatError(error);
    logWithTimestamp(`Error executing test ${testItem.id}: ${message}`, "error");
    run.failed(testItem, new vscode.TestMessage(message));
    try { finishTest(testItem.id, 'failed', message); } catch {}
  }
};

export const initiateBazelTest = async (
  testId: string,
  cwd: string,
  run: vscode.TestRun,
  testItem: vscode.TestItem,
  config: ConfigurationService,
  cancellationToken?: vscode.CancellationToken
): Promise<{ code: number; stdout: string; stderr: string; filterSupported: boolean; filterUsed: boolean }> => {
  let effectiveTestId = testId;
  let filterArgs: string[] = [];
  let filterSupported = false;
  let filterUsed = false;

  // Check if this is an individual test case (contains ::)
  if (testId.includes('::')) {
    const parts = testId.split('::');
    effectiveTestId = parts[0]; // The actual Bazel target
    const testName = parts.slice(1).join('::'); // The test case name
    
    // Try to apply test filter based on test type if supported
    const typeMatch = testItem.label.match(/\[(.*?)\]/);
    const testType = typeMatch?.[1] ?? "";
    
    // Import and use test filter strategies
    const { getTestFilterArgs, supportsTestFilter } = require('./testFilterStrategies');
    const framework = mapTestTypeToFramework(testType);
    filterSupported = supportsTestFilter(framework);
    
    if (filterSupported) {
      filterArgs = getTestFilterArgs(testName, framework);
      filterUsed = filterArgs.length > 0;
      logWithTimestamp(`Running individual test case: ${effectiveTestId}::${testName} [${testType}] with filter: ${filterArgs.join(' ')}`);
    } else {
      logWithTimestamp(`Running individual test case: ${effectiveTestId}::${testName} [${testType}] - no filter support, running entire target`);
    }
  }

  if (/^\/\/[^:]*$/.test(effectiveTestId)) {
    effectiveTestId = `${effectiveTestId}/...`;
  }

  const userArgs: string[] = [...config.testArgs];
  if (config.buildTestsOnly) {
    userArgs.push('--build_tests_only');
  }

  const runSpecificFlags: string[] = [];
  if (config.runsPerTest && config.runsPerTest > 0) {
    runSpecificFlags.push(`--runs_per_test=${config.runsPerTest}`);
  }
  if (config.runsPerTestDetectsFlakes) runSpecificFlags.push('--runs_per_test_detects_flakes');
  if (config.nocacheTestResults) runSpecificFlags.push('--nocache_test_results');
  if (config.testStrategyExclusive) runSpecificFlags.push('--test_strategy=exclusive');

  // Per-target flags (from tags/metadata)
  const perTargetFlags = computePerTargetFlags(effectiveTestId);

  // Merge flags so that later entries (user / runSpecific) override defaults when appropriate
  const mergedFlags = mergeFlags(
    Array.from(DEFAULT_BAZEL_TEST_FLAGS),
    userArgs,
    runSpecificFlags,
    perTargetFlags,
    filterArgs
  );

  // Respect ignoreRcFiles setting: when enabled, instruct Bazel to ignore
  // system/user/workspace .bazelrc files and only apply explicit ones.
  let args: string[];
  if (config.ignoreRcFiles) {
    const filteredFlags = mergedFlags.filter(a => !a.startsWith('--bazelrc') && !a.startsWith('--ignore_all_rc_files'));
    const explicitBazelrc = config.bazelrcFiles.map(p => `--bazelrc=${p}`);
    // Startup options must precede the command (test)
    args = ['--ignore_all_rc_files', ...explicitBazelrc, 'test', effectiveTestId, ...filteredFlags];
  } else {
    args = ['test', effectiveTestId, ...mergedFlags];
  }

  // Configure shard-related environment variables to avoid framework warnings
  // If the target defines sharding via `shard_count` we reflect that total, but
  // we run a single shard (index 0) by default when invoked from the extension.
  // This prevents frameworks from emitting warnings when they expect
  // TEST_SHARD_INDEX/TEST_TOTAL_SHARDS/TEST_SHARD_STATUS_FILE to exist.
  const targetMeta = getTestTargetById(effectiveTestId);
  const env: NodeJS.ProcessEnv = { ...process.env };
  const totalShards = targetMeta && targetMeta.shard_count && targetMeta.shard_count > 0
    ? String(targetMeta.shard_count)
    : '1';

  // Only set vars if they are not already provided in the environment
  if (!env.TEST_TOTAL_SHARDS) env.TEST_TOTAL_SHARDS = totalShards;
  if (!env.TEST_SHARD_INDEX) env.TEST_SHARD_INDEX = '0';
  if (!env.TEST_SHARD_STATUS_FILE) env.TEST_SHARD_STATUS_FILE = path.join(cwd, '.vscode_bazel_shard_status');
  logWithTimestamp(`Shard env: TEST_SHARD_INDEX=${env.TEST_SHARD_INDEX}, TEST_TOTAL_SHARDS=${env.TEST_TOTAL_SHARDS}`);

  const result = await runBazelCommand(
    args,
    cwd,
    undefined,
    undefined,
    config.bazelPath,
    env,
    cancellationToken
  );

  return { ...result, filterSupported, filterUsed };
};

export const parseBazelOutput = (stdout: string): { input: string[] } => {
  const input: string[] = [];
  stdout.split(/\r?\n/).forEach(line => {
    input.push(
      stripAnsi(line)
    );
  });
  return { input };
};

// ───────────────────────────────────────────────────────────────// Helper utilities
// ───────────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractTestCaseName(id: string): string {
  return id.includes('::') ? id.split('::').slice(1).join('::') : '';
}

function matchTestCaseName(testCase: IndividualTestCase, targetLower: string): boolean {
  const nameLower = testCase.name.toLowerCase();
  if (nameLower === targetLower) return true;
  const scope = (testCase.suite || testCase.className || '').toLowerCase();
  if (scope) {
    const combined = `${scope}::${nameLower}`;
    if (combined === targetLower) return true;
  }
  return false;
}

// ───────────────────────────────────────────────────────────────// Analyse test results
// ───────────────────────────────────────────────

function handleTestResult(
  run: vscode.TestRun,
  testItem: vscode.TestItem,
  code: number,
  bazelLog: string[],
  testLog: string[],
  workspacePath: string,
  parsedResult: UnifiedTestResult,
  scopedCases: IndividualTestCase[]
) {
  // Check if this testItem has children (individual test cases)
  const hasChildren = testItem.children.size > 0;

  if (code === 0) {
    if (hasChildren) {
      // Mark all children as passed
      testItem.children.forEach(child => {
        run.passed(child);
        try { finishTest(child.id, 'passed'); } catch {}
      });
    }
    run.passed(testItem);
  } else {
    const casesForMessages = scopedCases.length > 0 ? scopedCases : parsedResult.testCases;

    // If test item has children and we have parsed test cases, mark children individually
    if (hasChildren && casesForMessages.length > 0) {
      let passedCount = 0;
      let failedCount = 0;

      // Process each child test case
      testItem.children.forEach(child => {
        const testCaseName = extractTestCaseName(child.id).toLowerCase();
        const matchingCase = casesForMessages.find(tc => matchTestCaseName(tc, testCaseName));

        if (matchingCase) {
          if (matchingCase.status === 'PASS') {
            run.passed(child);
            try { finishTest(child.id, 'passed'); } catch {}
            passedCount++;
          } else {
            const statusLabel = matchingCase.status === 'TIMEOUT' ? 'Timeout' : 'Failed';
            const segments = [`${matchingCase.name} (${statusLabel})`];
            if (matchingCase.errorMessage) {
              segments.push(matchingCase.errorMessage);
            }
            const message = new vscode.TestMessage(segments.join('\n\n'));
            const location = resolveLocationFromTestCase(matchingCase, workspacePath);
            if (location) {
              message.location = location;
            }
            run.failed(child, message);
            try { finishTest(child.id, 'failed', segments.join('\n\n')); } catch {}
            failedCount++;
          }
        } else {
          // No matching case found - mark as failed with generic message
          run.failed(child, new vscode.TestMessage('Test result not found in output'));
          try { finishTest(child.id, 'failed'); } catch {}
          failedCount++;
        }
      });

      // Set parent status based on children results
      if (failedCount > 0) {
        const summaryMessage = new vscode.TestMessage(
          `${failedCount} of ${passedCount + failedCount} test(s) failed`
        );
        run.failed(testItem, summaryMessage);
        try { finishTest(testItem.id, 'failed', summaryMessage.message); } catch {}
      } else {
        run.passed(testItem);
        try { finishTest(testItem.id, 'passed'); } catch {}
      }

      // Append output for the target
      const outputBlock = [
        getStatusHeader(code, testItem.id),
        '----- BEGIN OUTPUT -----',
        ...testLog,
        '------ END OUTPUT ------'
      ].join("\n");
      run.appendOutput(outputBlock.replace(/\r?\n/g, '\r\n') + '\r\n', undefined, testItem);
      try { publishOutput(testItem.id, outputBlock.replace(/\r?\n/g, '\r\n') + '\r\n'); } catch {}
    } else {
      // No children or no parsed cases - handle as before
      const structuredMessages = buildMessagesFromTestCases(casesForMessages, workspacePath);
      const messages = structuredMessages.length > 0
        ? structuredMessages
        : analyzeTestFailures(testLog, workspacePath, testItem);
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
        try { publishOutput(testItem.id, outputBlock.replace(/\r?\n/g, '\r\n') + '\r\n'); } catch {}
        try { finishTest(testItem.id, 'failed', outputBlock); } catch {}
      } else {
        const fallbackOutput = [
          getStatusHeader(code, testItem.id),
          '----- BEGIN OUTPUT -----',
          ...testLog.length ? testLog : bazelLog,
          '------ END OUTPUT ------'
        ].join("\n");

        run.failed(testItem, new vscode.TestMessage(fallbackOutput));
        run.appendOutput(fallbackOutput.replace(/\r?\n/g, '\r\n') + '\r\n', undefined, testItem);
        try { publishOutput(testItem.id, fallbackOutput.replace(/\r?\n/g, '\r\n') + '\r\n'); } catch {}
        try { finishTest(testItem.id, 'failed', fallbackOutput); } catch {}
      }
    }
  }
}

function buildMessagesFromTestCases(testCases: IndividualTestCase[], workspacePath: string): vscode.TestMessage[] {
  const failing = testCases.filter(tc => tc.status === 'FAIL' || tc.status === 'TIMEOUT');
  return failing.map(testCase => {
    const scope = testCase.suite || testCase.className;
    const displayName = scope ? `${scope}::${testCase.name}` : testCase.name;
    const statusLabel = testCase.status === 'TIMEOUT' ? 'Timeout' : 'Failed';
    const segments = [`${displayName} (${statusLabel})`];
    if (testCase.errorMessage) {
      segments.push(testCase.errorMessage);
    }
    const message = new vscode.TestMessage(segments.join('\n\n'));
    const location = resolveLocationFromTestCase(testCase, workspacePath);
    if (location) {
      message.location = location;
    }
    return message;
  });
}

function filterTestCasesForItem(testItem: vscode.TestItem, cases: IndividualTestCase[]): IndividualTestCase[] {
  if (!testItem.id.includes('::')) {
    return cases;
  }

  const targetCaseName = extractTestCaseName(testItem.id).toLowerCase();
  const matched = cases.filter(tc => matchTestCaseName(tc, targetCaseName));
  return matched.length > 0 ? matched : cases;
}

function filterLogLinesForItem(
  testItem: vscode.TestItem,
  cases: IndividualTestCase[] | undefined,
  logLines: string[]
): string[] {
  if (!testItem.id.includes('::')) {
    return logLines;
  }

  // Extract the test case name from the testItem ID
  const targetName = extractTestCaseName(testItem.id).toLowerCase();
  if (!targetName) {
    return logLines;
  }

  // For Unity C tests, the format is: path/file.c:line:test_name:STATUS
  // We want to filter for lines that contain exactly this test name
  const unityPattern = new RegExp(`:\\d+:${escapeRegex(targetName)}:(PASS|FAIL|IGNORE)`, 'i');
  
  // Also collect test names from parsed cases for more flexible matching
  const needles = new Set<string>([targetName]);
  for (const testCase of cases ?? []) {
    needles.add(testCase.name.toLowerCase());
  }

  // Precompile patterns for all needles for efficiency
  const needlePatterns = Array.from(needles).map(needle => new RegExp(`\\b${escapeRegex(needle)}\\b`, 'i'));

  const filtered = logLines.filter(line => {
    const lower = line.toLowerCase();
    
    // First priority: Unity-style exact match (most precise)
    if (unityPattern.test(line)) {
      return true;
    }
    
    // Second priority: Line contains the exact test name
    return needlePatterns.some(p => p.test(lower));
  });

  return filtered.length > 0 ? filtered : logLines;
}

function resolveLocationFromTestCase(
  testCase: IndividualTestCase,
  workspacePath: string
): vscode.Location | undefined {
  if (!testCase.file || testCase.file.trim().length === 0) {
    return undefined;
  }

  const normalizedPath = path.normalize(testCase.file);

  // Make extraction after the `_main` separator robust by working with path segments
  const pathSegments = normalizedPath.split(path.sep).filter(segment => segment.length > 0);
  const mainIndex = pathSegments.lastIndexOf('_main');

  const trimmedPath =
    mainIndex !== -1 && mainIndex < pathSegments.length - 1
      ? path.join(...pathSegments.slice(mainIndex + 1))
      : normalizedPath;
  const absolutePath = path.isAbsolute(trimmedPath)
    ? trimmedPath
    : path.join(workspacePath, trimmedPath);

  if (!fs.existsSync(absolutePath)) {
    return undefined;
  }

  const zeroBasedLine = Math.max(0, (testCase.line || 1) - 1);
  return new vscode.Location(
    vscode.Uri.file(absolutePath),
    new vscode.Position(zeroBasedLine, 0)
  );
}

// analyzeTestFailures is now imported from parseFailures.ts
// It provides multi-framework support with configurable patterns

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

// ───────────────────────────────────────────────────────────────
// Discovery helper - used for individual test case discovery
// ───────────────────────────────────────────────────────────────

export const callRunBazelCommandForTest = async (options: {
  testId: string;
  cwd: string;
  additionalArgs?: string[];
  cancellationToken?: vscode.CancellationToken;
}): Promise<{ stdout: string; stderr: string }> => {
  const { testId, cwd, additionalArgs = [], cancellationToken } = options;
  
  let effectiveTestId = testId;
  if (/^\/\/[^:]*$/.test(testId)) {
    effectiveTestId = `${testId}/...`;
  }
  const userArgs: string[] = [...additionalArgs];
  const args = ['test', effectiveTestId, ...DEFAULT_BAZEL_TEST_FLAGS, ...userArgs];

  const { stdout, stderr } = await runBazelCommand(args, cwd, undefined, undefined, undefined, undefined, cancellationToken);
  
  return { stdout, stderr };
};
