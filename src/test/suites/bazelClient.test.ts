/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/// <reference types="mocha" />
import * as assert from 'assert';
import { BazelTestTarget } from '../../bazel/types';
import { MockConfigurationService, MockBazelClient } from '../mocks';
import { BazelClient } from '../../bazel/client';
import * as processModule from '../../bazel/process';

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

  suite('BazelClient (integration)', () => {
    let originalRun: typeof processModule.runBazelCommand | undefined;
    let config: MockConfigurationService;
    let client: BazelClient;

    setup(() => {
      // stub runBazelCommand to avoid spawning Bazel
      originalRun = processModule.runBazelCommand;
      (processModule as any).runBazelCommand = async (
        args: string[],
        cwd: string,
        onLine?: (line: string) => void,
        onErrorLine?: (line: string) => void,
        bazelPath?: string
      ) => {
        const cmd = args[0];
        if (cmd === 'query') {
          // emit two JSONproto RULE lines
          const lines = [
            JSON.stringify({ type: 'RULE', rule: { name: '//src/bin:test_one', ruleClass: 'cc_test', attribute: [] } }),
            JSON.stringify({ type: 'RULE', rule: { name: '//src/bin:test_two', ruleClass: 'py_test', attribute: [] } })
          ];
          for (const l of lines) {
            if (onLine) onLine(l);
          }
          return { code: 0, stdout: lines.join('\n'), stderr: '' };
        }

        if (args[0] === 'version') {
          const line = 'Build label: bazel 6.0.0';
          if (onLine) onLine(line);
          return { code: 0, stdout: line + '\n', stderr: '' };
        }

        // default fallback for other commands
        return { code: 0, stdout: '', stderr: '' };
      };

      config = new MockConfigurationService();
      config.bazelPath = 'bazel';
      config.queryPaths = ['//src:all'];
      config.testTypes = ['cc_test', 'py_test'];

      client = new BazelClient('/mock/workspace', (config as unknown) as any);
    });

    teardown(() => {
      if (originalRun) {
        (processModule as any).runBazelCommand = originalRun;
      }
    });

    test('queryTests returns discovered targets and caches them', async () => {
      const targets = await client.queryTests();
      assert.ok(Array.isArray(targets));
      assert.strictEqual(targets.length, 2);
      const stats = client.getCacheStats();
      assert.ok(stats.size >= 1);
    });

    test('getTargetMetadata returns a target by id', async () => {
      await client.queryTests();
      const meta = client.getTargetMetadata('//src/bin:test_one');
      assert.ok(meta);
      assert.strictEqual(meta?.target, '//src/bin:test_one');
    });

    test('validate returns valid true when bazel version present', async () => {
      const res = await client.validate();
      assert.strictEqual(res.valid, true);
      assert.ok(typeof res.version === 'string');
    });

    test('clearCache clears internal cache', async () => {
      await client.queryTests();
      const before = client.getCacheStats();
      assert.ok(before.size >= 1);
      client.clearCache();
      const after = client.getCacheStats();
      assert.strictEqual(after.size, 0);
    });
  });
});
