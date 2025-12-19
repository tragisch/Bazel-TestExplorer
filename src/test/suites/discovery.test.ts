/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/// <reference types="mocha" />
import * as assert from 'assert';
import {
  discoverIndividualTestCases,
  setConfigService,
  getConfigService,
  IConfigService,
  setTestXmlLoader,
  getTestXmlLoader
} from '../../bazel/discovery';
import { TestCaseParseResult } from '../../bazel/types';
import * as runner from '../../bazel/runner';

class TestConfigService implements IConfigService {
  constructor(
    private readonly enabled: boolean = true,
    private readonly ttlMs: number = 15000
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

suite('Discovery', () => {
  const mockWorkspacePath = '/mock/workspace';
  let originalCall: typeof runner.callRunBazelCommandForTest | undefined;
  let originalConfigService: IConfigService | undefined;
  let originalXmlLoader: ReturnType<typeof getTestXmlLoader> | undefined;
  let callCount = 0;
  let xmlResults: Map<string, TestCaseParseResult | null>;

  const createResultForTarget = (target: string): TestCaseParseResult => ({
    testCases: [
      {
        name: 'test_one',
        file: 'tests/test_example.py',
        line: 1,
        parentTarget: target,
        status: 'PASS'
      },
      {
        name: 'test_two',
        file: 'tests/test_example.py',
        line: 5,
        parentTarget: target,
        status: 'FAIL',
        errorMessage: 'Expected true to be false'
      }
    ],
    summary: { total: 2, passed: 1, failed: 1, ignored: 0 }
  });

  setup(() => {
    // stub out Bazel command execution to provide deterministic output
    callCount = 0;
    originalCall = runner.callRunBazelCommandForTest;
    (runner as any).callRunBazelCommandForTest = async (options: any) => {
      callCount++;
      const testId: string = options?.testId || '';
      // simple pytest-style output for parsing
      const pytestOutput = `tests/test_example.py::test_one PASSED\ntests/test_example.py::test_two FAILED\n2 Tests 1 Failures 0 Ignored`;
      const gtestOutput = `[  PASSED  ] MatrixTest.test_create (5 ms)\n[  FAILED  ] MatrixTest.test_fail (3 ms)`;
      const unityOutput = `apps/tests/test_main.c:10:test_one:PASS
apps/tests/test_main.c:12:test_two:FAIL`;

      if (testId.includes('invalid/target') || testId.includes('definitely/invalid')) {
        throw new Error(`Simulated Bazel failure for ${testId}`);
      }

      if (testId.includes('no_xml')) {
        return { stdout: '', stderr: '' };
      }

      if (testId.includes('cached_target')) {
        return { stdout: pytestOutput, stderr: '' };
      }

      if (testId.includes('gtest_target')) {
        return { stdout: gtestOutput, stderr: '' };
      }

      if (testId.includes('augment')) {
        return { stdout: unityOutput, stderr: '' };
      }

      return { stdout: pytestOutput, stderr: '' };
    };

    // Force discovery to be enabled for the default test runs
    originalConfigService = getConfigService();
    setConfigService(new TestConfigService(true));

    xmlResults = new Map();
    originalXmlLoader = getTestXmlLoader();
    setTestXmlLoader(async (target: string, _workspace?: string, _bazel?: string, _allowed?: string[]) => {
      if (xmlResults.has(target)) {
        return xmlResults.get(target) ?? null;
      }
      return createResultForTarget(target);
    });
  });

  teardown(() => {
    // restore original function
    try {
      if (originalCall) {
        (runner as any).callRunBazelCommandForTest = originalCall;
      }
      if (originalConfigService) {
        setConfigService(originalConfigService);
      }
      if (originalXmlLoader) {
        setTestXmlLoader(originalXmlLoader);
      }
    } catch (e) {
      // swallow
    }
  });

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

  test('should fall back to output parser when XML missing', async () => {
    const target = '//test:needs_fallback';
    xmlResults.set(target, null);

    const result = await discoverIndividualTestCases(target, mockWorkspacePath, 'py_test');

    assert.ok(result.testCases.length >= 2);
    const testOne = result.testCases.find(tc => tc.name === 'test_one');
    assert.strictEqual(testOne?.file, 'tests/test_example.py');
  });

  test('should augment structured XML data when file information missing', async () => {
    const target = '//test:augment';
    xmlResults.set(target, {
      testCases: [
        {
          name: 'test_one',
          file: '',
          line: 0,
          parentTarget: target,
          status: 'PASS'
        }
      ],
      summary: { total: 1, passed: 1, failed: 0, ignored: 0 }
    });

    const result = await discoverIndividualTestCases(target, mockWorkspacePath, 'cc_test');
    assert.strictEqual(result.testCases[0].file, 'apps/tests/test_main.c');
    assert.ok(result.testCases[0].line > 0);
  });

  test('should implement caching mechanism', async () => {
    // This is a functional test - we call discovery twice for the same target
    // The second call should use cache (no actual Bazel execution)
    const target = '//test:cached_target';
    
    // First call
    callCount = 0;
    const result1 = await discoverIndividualTestCases(target, mockWorkspacePath);
    
    // Immediate second call should use cache
    const result2 = await discoverIndividualTestCases(target, mockWorkspacePath);

    assert.ok(result1);
    assert.ok(result2);
    // Both should return valid results
    assert.ok(Array.isArray(result1.testCases));
    assert.ok(Array.isArray(result2.testCases));
    // callRunBazelCommandForTest should have been invoked only once for the cached target
    assert.strictEqual(callCount, 1);
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

  test('should return empty result when XML is missing', async () => {
    const target = '//test:no_xml';
    xmlResults.set(target, null);

    const result = await discoverIndividualTestCases(target, mockWorkspacePath);

    assert.ok(Array.isArray(result.testCases));
    assert.strictEqual(result.testCases.length, 0);
    assert.strictEqual(result.summary.total, 0);
  });

  test('should return empty when discovery disabled via config', async () => {
    const origConfig = getConfigService();
    try {
      setConfigService(new TestConfigService(false, 1000));

      const res = await discoverIndividualTestCases('//test:whatever', mockWorkspacePath);
      assert.ok(res);
      assert.strictEqual(res.testCases.length, 0);
      assert.strictEqual(res.summary.total, 0);
    } finally {
      // restore original
      setConfigService(origConfig as any);
    }
  });
});
