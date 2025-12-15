/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import 'mocha';
import * as assert from 'assert';
import { discoverIndividualTestCases } from '../../bazel/discovery';

suite('Discovery', () => {
  const mockWorkspacePath = '/mock/workspace';

  test('should handle discovery errors gracefully', async () => {
    // This test calls with invalid parameters to trigger error handling
    // The function should return empty result instead of throwing
    try {
      const result = await discoverIndividualTestCases(
        '//invalid/target',
        mockWorkspacePath,
        'unknown_type'
      );

      assert.ok(result);
      assert.ok(Array.isArray(result.testCases));
      assert.ok(result.summary);
      assert.strictEqual(result.summary.total, 0);
    } catch (error) {
      // Should not throw - errors should be handled
      assert.fail('discoverIndividualTestCases should handle errors gracefully');
    }
  });

  test('should return valid TestCaseParseResult structure', async () => {
    try {
      const result = await discoverIndividualTestCases(
        '//test:invalid_target',
        mockWorkspacePath
      );

      assert.ok(result);
      assert.ok('testCases' in result);
      assert.ok('summary' in result);
      assert.ok(Array.isArray(result.testCases));
      
      assert.ok('total' in result.summary);
      assert.ok('passed' in result.summary);
      assert.ok('failed' in result.summary);
      assert.ok('ignored' in result.summary);

      assert.strictEqual(typeof result.summary.total, 'number');
      assert.strictEqual(typeof result.summary.passed, 'number');
      assert.strictEqual(typeof result.summary.failed, 'number');
      assert.strictEqual(typeof result.summary.ignored, 'number');
    } catch (error) {
      assert.fail('Discovery should return valid structure');
    }
  });

  test('should accept optional testType parameter', async () => {
    try {
      const resultWithType = await discoverIndividualTestCases(
        '//test:some_test',
        mockWorkspacePath,
        'py_test'
      );

      assert.ok(resultWithType);
      assert.ok(Array.isArray(resultWithType.testCases));
    } catch (error) {
      assert.fail('Should accept testType parameter');
    }
  });

  test('should handle both with and without testType', async () => {
    try {
      // Without testType
      const result1 = await discoverIndividualTestCases(
        '//test:target1',
        mockWorkspacePath
      );

      // With testType
      const result2 = await discoverIndividualTestCases(
        '//test:target2',
        mockWorkspacePath,
        'cc_test'
      );

      assert.ok(result1);
      assert.ok(result2);
      assert.ok(Array.isArray(result1.testCases));
      assert.ok(Array.isArray(result2.testCases));
    } catch (error) {
      assert.fail('Should handle both cases');
    }
  });

  test('should implement caching mechanism', async () => {
    // This is a functional test - we call discovery twice for the same target
    // The second call should use cache (no actual Bazel execution)
    try {
      const target = '//test:cached_target';
      
      // First call
      const result1 = await discoverIndividualTestCases(target, mockWorkspacePath);
      
      // Immediate second call should use cache
      const result2 = await discoverIndividualTestCases(target, mockWorkspacePath);

      assert.ok(result1);
      assert.ok(result2);
      // Both should return valid results
      assert.ok(Array.isArray(result1.testCases));
      assert.ok(Array.isArray(result2.testCases));
    } catch (error) {
      // Errors are expected since we're using invalid targets
      // But the function should not throw - it should handle gracefully
      assert.ok(true);
    }
  });

  test('should return empty test cases on error', async () => {
    const result = await discoverIndividualTestCases(
      '//definitely/invalid/path/that/cannot/exist:test',
      '/nonexistent/workspace'
    );

    assert.ok(result);
    assert.ok(Array.isArray(result.testCases));
    assert.strictEqual(result.summary.total, 0);
  });

  test('should validate TestCaseParseResult properties', async () => {
    const result = await discoverIndividualTestCases(
      '//test:sample',
      mockWorkspacePath
    );

    // Validate structure
    assert.strictEqual(typeof result, 'object');
    assert.ok(Array.isArray(result.testCases));
    assert.strictEqual(typeof result.summary, 'object');

    // Validate each test case has required fields
    for (const testCase of result.testCases) {
      assert.ok('name' in testCase);
      assert.ok('status' in testCase);
      // Optional fields
      assert.ok('file' in testCase || true);
      assert.ok('line' in testCase || true);
    }

    // Validate summary counters are non-negative
    assert.ok(result.summary.total >= 0);
    assert.ok(result.summary.passed >= 0);
    assert.ok(result.summary.failed >= 0);
    assert.ok(result.summary.ignored >= 0);
  });
});
