/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import 'mocha';
import * as assert from 'assert';
import { BUILTIN_TEST_PATTERNS, PATTERN_IDS_BY_TEST_TYPE, normalizeStatus, getAllTestPatterns } from '../../bazel/testPatterns';

suite('Test Patterns', () => {
  test('should have builtin test patterns', () => {
    assert.ok(BUILTIN_TEST_PATTERNS.length > 0);
    assert.strictEqual(BUILTIN_TEST_PATTERNS.length, 8);
  });

  test('unity_c_standard pattern should match valid output', () => {
    const pattern = BUILTIN_TEST_PATTERNS.find(p => p.id === 'unity_c_standard');
    assert.ok(pattern);
    
    const testLine = 'app/matrix/tests/test_sm.c:40:test_sm_active_library_should_return_non_null:PASS';
    const match = testLine.match(pattern!.pattern);
    
    assert.ok(match);
    assert.strictEqual(match![1], 'app/matrix/tests/test_sm.c');
    assert.strictEqual(match![2], '40');
    assert.strictEqual(match![3], 'test_sm_active_library_should_return_non_null');
    assert.strictEqual(match![4], 'PASS');
  });

  test('gtest_cpp pattern should match valid output', () => {
    const pattern = BUILTIN_TEST_PATTERNS.find(p => p.id === 'gtest_cpp');
    assert.ok(pattern);
    
    const testLine = '[  PASSED  ] MatrixTest.test_sm_create (5 ms)';
    const match = testLine.match(pattern!.pattern);
    
    assert.ok(match);
    assert.strictEqual(match![1], 'PASSED');
    assert.strictEqual(match![2], 'MatrixTest');
    assert.strictEqual(match![3], 'test_sm_create');
  });

  test('pytest_python pattern should match valid output', () => {
    const pattern = BUILTIN_TEST_PATTERNS.find(p => p.id === 'pytest_python');
    assert.ok(pattern);
    
    const testLine = 'tests/test_matrix.py::test_sm_create PASSED';
    const match = testLine.match(pattern!.pattern);
    
    assert.ok(match);
    assert.strictEqual(match![1], 'tests/test_matrix.py');
    assert.strictEqual(match![2], 'test_sm_create');
    assert.strictEqual(match![3], 'PASSED');
  });

  test('normalizeStatus should handle all status variants', () => {
    assert.strictEqual(normalizeStatus('PASS'), 'PASS');
    assert.strictEqual(normalizeStatus('PASSED'), 'PASS');
    assert.strictEqual(normalizeStatus('FAIL'), 'FAIL');
    assert.strictEqual(normalizeStatus('FAILED'), 'FAIL');
    assert.strictEqual(normalizeStatus('TIMEOUT'), 'TIMEOUT');
    assert.strictEqual(normalizeStatus('SKIP'), 'SKIP');
    assert.strictEqual(normalizeStatus('SKIPPED'), 'SKIP');
    assert.strictEqual(normalizeStatus('ERROR'), 'FAIL');
    assert.strictEqual(normalizeStatus('ok'), 'PASS');
    assert.strictEqual(normalizeStatus('ignored'), 'SKIP');
    assert.strictEqual(normalizeStatus('UNKNOWN'), 'FAIL');
  });

  test('PATTERN_IDS_BY_TEST_TYPE should map test types to pattern IDs', () => {
    assert.ok(PATTERN_IDS_BY_TEST_TYPE.unity_test);
    assert.ok(PATTERN_IDS_BY_TEST_TYPE.cc_test);
    assert.ok(PATTERN_IDS_BY_TEST_TYPE.py_test);
    
    assert.ok(PATTERN_IDS_BY_TEST_TYPE.unity_test.includes('unity_c_standard'));
    assert.ok(PATTERN_IDS_BY_TEST_TYPE.py_test.includes('pytest_python'));
  });

  test('getAllTestPatterns should return at least builtin patterns', () => {
    const patterns = getAllTestPatterns();
    assert.ok(patterns.length >= BUILTIN_TEST_PATTERNS.length);
  });
});
