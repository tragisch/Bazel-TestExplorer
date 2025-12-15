/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import 'mocha';
import * as assert from 'assert';
import { extractTestCasesFromOutput, splitOutputLines } from '../../bazel/testcase/parseOutput';

suite('Parse Output', () => {
  test('splitOutputLines should split by both unix and windows line endings', () => {
    const unixOutput = 'line1\nline2\nline3';
    const lines = splitOutputLines(unixOutput);
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(lines[0], 'line1');
    assert.strictEqual(lines[2], 'line3');

    const windowsOutput = 'line1\r\nline2\r\nline3';
    const linesWindows = splitOutputLines(windowsOutput);
    assert.strictEqual(linesWindows.length, 3);
  });

  test('should extract unity_c test cases from output', () => {
    const output = `app/tests/test_main.c:10:test_create:PASS
app/tests/test_main.c:20:test_update:FAIL: Expected 5, Got 3`;

    const result = extractTestCasesFromOutput(output, '//app:tests', undefined);

    assert.strictEqual(result.testCases.length, 2);
    assert.strictEqual(result.testCases[0].name, 'test_create');
    assert.strictEqual(result.testCases[0].status, 'PASS');
    assert.strictEqual(result.testCases[1].name, 'test_update');
    assert.strictEqual(result.testCases[1].status, 'FAIL');
  });

  test('should extract gtest test cases from output', () => {
    const output = `[  PASSED  ] MatrixTest.test_create (5 ms)
[  FAILED  ] MatrixTest.test_destroy (3 ms)`;

    const result = extractTestCasesFromOutput(output, '//matrix:tests', ['gtest_cpp']);

    assert.ok(result.testCases.length >= 2);
    const testCases = result.testCases.filter((t: any) => 
      t.name === 'test_create' || t.name === 'test_destroy'
    );
    assert.strictEqual(testCases.length, 2);
  });

  test('should extract pytest test cases from output', () => {
    const output = `tests/test_math.py::test_add PASSED
tests/test_math.py::test_divide FAILED`;

    const result = extractTestCasesFromOutput(output, '//python:math_test', ['pytest_python']);

    assert.ok(result.testCases.length >= 2);
  });

  test('should filter by allowed pattern IDs', () => {
    const output = `app/tests/test_main.c:10:test_create:PASS
[  PASSED  ] MatrixTest.test_gtest (5 ms)`;

    // Only allow unity patterns
    const result = extractTestCasesFromOutput(
      output,
      '//app:tests',
      ['unity_c_standard', 'unity_c_with_message']
    );

    // Should only match the unity test, not the gtest
    assert.ok(result.testCases.length >= 1);
    const unityTests = result.testCases.filter(t => t.name === 'test_create');
    assert.strictEqual(unityTests.length, 1);
  });

  test('should parse summary line', () => {
    const output = `app/tests/test_main.c:10:test_create:PASS
app/tests/test_main.c:20:test_update:FAIL
38 Tests 1 Failures 2 Ignored`;

    const result = extractTestCasesFromOutput(output, '//app:tests', undefined);

    assert.strictEqual(result.summary.total, 38);
    assert.strictEqual(result.summary.failed, 1);
    assert.strictEqual(result.summary.ignored, 2);
    assert.strictEqual(result.summary.passed, 35);
  });

  test('should count test statuses correctly', () => {
    const output = `app/tests/test_main.c:10:test_create:PASS
app/tests/test_main.c:20:test_update:PASS
app/tests/test_main.c:30:test_delete:FAIL
app/tests/test_main.c:40:test_skip:SKIP`;

    const result = extractTestCasesFromOutput(output, '//app:tests', undefined);

    assert.strictEqual(result.testCases.length, 4);
    assert.strictEqual(result.summary.passed, 2);
    assert.strictEqual(result.summary.failed, 1);
    assert.strictEqual(result.summary.ignored, 1);
  });

  test('should handle empty output gracefully', () => {
    const result = extractTestCasesFromOutput('', '//app:tests', undefined);

    assert.strictEqual(result.testCases.length, 0);
    assert.strictEqual(result.summary.total, 0);
    assert.strictEqual(result.summary.passed, 0);
  });

  test('should extract test case with file and line information', () => {
    const output = `app/tests/test_main.c:10:test_create:PASS`;

    const result = extractTestCasesFromOutput(output, '//app:tests', undefined);

    assert.strictEqual(result.testCases.length, 1);
    assert.strictEqual(result.testCases[0].file, 'app/tests/test_main.c');
    assert.strictEqual(result.testCases[0].line, 10);
    assert.strictEqual(result.testCases[0].parentTarget, '//app:tests');
  });
});
