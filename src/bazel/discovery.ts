/*
 * Copyright (c) 2025 @tragisch
 * SPDX-License-Identifier: MIT
 */

import { callRunBazelCommandForTest } from './runner';
import { logWithTimestamp, formatError } from '../logging';
import { TestCaseParseResult } from './types';
import { extractTestCasesFromOutput } from './parseOutput';
import { PATTERN_IDS_BY_TEST_TYPE } from './testPatterns';

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
    const { stdout, stderr } = await callRunBazelCommandForTest({
      testId: testTarget,
      cwd: workspacePath,
      // Defaults already collect stdout/stderr and log the command
    });

    const combined = [stdout, stderr].filter(Boolean).join("\n");
    const allowed = testType ? PATTERN_IDS_BY_TEST_TYPE[testType] : undefined;
    let result = extractTestCasesFromOutput(combined, testTarget, allowed);
    if (allowed && result.testCases.length === 0) {
      logWithTimestamp(`No test cases matched with restricted patterns for ${testTarget} [${testType}]. Trying all patterns as fallback.`, "warn");
      result = extractTestCasesFromOutput(combined, testTarget, undefined);
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
