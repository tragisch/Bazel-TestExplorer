/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import 'mocha';
import * as assert from 'assert';
import { QueryCache } from '../../bazel/cache';
import { BazelTestTarget } from '../../bazel/types';
import { initializeLogger } from '../../logging';

suite('QueryCache', () => {
  let cache: QueryCache;

  suiteSetup(() => {
    initializeLogger();
  });

  setup(() => {
    cache = new QueryCache();
  });

  test('stores and retrieves values by key', () => {
    const key = 'test-key-1';
    const targets: BazelTestTarget[] = [
      { target: '//src:test1', type: 'cc_test', size: 'small', tags: [] },
      { target: '//src:test2', type: 'cc_test', size: 'medium', tags: [] },
    ];

    cache.set(key, targets);
    const result = cache.get(key);

    assert.deepStrictEqual(result, targets);
  });

  test('returns null for non-existent keys', () => {
    const result = cache.get('non-existent-key');

    assert.strictEqual(result, null);
  });

  test('returns null for expired entries', async () => {
    const key = 'expiring-key';
    const targets: BazelTestTarget[] = [
      { target: '//src:test1', type: 'cc_test', size: 'small', tags: [] },
    ];

    cache.set(key, targets, 100); // 100ms TTL
    assert.ok(cache.get(key) !== null);

    // Wait for TTL to expire
    await new Promise(resolve => setTimeout(resolve, 150));

    const result = cache.get(key);
    assert.strictEqual(result, null);
  });

  test('creates consistent keys from same parameters', () => {
    const queryPaths1 = ['//src:tests', '//tools:tests'];
    const queryPaths2 = ['//src:tests', '//tools:tests'];
    const testTypes = ['cc_test', 'py_test'];

    const key1 = QueryCache.createKey(queryPaths1, testTypes);
    const key2 = QueryCache.createKey(queryPaths2, testTypes);

    assert.strictEqual(key1, key2);
  });

  test('creates different keys for different queryPaths', () => {
    const queryPaths1 = ['//src:tests'];
    const queryPaths2 = ['//tools:tests'];
    const testTypes = ['cc_test'];

    const key1 = QueryCache.createKey(queryPaths1, testTypes);
    const key2 = QueryCache.createKey(queryPaths2, testTypes);

    assert.notStrictEqual(key1, key2);
  });

  test('creates different keys for different testTypes', () => {
    const queryPaths = ['//src:tests'];
    const testTypes1 = ['cc_test'];
    const testTypes2 = ['py_test'];

    const key1 = QueryCache.createKey(queryPaths, testTypes1);
    const key2 = QueryCache.createKey(queryPaths, testTypes2);

    assert.notStrictEqual(key1, key2);
  });

  test('deletes specific entries', () => {
    const key = 'delete-test';
    const targets: BazelTestTarget[] = [
      { target: '//src:test1', type: 'cc_test', size: 'small', tags: [] },
    ];

    cache.set(key, targets);
    assert.ok(cache.get(key) !== null);

    cache.delete(key);
    const result = cache.get(key);

    assert.strictEqual(result, null);
  });

  test('clears all entries when no pattern provided', () => {
    const key1 = 'key-1';
    const key2 = 'key-2';
    const targets: BazelTestTarget[] = [
      { target: '//src:test1', type: 'cc_test', size: 'small', tags: [] },
    ];

    cache.set(key1, targets);
    cache.set(key2, targets);

    cache.clear();

    assert.strictEqual(cache.get(key1), null);
    assert.strictEqual(cache.get(key2), null);
  });

  test('clears entries matching pattern', () => {
    const key1 = '//src:all';
    const key2 = '//src:other';
    const key3 = '//tools:all';
    const targets: BazelTestTarget[] = [
      { target: '//src:test1', type: 'cc_test', size: 'small', tags: [] },
    ];

    cache.set(key1, targets);
    cache.set(key2, targets);
    cache.set(key3, targets);

    // Clear entries matching "//src:" pattern
    cache.clear('//src:');

    assert.strictEqual(cache.get(key1), null);
    assert.strictEqual(cache.get(key2), null);
    assert.ok(cache.get(key3) !== null);
  });

  test('invalidates expired entries', async () => {
    const key1 = 'key-1';
    const key2 = 'key-2';
    const targets: BazelTestTarget[] = [
      { target: '//src:test1', type: 'cc_test', size: 'small', tags: [] },
    ];

    cache.set(key1, targets, 100);
    cache.set(key2, targets, 100);

    await new Promise(resolve => setTimeout(resolve, 150));

    const count = cache.invalidateExpired();

    assert.strictEqual(count, 2);
    assert.strictEqual(cache.get(key1), null);
    assert.strictEqual(cache.get(key2), null);
  });

  test('returns cache statistics', () => {
    const targets: BazelTestTarget[] = [
      { target: '//src:test1', type: 'cc_test', size: 'small', tags: [] },
    ];

    cache.set('key-1', targets);
    cache.set('key-2', targets);

    const stats = cache.getStats();

    assert.strictEqual(stats.size, 2);
    assert.ok(Array.isArray(stats.keys));
    assert.strictEqual(stats.keys.length, 2);
  });

  test('handles empty queryPaths array', () => {
    const queryPaths: string[] = [];
    const testTypes = ['cc_test'];

    const key = QueryCache.createKey(queryPaths, testTypes);
    assert.ok(typeof key === 'string');
    assert.ok(key.length > 0);
  });

  test('handles empty testTypes array', () => {
    const queryPaths = ['//src:tests'];
    const testTypes: string[] = [];

    const key = QueryCache.createKey(queryPaths, testTypes);
    assert.ok(typeof key === 'string');
    assert.ok(key.length > 0);
  });

  test('returns the same key regardless of array order', () => {
    const testTypes1 = ['cc_test', 'py_test'];
    const testTypes2 = ['py_test', 'cc_test']; // Different order
    const queryPaths = ['//src:tests'];

    const key1 = QueryCache.createKey(queryPaths, testTypes1);
    const key2 = QueryCache.createKey(queryPaths, testTypes2);

    // Keys should be the same because the function sorts internally
    assert.strictEqual(key1, key2);
  });

  test('custom TTL overrides default', async () => {
    const key = 'custom-ttl';
    const targets: BazelTestTarget[] = [
      { target: '//src:test1', type: 'cc_test', size: 'small', tags: [] },
    ];

    // Set with 200ms TTL
    cache.set(key, targets, 200);

    // Wait 100ms - should still be there
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(cache.get(key) !== null);

    // Wait another 150ms (total 250ms) - should be expired now
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.strictEqual(cache.get(key), null);
  });
});
