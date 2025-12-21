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
import { finishTest, publishOutput } from '../explorer/testEventBus';
import { runBazelCommand } from './process';
import { logWithTimestamp, measure, formatError } from '../logging';
import { ConfigurationService } from '../configuration';
import { analyzeTestFailures } from './parseFailures';
import { TestFramework } from './testFilterStrategies';
import { parseUnifiedTestResult, UnifiedTestResult } from './testcase/testResultParser';
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

    const { code, stdout, stderr } = await measure(`Execute test: ${testItem.id}`, () =>
      initiateBazelTest(testItem.id, workspacePath, run, testItem, config, cancellationToken)
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
      return;
    }

    //clear testresult window



    const shouldParseStructured = code === 0 || code === 3 || code === 4;
    const unifiedResult = shouldParseStructured
      ? await parseUnifiedTestResult({
          targetLabel: testItem.id,
          workspacePath,
          bazelPath: config.bazelPath,
        })
      : null;

    const { input: testLog } = parseBazelOutput(stdout);
    const { input: bazelLog } = parseBazelOutput(stderr);
    const baseDisplayLog = filterLogLinesForItem(testItem, undefined, testLog);

      if (code === 0) {
      if (baseDisplayLog.length > 0) {
        const outputBlock = [
          getStatusHeader(code, testItem.id),
          '----- BEGIN OUTPUT -----',
          ...baseDisplayLog,
          '------ END OUTPUT ------'
        ].join("\n");

        const out = outputBlock.replace(/\r?\n/g, '\r\n') + '\r\n';
        run.appendOutput(out, undefined, testItem);
        try { publishOutput(testItem.id, out); } catch {}
      }
      run.passed(testItem);
      try { finishTest(testItem.id, 'passed'); } catch {}
    } else if (code === 3) {
      const relevantCases = unifiedResult ? filterTestCasesForItem(testItem, unifiedResult.testCases) : [];
      const scopedDisplayLog = relevantCases.length > 0
        ? filterLogLinesForItem(testItem, relevantCases, testLog)
        : baseDisplayLog;
      handleTestResult(
        run,
        testItem,
        code,
        bazelLog,
        scopedDisplayLog,
        workspacePath,
        unifiedResult ?? EMPTY_UNIFIED_RESULT,
        relevantCases
      );
    } else if (code === 4) {
      run.skipped(testItem);
      vscode.window.showWarningMessage(`⚠️ Flaky tests: ${testItem.id}`);
      try { finishTest(testItem.id, 'skipped'); } catch {}
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
): Promise<{ code: number; stdout: string; stderr: string }> => {
  let effectiveTestId = testId;
  let filterArgs: string[] = [];

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
    
    if (supportsTestFilter(framework)) {
      filterArgs = getTestFilterArgs(testName, framework);
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

  const args = ['test', effectiveTestId, ...mergedFlags];

  // No sharding support configured (removed shared shard settings)
  const env: NodeJS.ProcessEnv | undefined = undefined;

  return runBazelCommand(
    args,
    cwd,
    undefined,
    undefined,
    config.bazelPath,
    env,
    cancellationToken
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
  workspacePath: string,
  parsedResult: UnifiedTestResult,
  scopedCases: IndividualTestCase[]
) {
  if (code === 0) {
    run.passed(testItem); // just to be sure
  } else {
    const casesForMessages = scopedCases.length > 0 ? scopedCases : parsedResult.testCases;
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

  const targetCaseName = testItem.id.split('::').slice(1).join('::').toLowerCase();
  const directMatches = cases.filter(tc => tc.name.toLowerCase() === targetCaseName);
  if (directMatches.length > 0) {
    return directMatches;
  }

  const scopedMatches = cases.filter(tc => {
    const scope = (tc.suite || tc.className || '').toLowerCase();
    const combined = scope ? `${scope}::${tc.name.toLowerCase()}` : tc.name.toLowerCase();
    return combined === targetCaseName;
  });

  return scopedMatches.length > 0 ? scopedMatches : cases;
}

function filterLogLinesForItem(
  testItem: vscode.TestItem,
  cases: IndividualTestCase[] | undefined,
  logLines: string[]
): string[] {
  if (!testItem.id.includes('::')) {
    return logLines;
  }

  const needles = new Set<string>();
  for (const testCase of cases ?? []) {
    needles.add(testCase.name.toLowerCase());
    if (testCase.suite) {
      needles.add(testCase.suite.toLowerCase());
    }
    if (testCase.className) {
      needles.add(testCase.className.toLowerCase());
    }
  }

  const targetName = testItem.id.split('::').slice(1).join('::').toLowerCase();
  if (targetName) {
    needles.add(targetName);
  }

  const terms = Array.from(needles).filter(term => term.length > 0);
  if (terms.length === 0) {
    return logLines;
  }

  const filtered = logLines.filter(line => {
    const lower = line.toLowerCase();
    return terms.some(needle => lower.includes(needle));
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
