/*
 * Copyright (c) 2025 @tragisch
 * SPDX-License-Identifier: MIT
 */

/**
 * Output parser - extracts test cases from Bazel test output using configurable patterns
 */

import { logWithTimestamp } from '../../logging';
import { IndividualTestCase, TestCaseParseResult } from '../types';
import { getAllTestPatterns, normalizeStatus, TestCasePattern } from '../testPatterns';

export const splitOutputLines = (stdout: string): string[] => stdout.split(/\r?\n/);

export const extractTestCasesFromOutput = (
  stdout: string,
  parentTarget: string,
  allowedPatternIds?: string[]
): TestCaseParseResult => {
  const lines = stdout.split(/\r?\n/);
  const testCases: IndividualTestCase[] = [];
  const rustPanicRegex = /^thread '([^']+)' panicked at (.+?):(\d+):(\d+)/;
  const rustMessageRegex = /^assertion `(.*)` failed$/;
  const collectingMessage = new Map<string, string[]>();

  const all = getAllTestPatterns();
  const testPatterns = allowedPatternIds && allowedPatternIds.length
    ? all.filter(p => allowedPatternIds.includes(p.id))
    : all;

  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;
  let ignoredTests = 0;

  for (const line of lines) {
    const panicMatch = line.match(rustPanicRegex);
    if (panicMatch) {
      const [, testName, filePath, lineNumber] = panicMatch;
      const targetCase = findLatestTestCase(testCases, testName);
      if (targetCase) {
        if (!targetCase.file || targetCase.file.trim().length === 0) {
          targetCase.file = filePath;
        }
        const parsedLine = parseInt(lineNumber, 10);
        if (!targetCase.line || targetCase.line <= 0) {
          targetCase.line = parsedLine;
        }
      }
      continue;
    }

    let bestMatch: { match: RegExpMatchArray; pattern: TestCasePattern; } | null = null;

    for (const testPattern of testPatterns) {
      const match = line.match(testPattern.pattern);
      if (match) {
        if (!bestMatch || match[0].length > bestMatch.match[0].length) {
          bestMatch = { match, pattern: testPattern };
        }
      }
    }

    if (bestMatch) {
      const { match, pattern } = bestMatch;
      const groups = pattern.groups;

      const file = groups.file > 0 ? match[groups.file] : '';
      const lineStr = groups.line > 0 ? match[groups.line] : '0';
      const testName = match[groups.testName] || '';
      const rawStatus = pattern.fixedStatus ?? (groups.status > 0 ? match[groups.status] : 'FAIL');
      const errorMessage = groups.message && groups.message > 0 ? match[groups.message] : undefined;
      const suite = groups.suite && groups.suite > 0 ? match[groups.suite] : undefined;
      const className = groups.class && groups.class > 0 ? match[groups.class] : undefined;

      const status = normalizeStatus(rawStatus);
      if (!testName) {
        continue;
      }

      const testCase: IndividualTestCase = {
        name: testName,
        file,
        line: parseInt(lineStr, 10) || 0,
        parentTarget,
        status,
        errorMessage: errorMessage?.trim(),
        suite,
        className,
        frameworkId: pattern.id
      };

      testCases.push(testCase);
      if (!collectingMessage.has(testCase.name)) {
        collectingMessage.set(testCase.name, []);
      }
      totalTests++;

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

  // second pass to capture rust assertion messages
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const panicMatch = line.match(rustPanicRegex);
    if (panicMatch) {
      const [, testName] = panicMatch;
      const messageLines = collectingMessage.get(testName);
      if (!messageLines) continue;
      let j = i + 1;
      while (j < lines.length) {
        const candidate = lines[j].trim();
        if (!candidate) {
          j++;
          continue;
        }
        const messageMatch = candidate.match(rustMessageRegex);
        if (messageMatch) {
          messageLines.push(messageMatch[0]);
          break;
        }
        if (candidate.startsWith('----') || candidate.startsWith('failures:')) {
          break;
        }
        j++;
      }
    }
  }

  for (const [testName, messages] of collectingMessage.entries()) {
    if (messages.length === 0) continue;
    const targetCase = findLatestTestCase(testCases, testName);
    if (targetCase && !targetCase.errorMessage) {
      targetCase.errorMessage = messages.join('\n');
    }
  }

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

function findLatestTestCase(testCases: IndividualTestCase[], name: string): IndividualTestCase | undefined {
  for (let i = testCases.length - 1; i >= 0; i--) {
    if (testCases[i].name === name) {
      return testCases[i];
    }
  }
  return undefined;
}
