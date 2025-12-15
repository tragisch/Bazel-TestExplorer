/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import 'mocha';
import * as assert from 'assert';
import { BazelTestTarget } from '../../bazel/types';
import { MockConfigurationService, MockBazelClient } from '../mocks';

suite('BazelClient', () => {
  let mockClient: MockBazelClient;
  let mockConfig: MockConfigurationService;

  setup(() => {
    mockConfig = new MockConfigurationService();
    mockConfig.bazelPath = 'bazel';
    mockConfig.queryPaths = ['//src:all'];
    mockConfig.testTypes = ['cc_test', 'py_test'];

    mockClient = new MockBazelClient();
  });

  test('initializes with configuration', () => {
    assert.strictEqual(mockClient.getQueryTestsCallCount(), 0);
    assert.strictEqual(mockClient.getRunTestCallCount(), 0);
  });

  test('tracks queryTests calls', async () => {
    const target: BazelTestTarget = {
      target: '//src/bin:test1',
      type: 'cc_test',
      size: 'small',
      tags: [],
    };
    mockClient.setQueryTestsResult([target]);

    const result = await mockClient.queryTests();

    assert.strictEqual(mockClient.getQueryTestsCallCount(), 1);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].target, '//src/bin:test1');
  });

  test('tracks multiple queryTests calls', async () => {
    const target: BazelTestTarget = {
      target: '//src/bin:test1',
      type: 'cc_test',
      size: 'small',
      tags: [],
    };
    mockClient.setQueryTestsResult([target]);

    await mockClient.queryTests();
    await mockClient.queryTests();
    await mockClient.queryTests();

    assert.strictEqual(mockClient.getQueryTestsCallCount(), 3);
  });

  test('tracks runTest calls', async () => {
    await mockClient.runTest(null, null);

    assert.strictEqual(mockClient.getRunTestCallCount(), 1);
  });

  test('handles queryTests errors', async () => {
    mockClient.setQueryTestsError(new Error('Query failed'));

    try {
      await mockClient.queryTests();
      assert.fail('Should have thrown an error');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.strictEqual(mockClient.getQueryTestsCallCount(), 1);
    }
  });

  test('mock client can clear cache', () => {
    mockClient.clearCache();

    const stats = mockClient.getCacheStats();
    assert.strictEqual(stats.size, 0);
  });

  test('mock client clears cache by pattern', () => {
    mockClient.clearCache('//src:');

    const stats = mockClient.getCacheStats();
    assert.strictEqual(stats.size, 0);
  });

  test('queryTests returns array of targets', async () => {
    const targets: BazelTestTarget[] = [
      {
        target: '//src/bin:test_one',
        type: 'cc_test',
        size: 'small',
        tags: [],
      },
      {
        target: '//src/bin:test_two',
        type: 'cc_test',
        size: 'medium',
        tags: ['manual'],
      },
    ];

    mockClient.setQueryTestsResult(targets);

    const result = await mockClient.queryTests();

    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].target, '//src/bin:test_one');
  });

  test('getTargetMetadata retrieves target by id', () => {
    const target: BazelTestTarget = {
      target: '//src/bin:mytest',
      type: 'cc_test',
      size: 'small',
      tags: [],
    };
    mockClient.setQueryTestsResult([target]);

    const metadata = mockClient.getTargetMetadata('//src/bin:mytest');

    assert.ok(metadata !== undefined);
    assert.strictEqual(metadata?.target, '//src/bin:mytest');
  });

  test('getTargetMetadata returns undefined for unknown target', () => {
    const target: BazelTestTarget = {
      target: '//src/bin:test1',
      type: 'cc_test',
      size: 'small',
      tags: [],
    };
    mockClient.setQueryTestsResult([target]);

    const metadata = mockClient.getTargetMetadata('//src/bin:unknown');

    assert.strictEqual(metadata, undefined);
  });

  test('validate returns valid configuration', async () => {
    const result = await mockClient.validate();

    assert.ok('valid' in result);
    assert.strictEqual(result.valid, true);
  });

  test('mock client provides cache stats', () => {
    const stats = mockClient.getCacheStats();

    assert.ok('size' in stats);
    assert.ok('keys' in stats);
    assert.ok(typeof stats.size === 'number');
    assert.ok(Array.isArray(stats.keys));
  });

  test('error handling preserves error information', async () => {
    const errorMsg = 'Bazel query syntax error';
    mockClient.setQueryTestsError(new Error(errorMsg));

    try {
      await mockClient.queryTests();
      assert.fail('Should throw');
    } catch (error) {
      assert.ok(error instanceof Error);
      if (error instanceof Error) {
        assert.strictEqual(error.message, errorMsg);
      }
    }
  });
});
