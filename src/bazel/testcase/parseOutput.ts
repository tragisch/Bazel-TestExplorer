/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/**
 * Output parser - extracts test cases from Bazel test output using configurable patterns
 */

import { logWithTimestamp } from '../../logging';
import { IndividualTestCase, TestCaseParseResult } from '../types';
import { getAllTestPatterns, normalizeStatus, TestCasePattern } from '../testPatterns';

type PatternWithOptionalStatus = TestCasePattern & { fixedStatus?: string };

export const splitOutputLines = (stdout: string): string[] => stdout.split(/\r?\n/);

export const extractTestCasesFromOutput = (
  stdout: string,
  parentTarget: string,
  allowedPatternIds?: string[]
): TestCaseParseResult => {
  const lineReader = createAnsiStrippedLineReader(stdout);
  const testCases: IndividualTestCase[] = [];
  const rustPanicRegex = /^thread '([^']+)' panicked at (.+?):(\d+):(\d+)/;
  const rustMessageRegex = /^assertion `(.*)` failed$/;
  const unittestHeaderRegex = /^FAIL:\s+([^(]+)\s+\((.+?)\)/;
  const unittestFileRegex = /^\s*File "(.+?)", line (\d+), in (.+)$/;
  const unittestMessageRegex = /^\s*(AssertionError[:\s].+)$/;
  const collectingMessage = new Map<string, string[]>();
  let pendingUnittest: {
    name: string;
    suite?: string;
    file?: string;
    line?: number;
    messages: string[];
  } | null = null;

  const all = getAllTestPatterns();
  const testPatterns = allowedPatternIds && allowedPatternIds.length
    ? all.filter(p => allowedPatternIds.includes(p.id))
    : all;

  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;
  let ignoredTests = 0;

  let currentDoctestCase: string | undefined;

  const activeRustWatchers = new Set<string>();

  const flushUnittestCase = () => {
    if (!pendingUnittest) return;
    const file = pendingUnittest.file || '';
    const lineValue = pendingUnittest.line || 0;
    const testCase: IndividualTestCase = {
      name: pendingUnittest.name,
      file,
      line: lineValue,
      parentTarget,
      status: 'FAIL',
      errorMessage: pendingUnittest.messages.join('\n') || undefined,
      suite: pendingUnittest.suite,
      frameworkId: 'python_unittest'
    };
    testCases.push(testCase);
    totalTests++;
    failedTests++;
    pendingUnittest = null;
  };

  const summaryPattern = /(\d+)\s+Tests?\s+(\d+)\s+Failures?\s+(\d+)\s+Ignored/;
  const doctestSummaryPattern = /\[doctest\]\s+test cases:\s+(\d+)\s+\|\s+(\d+)\s+passed\s+\|\s+(\d+)\s+failed\s+\|\s+(\d+)\s+skipped/i;
  let unittestTotal: number | undefined;
  let unittestFailures: number | undefined;
  let summaryLocked = false;

  const processRustWatchers = (line: string) => {
    if (activeRustWatchers.size === 0) {
      return;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    const messageMatch = trimmed.match(rustMessageRegex);
    if (messageMatch) {
      for (const testName of activeRustWatchers) {
        const messageLines = collectingMessage.get(testName);
        if (messageLines) {
          messageLines.push(messageMatch[0]);
        }
      }
      activeRustWatchers.clear();
      return;
    }
    if (trimmed.startsWith('----') || trimmed.startsWith('failures:')) {
      activeRustWatchers.clear();
    }
  };

  let line: string | undefined;
  while ((line = lineReader.next()) !== undefined) {
    processRustWatchers(line);

    if (!summaryLocked) {
      const summaryMatch = line.match(summaryPattern);
      if (summaryMatch) {
        totalTests = parseInt(summaryMatch[1], 10);
        failedTests = parseInt(summaryMatch[2], 10);
        ignoredTests = parseInt(summaryMatch[3], 10);
        passedTests = totalTests - failedTests - ignoredTests;
        summaryLocked = true;
      } else {
        const doctestSummaryMatch = line.match(doctestSummaryPattern);
        if (doctestSummaryMatch) {
          totalTests = parseInt(doctestSummaryMatch[1], 10);
          passedTests = parseInt(doctestSummaryMatch[2], 10);
          failedTests = parseInt(doctestSummaryMatch[3], 10);
          ignoredTests = parseInt(doctestSummaryMatch[4], 10);
          summaryLocked = true;
        }
      }

      if (!summaryLocked) {
        const unittestRanMatch = line.match(/^Ran\s+(\d+)\s+tests?/i);
        if (unittestRanMatch) {
          unittestTotal = parseInt(unittestRanMatch[1], 10);
        }
        const unittestFailMatch = line.match(/^FAILED\s+\((?:failures=(\d+))(?:,\s*errors=(\d+))?.*\)/i);
        if (unittestFailMatch) {
          const failures = parseInt(unittestFailMatch[1] ?? '0', 10);
          const errors = parseInt(unittestFailMatch[2] ?? '0', 10);
          unittestFailures = failures + errors;
        }
        const unittestOkMatch = line.match(/^OK\b/i);
        if (unittestOkMatch) {
          unittestTotal = unittestTotal ?? testCases.length;
          unittestFailures = 0;
        }
      }
    }

    const unittestHeaderMatch = line.match(unittestHeaderRegex);
    if (unittestHeaderMatch) {
      flushUnittestCase();
      pendingUnittest = {
        name: unittestHeaderMatch[1].trim(),
        suite: unittestHeaderMatch[2].trim(),
        messages: []
      };
      continue;
    }
    if (pendingUnittest) {
      const fileMatch = line.match(unittestFileRegex);
      if (fileMatch) {
        pendingUnittest.file = fileMatch[1];
        pendingUnittest.line = parseInt(fileMatch[2], 10) || pendingUnittest.line;
        continue;
      }
      const msgMatch = line.match(unittestMessageRegex);
      if (msgMatch) {
        pendingUnittest.messages.push(msgMatch[1].trim());
        continue;
      }
      if (!line.trim()) {
        flushUnittestCase();
        continue;
      }
    }

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
      if (collectingMessage.has(testName)) {
        activeRustWatchers.add(testName);
      }
      continue;
    }

    const doctestCaseMatch = line.match(/^TEST CASE:\s*(.+?)\s*$/i);
    if (doctestCaseMatch) {
      currentDoctestCase = doctestCaseMatch[1].trim();
      continue;
    }

    const doctestErrorMatch = line.match(/^(.+?):(\d+):\s+ERROR:\s+(.+)$/i);
    if (doctestErrorMatch) {
      const [, filePath, lineNumber, messagePart] = doctestErrorMatch;
      const testName = currentDoctestCase || `line_${lineNumber}`;
      const nextLine = lineReader.peek()?.trim();
      const extraMessage = nextLine && nextLine.toLowerCase().startsWith('values:')
        ? `\n${nextLine}`
        : '';

      const testCase: IndividualTestCase = {
        name: testName,
        file: filePath,
        line: parseInt(lineNumber, 10) || 0,
        parentTarget,
        status: 'FAIL',
        errorMessage: (messagePart + extraMessage).trim(),
        frameworkId: 'doctest_cpp'
      };

      testCases.push(testCase);
      totalTests++;
      failedTests++;
      if (extraMessage) {
        lineReader.next();
      }
      continue;
    }

    let bestMatch: { match: RegExpMatchArray; pattern: PatternWithOptionalStatus; } | null = null;

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
      const rawStatus = pattern.fixedStatus ?? (groups.status > 0 ? match[groups.status] : 'FAIL');
      const errorMessage = groups.message && groups.message > 0 ? match[groups.message] : undefined;
      const suite = groups.suite && groups.suite > 0 ? match[groups.suite] : undefined;
      const className = groups.class && groups.class > 0 ? match[groups.class] : undefined;
      const rawName = groups.testName > 0 ? match[groups.testName] : '';
      const testName = rawName || suite || className || buildFallbackName(file, lineStr);

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
  flushUnittestCase();

  for (const [testName, messages] of collectingMessage.entries()) {
    if (messages.length === 0) continue;
    const targetCase = findLatestTestCase(testCases, testName);
    if (targetCase && !targetCase.errorMessage) {
      targetCase.errorMessage = messages.join('\n');
    }
  }

  if (typeof unittestTotal === 'number') {
    totalTests = unittestTotal;
    failedTests = typeof unittestFailures === 'number' ? unittestFailures : failedTests;
    passedTests = totalTests - failedTests - ignoredTests;
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

function buildFallbackName(file: string, lineNumber: string): string {
  if (!file) {
    return `line_${lineNumber || '0'}`;
  }
  return `${file}:${lineNumber || '0'}`;
}

const ANSI_COLOR_PATTERN = /\x1B\[[0-9;]*m/g;

function stripAnsi(input: string): string {
  return input.replace(ANSI_COLOR_PATTERN, '');
}

interface StrippedLineReader {
  next(): string | undefined;
  peek(): string | undefined;
}

function createAnsiStrippedLineReader(stdout: string): StrippedLineReader {
  let offset = 0;
  const length = stdout.length;
  let peekedLine: string | undefined | null = null;

  const readNext = (): string | undefined => {
    if (offset > length) {
      return undefined;
    }

    let end = offset;
    while (end < length && stdout[end] !== '\n' && stdout[end] !== '\r') {
      end++;
    }

    const rawLine = stdout.slice(offset, end);
    if (end < length) {
      if (stdout[end] === '\r' && end + 1 < length && stdout[end + 1] === '\n') {
        offset = end + 2;
      } else {
        offset = end + 1;
      }
    } else {
      offset = end + 1;
    }

    return stripAnsi(rawLine);
  };

  return {
    next(): string | undefined {
      if (peekedLine !== null) {
        const nextLine = peekedLine;
        peekedLine = null;
        return nextLine;
      }
      return readNext();
    },
    peek(): string | undefined {
      if (peekedLine === null) {
        peekedLine = readNext();
      }
      return peekedLine === null ? undefined : peekedLine;
    }
  };
}
