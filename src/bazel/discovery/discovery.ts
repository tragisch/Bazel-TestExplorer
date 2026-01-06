/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/**
 * Test case discovery - identifies individual test cases within Bazel test targets
 */

import { createHash } from 'crypto';
import { callRunBazelCommandForTest } from '../runner';
import { logWithTimestamp, formatError } from '../../logging';
import { TestCaseParseResult, BazelTestTarget } from '../types';
import { PATTERN_IDS_BY_TEST_TYPE } from './patterns';
import { getTestTargetById } from '../queries';
import { parseUnifiedTestResult } from '../testcase/testResultParser';
import { getAllTestPatterns } from '../testPatterns';
import { FRAMEWORK_PATTERNS, detectFrameworks } from '../frameworkDetection';

export { setTestXmlLoader, getTestXmlLoader } from '../testcase/testResultParser';

interface CacheEntry { result: TestCaseParseResult; stdoutHash: string; timestamp: number; }

// Configuration service for dependency injection
export interface IConfigService {
  getDiscoveryTtlMs(): number;
  isDiscoveryEnabled(): boolean;
  getBazelPath(): string;
}

// Default configuration service using VS Code API
class VSCodeConfigService implements IConfigService {
  private readonly DISCOVERY_CACHE_MS_DEFAULT = 15000;

  getDiscoveryTtlMs(): number {
    try {
      const vscode = require('vscode');
      const cfg = vscode.workspace.getConfiguration('bazelTestExplorer');
      return (cfg.get('testCaseDiscoveryCacheMs', this.DISCOVERY_CACHE_MS_DEFAULT) as number);
    } catch (error) {
      logWithTimestamp(`Failed to read testCaseDiscoveryCacheMs config, using default: ${formatError(error)}`, 'warn');
      return this.DISCOVERY_CACHE_MS_DEFAULT;
    }
  }

  isDiscoveryEnabled(): boolean {
    try {
      const vscode = require('vscode');
      const cfg = vscode.workspace.getConfiguration('bazelTestExplorer');
      return (cfg.get('enableTestCaseDiscovery', true) as boolean);
    } catch (error) {
      logWithTimestamp(`Failed to read enableTestCaseDiscovery config, using default: ${formatError(error)}`, 'warn');
      return true;
    }
  }

  getBazelPath(): string {
    try {
      const vscode = require('vscode');
      const cfg = vscode.workspace.getConfiguration('bazelTestExplorer');
      return (cfg.get('bazelPath', 'bazel') as string);
    } catch (error) {
      logWithTimestamp(`Failed to read bazelPath config, using default: ${formatError(error)}`, 'warn');
      return 'bazel';
    }
  }
}

// Hash service for SHA1 generation
export interface IHashService {
  sha1(input: string): string;
}

class CryptoHashService implements IHashService {
  sha1(input: string): string {
    return createHash('sha1').update(input).digest('hex');
  }
}

const discoveryCache = new Map<string, CacheEntry>();
let configService: IConfigService = new VSCodeConfigService();
let hashService: IHashService = new CryptoHashService();
// Export for testing: allow dependency injection
export function setConfigService(service: IConfigService): void {
  configService = service;
}

export function setHashService(service: IHashService): void {
  hashService = service;
}

// Export getters for tests to capture/restore current services
export function getConfigService(): IConfigService {
  return configService;
}

export function getHashService(): IHashService {
  return hashService;
}

export const discoverIndividualTestCases = async (
  testTarget: string,
  workspacePath: string,
  testType?: string
): Promise<TestCaseParseResult> => {
  try {
    if (!configService.isDiscoveryEnabled()) {
      logWithTimestamp(`Test case discovery disabled by configuration for ${testTarget}`);
      return {
        testCases: [],
        summary: { total: 0, passed: 0, failed: 0, ignored: 0 }
      };
    }

    const ttl = configService.getDiscoveryTtlMs();
    const cache = discoveryCache.get(testTarget);
    if (cache && (Date.now() - cache.timestamp) < ttl) {
      logWithTimestamp(`Using cached test case discovery for ${testTarget}`);
      return cache.result;
    }

    if (process.env.BAZEL_TESTEXPLORER_DEBUG === '1') {
      logWithTimestamp(`Discovering individual test cases for ${testTarget}`);
    }

    // Run the test to get output with individual test case results
    const { stdout, stderr } = await callRunBazelCommandForTest({
      testId: testTarget,
      cwd: workspacePath,
    });
    const combinedOutput = [stdout, stderr].filter(Boolean).join('\n');

    const bazelPath = configService.getBazelPath();
    const allowedPatterns = resolveAllowedPatterns(testTarget, testType);
    // If we have a restricted set of allowed patterns and none of them
    // support individual test case extraction, skip the expensive
    // XML/system-out parsing. This saves time when we already know the
    // framework doesn't produce per-test entries.
    if (Array.isArray(allowedPatterns) && allowedPatterns.length > 0) {
      const all = getAllTestPatterns();
      const relevant = all.filter(p => allowedPatterns.includes(p.id));
      const anySupports = relevant.some(p => Boolean(p.supportsIndividual));
      if (!anySupports) {
        if (process.env.BAZEL_TESTEXPLORER_DEBUG === '1') {
          logWithTimestamp(`Skipping structured/system-out parsing for ${testTarget}: no allowed patterns support individual cases`);
        }
        const empty: TestCaseParseResult = {
          testCases: [],
          summary: { total: 0, passed: 0, failed: 0, ignored: 0 }
        };
        const entry: CacheEntry = {
          result: empty,
          stdoutHash: hashService.sha1(combinedOutput),
          timestamp: Date.now()
        };
        discoveryCache.set(testTarget, entry);
        return empty;
      }
    }

    const finalResult = await parseUnifiedTestResult({
      targetLabel: testTarget,
      workspacePath,
      bazelPath,
      allowedPatternIds: allowedPatterns
    });

    if (finalResult.testCases.length > 0) {
      const entry: CacheEntry = {
        result: finalResult,
        stdoutHash: hashService.sha1(combinedOutput),
        timestamp: Date.now()
      };
      discoveryCache.set(testTarget, entry);
      logWithTimestamp(`Found ${finalResult.testCases.length} test cases for ${testTarget}`);
      return finalResult;
    }

    logWithTimestamp(`No test cases discovered for ${testTarget}; returning empty result.`, 'warn');

    const emptyResult: TestCaseParseResult = {
      testCases: [],
      summary: { total: 0, passed: 0, failed: 0, ignored: 0 }
    };

    const entry: CacheEntry = {
      result: emptyResult,
      stdoutHash: hashService.sha1(combinedOutput),
      timestamp: Date.now()
    };
    discoveryCache.set(testTarget, entry);

    return emptyResult;
  } catch (error) {
    logWithTimestamp(`Failed to discover test cases for ${testTarget}: ${formatError(error)}`);
    return {
      testCases: [],
      summary: { total: 0, passed: 0, failed: 0, ignored: 0 }
    };
  }
};

export function clearDiscoveryCache(): void {
  discoveryCache.clear();
  logWithTimestamp('Cleared test discovery cache');
}

export function getDiscoveryCacheStats(): { size: number; entries: string[] } {
  return {
    size: discoveryCache.size,
    entries: Array.from(discoveryCache.keys())
  };
}

function resolveAllowedPatterns(testTarget: string, testType?: string): string[] | undefined {
  const metadata = getTestTargetById(testTarget);
  const detectedFrameworks: string[] = detectFrameworks(metadata);
  if (detectedFrameworks.length > 0) {
    const patterns = Array.from(new Set(detectedFrameworks.flatMap((framework: string) => FRAMEWORK_PATTERNS[framework] ?? [])));
    if (patterns.length > 0) {
      return patterns;
    }
  }

  if (testType && PATTERN_IDS_BY_TEST_TYPE[testType]) {
    return PATTERN_IDS_BY_TEST_TYPE[testType];
  }

  if (metadata?.type && PATTERN_IDS_BY_TEST_TYPE[metadata.type]) {
    return PATTERN_IDS_BY_TEST_TYPE[metadata.type];
  }

  return undefined;
}

// FRAMEWORK_PATTERNS and detectFrameworks moved to src/bazel/frameworkDetection.ts
