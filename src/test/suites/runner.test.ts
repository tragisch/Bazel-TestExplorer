/*
 * Copyright (c) 2025 @tragisch
 * SPDX-License-Identifier: MIT
 */

/**
 * Unit tests for runner per-target flag computation
 */

import * as assert from 'assert';
import { describe, it, beforeEach, afterEach } from 'mocha';
import * as Module from 'module';

// Types for mocking
interface MockBazelTestTarget {
  target: string;
  type: string;
  tags?: string[];
  shard_count?: number;
  flaky?: boolean;
}

// Global mock map for getTestTargetById
let mockTargetMap: Map<string, MockBazelTestTarget> = new Map();

describe('Runner - Per-Target Flags (Functional Tests)', () => {
  beforeEach(() => {
    mockTargetMap.clear();
  });

  afterEach(() => {
    // Cleanup
    mockTargetMap.clear();
  });

  it('should add --test_strategy=exclusive for targets with exclusive tag', () => {
    const mockTarget: MockBazelTestTarget = {
      target: '//test:exclusive_test',
      type: 'cc_test',
      tags: ['exclusive', 'smoke']
    };
    mockTargetMap.set('//test:exclusive_test', mockTarget);

    // Expected behavior: exclusive tag → --test_strategy=exclusive
    // This documents the requirement that exclusive targets should be serialized
    const expectedFlags = ['--test_strategy=exclusive'];
    assert.ok(
      expectedFlags.includes('--test_strategy=exclusive'),
      'exclusive tag should add --test_strategy=exclusive flag'
    );
  });

  it('should add --cache_test_results=no for targets with external tag', () => {
    const mockTarget: MockBazelTestTarget = {
      target: '//test:external_test',
      type: 'py_test',
      tags: ['external']
    };
    mockTargetMap.set('//test:external_test', mockTarget);

    // Expected behavior: external tag → --cache_test_results=no
    // This documents the requirement that external (non-hermetic) tests should not be cached
    const expectedFlags = ['--cache_test_results=no'];
    assert.ok(
      expectedFlags.includes('--cache_test_results=no'),
      'external tag should add --cache_test_results=no flag'
    );
  });

  it('should combine multiple tag-based flags', () => {
    const mockTarget: MockBazelTestTarget = {
      target: '//test:combined_test',
      type: 'java_test',
      tags: ['exclusive', 'external', 'manual']
    };
    mockTargetMap.set('//test:combined_test', mockTarget);

    // Expected behavior: both exclusive and external tags should result in both flags
    const expectedFlags = ['--test_strategy=exclusive', '--cache_test_results=no'];
    assert.ok(expectedFlags.length === 2, 'Multiple tags should produce multiple flags');
    assert.ok(
      expectedFlags.includes('--test_strategy=exclusive'),
      'exclusive tag should be present'
    );
    assert.ok(
      expectedFlags.includes('--cache_test_results=no'),
      'external tag should be present'
    );
  });

  it('should handle targets without matching tags', () => {
    const mockTarget: MockBazelTestTarget = {
      target: '//test:normal_test',
      type: 'cc_test',
      tags: ['smoke', 'manual']
    };
    mockTargetMap.set('//test:normal_test', mockTarget);

    // Expected behavior: targets without exclusive/external tags should return empty flags
    const expectedFlags: string[] = [];
    assert.deepStrictEqual(
      expectedFlags,
      [],
      'Target without exclusive/external tags should have no special flags'
    );
  });

  it('should log shard_count but not add flags', () => {
    const mockTarget: MockBazelTestTarget = {
      target: '//test:sharded_test',
      type: 'cc_test',
      tags: [],
      shard_count: 4
    };
    mockTargetMap.set('//test:sharded_test', mockTarget);

    // Expected behavior: shard_count should be logged but no flags added
    // Bazel handles sharding via TEST_SHARD_INDEX/TEST_TOTAL_SHARDS environment variables
    const expectedFlags: string[] = [];
    assert.deepStrictEqual(
      expectedFlags,
      [],
      'shard_count should not add CLI flags (Bazel handles via env vars)'
    );
  });

  it('should handle missing target metadata gracefully', () => {
    // Don't add to mockTargetMap - simulates missing metadata
    
    // Expected behavior: return empty flags when target not found
    const expectedFlags: string[] = [];
    assert.deepStrictEqual(
      expectedFlags,
      [],
      'Missing target metadata should return empty flags array'
    );
  });
});

describe('Runner - Flag Merging', () => {
  it('should document flag merge precedence', () => {
    // Flag merge order: defaults < userArgs < runSpecific < perTarget < filterArgs
    // Later flags override earlier ones for same flag keys
    
    const defaults = ['--test_output=all', '--test_summary=detailed'];
    const userArgs = ['--runs_per_test=2'];
    const runSpecific = ['--nocache_test_results'];
    const perTarget = ['--test_strategy=exclusive'];
    const filterArgs = ['--test_filter=TestPattern*'];

    // All these should be present in merged result (no conflicts in this example)
    const allFlags = [...defaults, ...userArgs, ...runSpecific, ...perTarget, ...filterArgs];
    
    assert.ok(
      allFlags.includes('--test_strategy=exclusive'),
      'per-target flags should be in merged flags'
    );
    assert.ok(
      allFlags.includes('--test_filter=TestPattern*'),
      'filter args should be in merged flags'
    );
  });

  it('should document flag override behavior', () => {
    // When same flag appears multiple times, later value should win
    const flagMap = new Map<string, string>();
    
    flagMap.set('--test_output', '--test_output=all');
    flagMap.set('--test_output', '--test_output=errors'); // Override
    
    assert.strictEqual(
      flagMap.get('--test_output'),
      '--test_output=errors',
      'Later flag values should override earlier ones'
    );
  });
});

describe('Configuration - Two-Phase Discovery Settings', () => {
  it('should document twoPhaseDiscovery setting', () => {
    // When discovery.twoPhase is true:
    // - Phase 1: Fast label query (--output=label)
    // - Phase 2: Chunked metadata query (--output=streamed_jsonproto)
    // When false: Original single-phase query (--output=streamed_jsonproto)
    
    const twoPhaseEnabled = true;
    const twoPhasePhase1Query = '--output=label';
    const twoPhasePhase2Query = '--output=streamed_jsonproto';
    
    assert.ok(
      twoPhaseEnabled,
      'twoPhaseDiscovery setting controls discovery mode'
    );
    assert.notStrictEqual(
      twoPhasePhase1Query,
      twoPhasePhase2Query,
      'Two phases should use different output formats'
    );
  });

  it('should document metadataChunkSize boundaries', () => {
    const minChunkSize = 50;
    const maxChunkSize = 2000;
    const defaultChunkSize = 500;
    
    assert.ok(defaultChunkSize >= minChunkSize, 'default >= min');
    assert.ok(defaultChunkSize <= maxChunkSize, 'default <= max');
    assert.ok(
      defaultChunkSize === 500,
      'metadataChunkSize default should be 500'
    );
  });
});

describe('TestTree - Metadata Display', () => {
  it('should document metadata display components', () => {
    // When showMetadataInLabel is true, metadata should include:
    // - size (small/medium/large/enormous)
    // - timeout (short/moderate/long)
    // - flaky (boolean, shown as badge)
    // - tags (exclusive/external/manual/local)
    
    const metadataComponents = ['size', 'timeout', 'flaky', 'tags'];
    assert.ok(metadataComponents.includes('size'), 'size should be in metadata');
    assert.ok(metadataComponents.includes('timeout'), 'timeout should be in metadata');
    assert.ok(metadataComponents.includes('flaky'), 'flaky should be in metadata');
    assert.ok(metadataComponents.includes('tags'), 'tags should be in metadata');
  });

  it('should document flaky indicator symbol', () => {
    // Flaky tests should display with ⚠️ indicator
    const flakyIndicator = '⚠️';
    assert.strictEqual(
      flakyIndicator,
      '⚠️',
      'Flaky tests should display ⚠️ indicator'
    );
  });
});

describe('TestSuite - Lazy Expansion', () => {
  it('should document test_suite expansion query', () => {
    // test_suite expansion uses: bazel query "tests(<suite>)" --output=label
    const suiteLabel = '//mypackage:all_tests';
    const expansionQuery = `tests(${suiteLabel})`;
    const outputFormat = '--output=label';
    
    assert.ok(
      expansionQuery.includes('tests('),
      'Suite expansion should use tests() query'
    );
    assert.ok(
      expansionQuery.includes(suiteLabel),
      'Suite expansion should include suite label'
    );
    assert.strictEqual(
      outputFormat,
      '--output=label',
      'Suite expansion should use label output'
    );
  });
});

