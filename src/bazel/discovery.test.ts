/*
 * Copyright (c) 2025 @tragisch
 * SPDX-License-Identifier: MIT
 */

import 'mocha';
import * as assert from 'assert';
import {
  discoverIndividualTestCases,
  clearDiscoveryCache,
  getDiscoveryCacheStats,
  setConfigService,
  setHashService,
  IConfigService,
  IHashService
} from './discovery';

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
}

class MockHashService implements IHashService {
  sha1(input: string): string {
    return `hash_${input.length}`;
  }
}

describe('discovery', () => {
  beforeEach(() => {
    clearDiscoveryCache();
    setConfigService(new MockConfigService());
    setHashService(new MockHashService());
  });

  it('should use mock config service', async () => {
    const mockConfig = new MockConfigService(5000, false);
    setConfigService(mockConfig);

    const result = await discoverIndividualTestCases('test', '/workspace');
    
    assert.strictEqual(result.testCases.length, 0);
    assert.strictEqual(result.summary.total, 0);
  });

  it('should use custom TTL from mock config', () => {
    const mockConfig = new MockConfigService(30000, true);
    setConfigService(mockConfig);

    assert.strictEqual(mockConfig.getDiscoveryTtlMs(), 30000);
  });

  it('should hash correctly with mock hash service', () => {
    const mockHash = new MockHashService();
    assert.strictEqual(mockHash.sha1('test'), 'hash_4');
  });

  it('should clear cache', () => {
    clearDiscoveryCache();
    assert.strictEqual(getDiscoveryCacheStats().size, 0);
  });
});
