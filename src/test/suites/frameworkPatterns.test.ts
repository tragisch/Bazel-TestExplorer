/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 */

/// <reference types="mocha" />
import * as assert from 'assert';
import { extractTestCasesFromOutput } from '../../bazel/testcase/parseOutput';

suite('Extended Framework Patterns', () => {
  
  suite('Catch2 Framework', () => {
    test('should extract Catch2 failed test case', () => {
      const output = `
tests/test_math.cpp:42: FAILED: test_addition
tests/test_math.cpp:56: PASSED: test_subtraction
      `;
      
      const result = extractTestCasesFromOutput(output, '//tests:math_test', ['catch2_cpp', 'catch2_passed']);
      
      assert.strictEqual(result.testCases.length, 2);
      
      const failedTest = result.testCases.find(tc => tc.name === 'test_addition');
      assert.ok(failedTest, 'Should find test_addition');
      assert.strictEqual(failedTest?.file, 'tests/test_math.cpp');
      assert.strictEqual(failedTest?.line, 42);
      assert.strictEqual(failedTest?.status, 'FAIL');
      
      const passedTest = result.testCases.find(tc => tc.name === 'test_subtraction');
      assert.ok(passedTest, 'Should find test_subtraction');
      assert.strictEqual(passedTest?.file, 'tests/test_math.cpp');
      assert.strictEqual(passedTest?.line, 56);
      assert.strictEqual(passedTest?.status, 'PASS');
    });

    test('should extract Catch2 test case summary', () => {
      const output = `
test case 'vector operations' passed
test case 'matrix operations' failed
test case 'string operations' passed
      `;
      
      const result = extractTestCasesFromOutput(output, '//tests:operations', ['catch2_summary']);
      
      assert.strictEqual(result.testCases.length, 3);
      assert.strictEqual(result.testCases[0].name, 'vector operations');
      assert.strictEqual(result.testCases[0].status, 'PASS');
      assert.strictEqual(result.testCases[1].name, 'matrix operations');
      assert.strictEqual(result.testCases[1].status, 'FAIL');
      assert.strictEqual(result.testCases[2].name, 'string operations');
      assert.strictEqual(result.testCases[2].status, 'PASS');
    });
  });

  suite('doctest Framework', () => {
    test('should extract doctest TEST_CASE results', () => {
      const output = `
tests/math_test.cpp(15): PASSED: TEST_CASE( test_multiplication )
tests/math_test.cpp(30): FAILED: TEST_CASE( test_division )
tests/string_test.cpp(8): PASSED: TEST_CASE( test_concatenation )
      `;
      
      const result = extractTestCasesFromOutput(output, '//tests:all_tests', ['doctest_cpp']);
      
      assert.strictEqual(result.testCases.length, 3);
      
      const multiplyTest = result.testCases.find(tc => tc.name === 'test_multiplication');
      assert.ok(multiplyTest, 'Should find test_multiplication');
      assert.strictEqual(multiplyTest?.file, 'tests/math_test.cpp');
      assert.strictEqual(multiplyTest?.line, 15);
      assert.strictEqual(multiplyTest?.status, 'PASS');
      
      const divisionTest = result.testCases.find(tc => tc.name === 'test_division');
      assert.ok(divisionTest, 'Should find test_division');
      assert.strictEqual(divisionTest?.file, 'tests/math_test.cpp');
      assert.strictEqual(divisionTest?.line, 30);
      assert.strictEqual(divisionTest?.status, 'FAIL');
    });

    test('should extract doctest SUBCASE results', () => {
      const output = `
tests/math_test.cpp(20): FAILED: SUBCASE( negative numbers )
tests/math_test.cpp(25): PASSED: SUBCASE( positive numbers )
      `;
      
      const result = extractTestCasesFromOutput(output, '//tests:math', ['doctest_subcase']);
      
      assert.strictEqual(result.testCases.length, 2);
      assert.strictEqual(result.testCases[0].name, 'negative numbers');
      assert.strictEqual(result.testCases[0].status, 'FAIL');
      assert.strictEqual(result.testCases[0].line, 20);
      assert.strictEqual(result.testCases[1].name, 'positive numbers');
      assert.strictEqual(result.testCases[1].status, 'PASS');
      assert.strictEqual(result.testCases[1].line, 25);
    });
  });

  suite('CTest Framework', () => {
    test('should extract CTest output format', () => {
      const output = `
Test project /path/to/build
      Start  1: test_matrix_multiply
  1/10 Test  #1: test_matrix_multiply .....   Passed    0.05 sec
      Start  2: test_vector_add
  2/10 Test  #2: test_vector_add ..........   Failed    0.03 sec
      Start  3: test_string_ops
  3/10 Test  #3: test_string_ops ..........   ***Failed 0.02 sec
      Start  4: test_timeout_case
  4/10 Test  #4: test_timeout_case ........   ***Timeout 5.00 sec
      `;
      
      const result = extractTestCasesFromOutput(output, '//tests:cmake_tests', ['ctest_output']);
      
      assert.strictEqual(result.testCases.length, 4);
      
      const passedTest = result.testCases.find(tc => tc.name === 'test_matrix_multiply');
      assert.ok(passedTest, 'Should find test_matrix_multiply');
      assert.strictEqual(passedTest?.status, 'PASS');
      
      const failedTest = result.testCases.find(tc => tc.name === 'test_vector_add');
      assert.ok(failedTest, 'Should find test_vector_add');
      assert.strictEqual(failedTest?.status, 'FAIL');
      
      const failedTest2 = result.testCases.find(tc => tc.name === 'test_string_ops');
      assert.ok(failedTest2, 'Should find test_string_ops');
      assert.strictEqual(failedTest2?.status, 'FAIL');
      
      const timeoutTest = result.testCases.find(tc => tc.name === 'test_timeout_case');
      assert.ok(timeoutTest, 'Should find test_timeout_case');
      assert.strictEqual(timeoutTest?.status, 'TIMEOUT');
    });

    test('should extract CTest verbose mode output', () => {
      const output = `
test 1      Start  5: test_matrix_multiply
test 2      Start 10: test_vector_operations
test 3      Start 15: test_string_utils
      `;
      
      const result = extractTestCasesFromOutput(output, '//tests:verbose', ['ctest_verbose']);
      
      assert.strictEqual(result.testCases.length, 3);
      assert.strictEqual(result.testCases[0].name, 'test_matrix_multiply');
      assert.strictEqual(result.testCases[1].name, 'test_vector_operations');
      assert.strictEqual(result.testCases[2].name, 'test_string_utils');
    });
  });

  suite('Mixed Framework Output', () => {
    test('should handle output with multiple framework patterns', () => {
      const output = `
[  PASSED  ] MatrixTest.test_create (5 ms)
tests/test_math.cpp:42: FAILED: test_addition
test case 'string operations' passed
tests/doctest.cpp(15): PASSED: TEST_CASE( test_doc )
  1/4 Test  #1: test_cmake ..............   Passed    0.05 sec
      `;
      
      const result = extractTestCasesFromOutput(
        output, 
        '//tests:all', 
        ['gtest_cpp', 'catch2_cpp', 'catch2_summary', 'doctest_cpp', 'ctest_output']
      );
      
      assert.strictEqual(result.testCases.length, 5);
      assert.strictEqual(result.summary.passed, 4);
      assert.strictEqual(result.summary.failed, 1);
    });
  });

  suite('Status Normalization', () => {
    test('should normalize case variations in status', () => {
      const output = `
test case 'test1' passed
test case 'test2' PASSED
test case 'test3' failed
test case 'test4' FAILED
  1/4 Test  #1: test5 ...................   Passed    0.05 sec
  2/4 Test  #2: test6 ...................   Failed    0.05 sec
      `;
      
      const result = extractTestCasesFromOutput(
        output,
        '//tests:status_test',
        ['catch2_summary', 'ctest_output']
      );
      
      const allStatuses = result.testCases.map(tc => tc.status);
      assert.ok(allStatuses.every(s => s === 'PASS' || s === 'FAIL'), 
        'All statuses should be normalized to PASS or FAIL');
    });
  });

  suite('Framework Identification', () => {
    test('should correctly identify framework for each test case', () => {
      const output = `
tests/catch_test.cpp:42: FAILED: test_catch
tests/doctest.cpp(15): PASSED: TEST_CASE( test_doctest )
  1/2 Test  #1: test_cmake ..............   Passed    0.05 sec
      `;
      
      const result = extractTestCasesFromOutput(
        output,
        '//tests:framework_id',
        ['catch2_cpp', 'doctest_cpp', 'ctest_output']
      );
      
      assert.strictEqual(result.testCases.length, 3);
      
      const catchTest = result.testCases.find(tc => tc.name === 'test_catch');
      assert.strictEqual(catchTest?.frameworkId, 'catch2_cpp');
      
      const doctestTest = result.testCases.find(tc => tc.name === 'test_doctest');
      assert.strictEqual(doctestTest?.frameworkId, 'doctest_cpp');
      
      const ctestTest = result.testCases.find(tc => tc.name === 'test_cmake');
      assert.strictEqual(ctestTest?.frameworkId, 'ctest_output');
    });
  });
});
