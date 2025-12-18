/*
 * Copyright (c) 2025 @tragisch
 * SPDX-License-Identifier: MIT
 */

/// <reference types="mocha" />
import * as assert from 'assert';
import {
  discoverIndividualTestCases,
  clearDiscoveryCache,
  getDiscoveryCacheStats,
  setConfigService,
  setHashService,
  getConfigService,
  getHashService,
  IConfigService,
  IHashService,
  setTestXmlLoader,
  getTestXmlLoader
} from '../../bazel/discovery';

class MockConfigService implements IConfigService {
  constructor(
    private ttlMs: number = 15000,
    private enabled: boolean = true
  ) {}

  getDiscoveryTtlMs(): number {
    return this.ttlMs;
  }

  isDiscoveryEnabled(): boolean {
    return this.enabled;
  }

  getBazelPath(): string {
    return 'bazel';
  }
}

class MockHashService implements IHashService {
  sha1(input: string): string {
    return `hash_${input.length}`;
  }
}

suite('discovery (cache + DI)', () => {
  let originalConfigService: IConfigService | undefined;
  let originalHashService: IHashService | undefined;
  let originalXmlLoader: ReturnType<typeof getTestXmlLoader> | undefined;

  setup(() => {
    // save originals
    originalConfigService = getConfigService();
    originalHashService = getHashService();
    originalXmlLoader = getTestXmlLoader();

    clearDiscoveryCache();
    setConfigService(new MockConfigService());
    setHashService(new MockHashService());
    setTestXmlLoader(async () => null);
  });

  teardown(() => {
    // restore originals to avoid cross-test contamination
    try {
      if (originalConfigService) {
        setConfigService(originalConfigService);
      }
      if (originalHashService) {
        setHashService(originalHashService);
      }
      if (originalXmlLoader) {
        setTestXmlLoader(originalXmlLoader);
      }
      clearDiscoveryCache();
    } catch (e) {
      // best-effort restore; tests should not throw from teardown
    }
  });

  test('should use mock config service', async () => {
    const mockConfig = new MockConfigService(5000, false);
    setConfigService(mockConfig);

    const result = await discoverIndividualTestCases('test', '/workspace');

    assert.strictEqual(result.testCases.length, 0);
    assert.strictEqual(result.summary.total, 0);
  });

  test('should use custom TTL from mock config', () => {
    const mockConfig = new MockConfigService(30000, true);
    setConfigService(mockConfig);

    assert.strictEqual(mockConfig.getDiscoveryTtlMs(), 30000);
  });

  test('should hash correctly with mock hash service', () => {
    const mockHash = new MockHashService();
    assert.strictEqual(mockHash.sha1('test'), 'hash_4');
  });

  test('should clear cache', () => {
    clearDiscoveryCache();
    assert.strictEqual(getDiscoveryCacheStats().size, 0);
  });
});
