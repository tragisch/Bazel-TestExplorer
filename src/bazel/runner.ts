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
import { finishTest, publishOutput } from '../explorer/testEventBus';
import { runBazelCommand } from './process';
import { logWithTimestamp, measure, formatError } from '../logging';
import { ConfigurationService } from '../configuration';
import { analyzeTestFailures } from './parseFailures';
import { extractTestCasesFromOutput } from './testcase/parseOutput';
import { TestFramework } from './testFilterStrategies';

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

        const out = outputBlock.replace(/\r?\n/g, '\r\n') + '\r\n';
        run.appendOutput(out, undefined, testItem);
        try { publishOutput(testItem.id, out); } catch {}
      }
      run.passed(testItem);
      try { finishTest(testItem.id, 'passed'); } catch {}
    } else if (code === 3) {
      handleTestResult(run, testItem, code, bazelLog, testLog, workspacePath);
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

  const additionalArgs: string[] = [...config.testArgs];
  const args = ['test', effectiveTestId, ...DEFAULT_BAZEL_TEST_FLAGS, ...additionalArgs, ...filterArgs];

  return runBazelCommand(
    args,
    cwd,
    undefined,
    undefined,
    config.bazelPath,
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

  const args = ['test', effectiveTestId, ...DEFAULT_BAZEL_TEST_FLAGS, ...additionalArgs];
  const { stdout, stderr } = await runBazelCommand(args, cwd, undefined, undefined, undefined, cancellationToken);
  
  return { stdout, stderr };
};
