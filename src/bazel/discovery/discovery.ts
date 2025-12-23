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

    logWithTimestamp(`Discovering individual test cases for ${testTarget}`);

    // Run the test to get output with individual test case results
    const { stdout, stderr } = await callRunBazelCommandForTest({
      testId: testTarget,
      cwd: workspacePath,
    });
    const combinedOutput = [stdout, stderr].filter(Boolean).join('\n');

    const bazelPath = configService.getBazelPath();
    const allowedPatterns = resolveAllowedPatterns(testTarget, testType);
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
  const detectedFrameworks = detectFrameworks(metadata);
  if (detectedFrameworks.length > 0) {
    const patterns = Array.from(new Set(detectedFrameworks.flatMap(framework => FRAMEWORK_PATTERNS[framework] ?? [])));
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

const FRAMEWORK_PATTERNS: Record<string, string[]> = {
  rust: ['rust_test'],
  pytest: ['pytest_python', 'pytest_assertion_line'],
  unity: ['unity_c_standard', 'unity_c_with_message'],
  doctest: ['doctest_cpp', 'doctest_subcase'],
  catch2: ['catch2_cpp', 'catch2_passed', 'catch2_summary'],
  gtest: ['gtest_cpp'],
  check: ['parentheses_format', 'check_framework'],
  ctest: ['ctest_output', 'ctest_verbose'],
  go: ['go_test'],
  junit: ['junit_java']
};

function detectFrameworks(metadata?: BazelTestTarget): string[] {
  if (!metadata) {
    return [];
  }
  const frameworks = new Set<string>();
  const type = metadata.type?.toLowerCase() ?? '';
  const deps = (metadata.deps ?? []).map(dep => dep.toLowerCase());

  const hasDep = (...keywords: string[]) => deps.some(dep => keywords.some(keyword => dep.includes(keyword)));

  if (type.includes('rust')) {
    frameworks.add('rust');
  }

  if (type.includes('py_test') || hasDep('pytest')) {
    frameworks.add('pytest');
  }

  if (type.includes('go_test')) {
    frameworks.add('go');
  }

  if (type.includes('java_test') || type.includes('junit')) {
    frameworks.add('junit');
  }

  if (type.includes('cc_test')) {
    if (hasDep('gtest', 'googletest')) {
      frameworks.add('gtest');
    }
    if (hasDep('catch2')) {
      frameworks.add('catch2');
    }
    if (hasDep('doctest')) {
      frameworks.add('doctest');
    }
    if (hasDep('throw_the_switch', 'unity')) {
      frameworks.add('unity');
    }
    if (hasDep('check')) {
      frameworks.add('check');
    }
    if (hasDep('ctest')) {
      frameworks.add('ctest');
    }
  }

  return Array.from(frameworks);
}
