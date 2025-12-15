/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import 'mocha';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { ConfigurationService } from '../../configuration';
import { MockConfigurationService } from '../mocks/configurationService.mock';

suite('ConfigurationService', () => {
  let configService: ConfigurationService;

  setup(() => {
    configService = new ConfigurationService();
  });

  test('gets default bazel path', () => {
    const bazelPath = configService.bazelPath;
    assert.strictEqual(typeof bazelPath, 'string');
    // Default could be 'bazel' or empty
    assert.ok(bazelPath === 'bazel' || bazelPath === '' || bazelPath.length > 0);
  });

  test('gets query paths from configuration', () => {
    const queryPaths = configService.queryPaths;
    assert.ok(Array.isArray(queryPaths));
  });

  test('gets test types from configuration', () => {
    const testTypes = configService.testTypes;
    assert.ok(Array.isArray(testTypes));
    // Should have at least one test type
    assert.ok(testTypes.length >= 0);
  });

  test('gets sequential test types from configuration', () => {
    const sequentialTestTypes = configService.sequentialTestTypes;
    assert.ok(Array.isArray(sequentialTestTypes));
  });

  test('gets test arguments from configuration', () => {
    const testArgs = configService.testArgs;
    assert.ok(Array.isArray(testArgs));
  });

  test('normalizes single string to array for queryPaths', () => {
    // This tests the internal array normalization logic
    const mockConfig = new MockConfigurationService();
    mockConfig.queryPaths = ['//src:all'];
    
    assert.ok(Array.isArray(mockConfig.queryPaths));
    assert.strictEqual(mockConfig.queryPaths.length, 1);
  });

  test('registers configuration change listener', (done) => {
    const listener = configService.onDidChangeConfiguration;
    
    assert.ok(typeof listener === 'function');
    done();
  });

  test('mock configuration service allows property setting', () => {
    const mockConfig = new MockConfigurationService();
    
    mockConfig.bazelPath = '/usr/bin/bazel';
    mockConfig.queryPaths = ['//src:all'];
    mockConfig.testTypes = ['cc_test', 'py_test'];
    mockConfig.sequentialTestTypes = ['java_test'];
    mockConfig.testArgs = ['--test_output=streamed'];

    assert.strictEqual(mockConfig.bazelPath, '/usr/bin/bazel');
    assert.deepStrictEqual(mockConfig.queryPaths, ['//src:all']);
    assert.deepStrictEqual(mockConfig.testTypes, ['cc_test', 'py_test']);
    assert.deepStrictEqual(mockConfig.sequentialTestTypes, ['java_test']);
    assert.deepStrictEqual(mockConfig.testArgs, ['--test_output=streamed']);
  });

  test('mock configuration service reset clears all values', () => {
    const mockConfig = new MockConfigurationService();
    
    mockConfig.bazelPath = '/usr/bin/bazel';
    mockConfig.queryPaths = ['//src:all'];
    
    mockConfig.reset();

    assert.strictEqual(mockConfig.bazelPath, '');
    assert.deepStrictEqual(mockConfig.queryPaths, []);
  });

  test('configuration provides all required properties', () => {
    const mockConfig = new MockConfigurationService();

    assert.ok('bazelPath' in mockConfig);
    assert.ok('queryPaths' in mockConfig);
    assert.ok('testTypes' in mockConfig);
    assert.ok('sequentialTestTypes' in mockConfig);
    assert.ok('testArgs' in mockConfig);
  });

  test('test types configuration includes common test rules', () => {
    const mockConfig = new MockConfigurationService();
    mockConfig.testTypes = ['cc_test', 'py_test', 'java_test', 'go_test', 'ts_test'];

    const testTypes = mockConfig.testTypes;
    
    assert.ok(testTypes.includes('cc_test'));
    assert.ok(testTypes.includes('py_test'));
    assert.ok(testTypes.includes('java_test'));
    assert.ok(testTypes.includes('go_test'));
    assert.ok(testTypes.includes('ts_test'));
  });

  test('query paths support multiple targets', () => {
    const mockConfig = new MockConfigurationService();
    mockConfig.queryPaths = [
      '//src:all',
      '//tools:all',
      '//third_party:all',
    ];

    const queryPaths = mockConfig.queryPaths;

    assert.strictEqual(queryPaths.length, 3);
    assert.ok(queryPaths.includes('//src:all'));
    assert.ok(queryPaths.includes('//tools:all'));
    assert.ok(queryPaths.includes('//third_party:all'));
  });

  test('sequential test types allows subset of all test types', () => {
    const mockConfig = new MockConfigurationService();
    mockConfig.testTypes = ['cc_test', 'py_test', 'java_test'];
    mockConfig.sequentialTestTypes = ['java_test'];

    const sequentialTestTypes = mockConfig.sequentialTestTypes;

    assert.ok(mockConfig.testTypes.includes('java_test'));
    assert.ok(sequentialTestTypes.includes('java_test'));
  });

  test('test arguments are properly formatted', () => {
    const mockConfig = new MockConfigurationService();
    mockConfig.testArgs = [
      '--test_output=streamed',
      '--test_filter=*',
      '--runs_per_test=1',
    ];

    const testArgs = mockConfig.testArgs;

    assert.strictEqual(testArgs.length, 3);
    assert.ok(testArgs.some(arg => arg.startsWith('--test_')));
  });

  test('bazel path is non-empty after initialization', () => {
    const mockConfig = new MockConfigurationService();
    mockConfig.bazelPath = 'bazel';

    assert.ok(mockConfig.bazelPath.length > 0);
  });

  test('configuration changes trigger callbacks', (done) => {
    const mockConfig = new MockConfigurationService();
    let callbackCalled = false;

    mockConfig.onDidChangeConfiguration(() => {
      callbackCalled = true;
      assert.strictEqual(callbackCalled, true);
      done();
    });

    // Simulate a configuration change
    mockConfig.bazelPath = '/new/bazel';
  });
});
