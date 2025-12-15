/*
 * Copyright (c) 2025 @tragisch
 * SPDX-License-Identifier: MIT
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
    
    expect(result.testCases).toEqual([]);
    expect(result.summary.total).toBe(0);
  });

  it('should use custom TTL from mock config', () => {
    const mockConfig = new MockConfigService(30000, true);
    setConfigService(mockConfig);

    expect(mockConfig.getDiscoveryTtlMs()).toBe(30000);
  });

  it('should hash correctly with mock hash service', () => {
    const mockHash = new MockHashService();
    expect(mockHash.sha1('test')).toBe('hash_4');
  });

  it('should clear cache', () => {
    clearDiscoveryCache();
    expect(getDiscoveryCacheStats().size).toBe(0);
  });
});
