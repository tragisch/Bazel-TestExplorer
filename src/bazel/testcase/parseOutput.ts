/*
 * Copyright (c) 2025 @tragisch
 * SPDX-License-Identifier: MIT
 */

import { logWithTimestamp } from '../../logging';
import { IndividualTestCase, TestCaseParseResult } from '../types';
import { getAllTestPatterns, normalizeStatus, TestCasePattern } from '../testPatterns';

export const splitOutputLines = (stdout: string): string[] => stdout.split(/\r?\n/);

/**
 * Parses Bazel test output to extract individual test cases using configurable patterns
 */
export const extractTestCasesFromOutput = (
  stdout: string,
  parentTarget: string,
  allowedPatternIds?: string[]
): TestCaseParseResult => {
  const lines = stdout.split(/\r?\n/);
  const testCases: IndividualTestCase[] = [];

  // Get all available test patterns, filter if allowedPatternIds given
  const all = getAllTestPatterns();
  const testPatterns = allowedPatternIds && allowedPatternIds.length
    ? all.filter((p: TestCasePattern) => allowedPatternIds.includes(p.id))
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
      const testName = match[groups.testName] || '';  // <- Breakpoint hier
      
      // Handle status extraction: either from capture group or inferred from pattern ID
      let rawStatus: string;
      if (groups.status > 0) {
        rawStatus = match[groups.status] || 'FAIL';
      } else {
        // Breakpoint hier - zeigt welches Pattern den Status bestimmt
        // Infer status from pattern ID for patterns with fixed status
        if (pattern.id === 'catch2_cpp') rawStatus = 'FAILED';
        else if (pattern.id === 'catch2_passed') rawStatus = 'PASSED';
        else rawStatus = 'FAIL';
      }
      
      const errorMessage = groups.message && groups.message > 0 ? match[groups.message] : undefined;
      const suite = groups.suite && groups.suite > 0 ? match[groups.suite] : undefined;
      const className = groups.class && groups.class > 0 ? match[groups.class] : undefined;

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
        errorMessage: errorMessage?.trim(),
        suite,
        className,
        frameworkId: pattern.id
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
