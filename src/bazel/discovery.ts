/*
 * Copyright (c) 2025 @tragisch
 * SPDX-License-Identifier: MIT
 */

/**
 * Test case discovery - identifies individual test cases within Bazel test targets
 */

import { createHash } from 'crypto';
import { callRunBazelCommandForTest } from './runner';
import { logWithTimestamp, formatError } from '../logging';
import { TestCaseParseResult } from './types';
import { readStructuredTestXmlResult } from './testcase/parseXml';

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
type TestXmlLoader = (targetLabel: string, workspacePath: string, bazelPath: string) => Promise<TestCaseParseResult | null>;
let xmlLoader: TestXmlLoader = readStructuredTestXmlResult;

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

export function setTestXmlLoader(loader: TestXmlLoader): void {
  xmlLoader = loader;
}

export function getTestXmlLoader(): TestXmlLoader {
  return xmlLoader;
}

export const discoverIndividualTestCases = async (
  testTarget: string,
  workspacePath: string,
  _testType?: string
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
    const { stdout } = await callRunBazelCommandForTest({
      testId: testTarget,
      cwd: workspacePath,
    });

    const bazelPath = configService.getBazelPath();
    const xmlResult = await xmlLoader(testTarget, workspacePath, bazelPath);
    if (xmlResult && xmlResult.testCases.length > 0) {
      const entry: CacheEntry = {
        result: xmlResult,
        stdoutHash: hashService.sha1(stdout),
        timestamp: Date.now()
      };
      discoveryCache.set(testTarget, entry);
      logWithTimestamp(`Found ${xmlResult.testCases.length} test cases via structured XML for ${testTarget}`);
      return xmlResult;
    }

    logWithTimestamp(`No structured test.xml available for ${testTarget}; returning empty result.`, 'warn');

    const emptyResult: TestCaseParseResult = {
      testCases: [],
      summary: { total: 0, passed: 0, failed: 0, ignored: 0 }
    };

    const entry: CacheEntry = {
      result: emptyResult,
      stdoutHash: hashService.sha1(stdout),
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
