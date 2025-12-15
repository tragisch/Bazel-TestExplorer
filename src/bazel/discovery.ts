/*
 * Copyright (c) 2025 @tragisch
 * SPDX-License-Identifier: MIT
 */

import { createHash } from 'crypto';
import { callRunBazelCommandForTest } from './runner';
import { logWithTimestamp, formatError } from '../logging';
import { TestCaseParseResult } from './types';
import { extractTestCasesFromOutput } from './testcase/parseOutput';
import { PATTERN_IDS_BY_TEST_TYPE } from './testPatterns';

interface CacheEntry { result: TestCaseParseResult; stdoutHash: string; timestamp: number; }

// Configuration service for dependency injection
export interface IConfigService {
  getDiscoveryTtlMs(): number;
  isDiscoveryEnabled(): boolean;
}

// Default configuration service using VS Code API
class VSCodeConfigService implements IConfigService {
  private readonly DISCOVERY_CACHE_MS_DEFAULT = 15000;

  getDiscoveryTtlMs(): number {
    try {
      const vscode = require('vscode');
      const cfg = vscode.workspace.getConfiguration('bazelTestRunner');
      return (cfg.get('discoveryCacheMs', this.DISCOVERY_CACHE_MS_DEFAULT) as number);
    } catch {
      return this.DISCOVERY_CACHE_MS_DEFAULT;
    }
  }

  isDiscoveryEnabled(): boolean {
    try {
      const vscode = require('vscode');
      const cfg = vscode.workspace.getConfiguration('bazelTestRunner');
      return (cfg.get('enableTestCaseDiscovery', true) as boolean);
    } catch {
      return true;
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

    const combined = [stdout, stderr].filter(Boolean).join("\n");
    const allowed = testType ? PATTERN_IDS_BY_TEST_TYPE[testType] : undefined;
    let result = extractTestCasesFromOutput(combined, testTarget, allowed);
    
    if (allowed && result.testCases.length === 0) {
      logWithTimestamp(`No test cases matched with restricted patterns for ${testTarget} [${testType}]. Trying all patterns as fallback.`, "warn");
      result = extractTestCasesFromOutput(combined, testTarget, undefined);
    }

    const entry: CacheEntry = { 
      result, 
      stdoutHash: hashService.sha1(stdout), 
      timestamp: Date.now() 
    };
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
