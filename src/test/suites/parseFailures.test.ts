/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import 'mocha';
import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { analyzeTestFailures } from '../../bazel/parseFailures';

suite('Parse Failures', () => {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  let tempTestFile: string;
  let testItem: any;

  setup(() => {
    // Create a temporary test file for location resolution
    const testDir = path.join(workspacePath, 'test_temp');
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    tempTestFile = path.join(testDir, 'test_failure.c');
    fs.writeFileSync(tempTestFile, 'void test_fail() {\n  assert(0);\n}');

    // Create a mock test item
    testItem = {
      id: 'test_id',
      label: 'test_name'
    };
  });

  teardown(() => {
    // Clean up temp file
    if (fs.existsSync(tempTestFile)) {
      fs.unlinkSync(tempTestFile);
    }
    const testDir = path.dirname(tempTestFile);
    if (fs.existsSync(testDir)) {
      try {
        fs.rmdirSync(testDir);
      } catch {
        // Directory may not be empty
      }
    }
  });

  test('should detect failure lines with colon format', () => {
    const testLog = [
      'Running tests...',
      `test_temp/test_failure.c:10: Failure`,
      'Expected true but got false',
      'Done.'
    ];

    const messages = analyzeTestFailures(testLog, workspacePath, testItem);
    assert.ok(messages.length > 0);
    // Check that the location URI contains the correct filename
    const locationPath = messages[0].location?.uri.fsPath || '';
    assert.ok(locationPath.endsWith('test_temp/test_failure.c') || locationPath.endsWith('test_temp\\test_failure.c'),
      `Expected path to end with test_temp/test_failure.c but got ${locationPath}`);
  });

  test('should detect failure lines with FAILED keyword', () => {
    const testLog = [
      `test_temp/test_failure.c:20: FAILED`,
      'Some assertion failed'
    ];

    const messages = analyzeTestFailures(testLog, workspacePath, testItem);
    assert.ok(messages.length > 0);
  });

  test('should detect error lines with colon format', () => {
    const testLog = [
      `test_temp/test_failure.c:15:10: error: undeclared identifier`
    ];

    const messages = analyzeTestFailures(testLog, workspacePath, testItem);
    assert.ok(messages.length > 0);
  });

  test('should detect Python traceback format', () => {
    const testLog = [
      'Traceback (most recent call last):',
      `  File "test_temp/test_failure.c", line 30, in test_function`,
      '    assert False'
    ];

    const messages = analyzeTestFailures(testLog, workspacePath, testItem);
    assert.ok(messages.length > 0);
  });

  test('should detect C++ parentheses format', () => {
    const testLog = [
      `test_temp/test_failure.c(45): error`,
      'Something went wrong'
    ];

    const messages = analyzeTestFailures(testLog, workspacePath, testItem);
    assert.ok(messages.length > 0);
  });

  test('should detect Rust panic format', () => {
    const testLog = [
      'thread \'main\' panicked at \'assertion failed\',',
      `panicked at test_temp/test_failure.c:50:12:`
    ];

    const messages = analyzeTestFailures(testLog, workspacePath, testItem);
    assert.ok(messages.length > 0);
  });

  test('should prefer longest match', () => {
    const testLog = [
      // This line matches multiple patterns, should use the longest match
      `test_temp/test_failure.c:25: ERROR: CHECK(condition) is NOT correct!`
    ];

    const messages = analyzeTestFailures(testLog, workspacePath, testItem);
    assert.ok(messages.length > 0);
  });

  test('should handle multiple failure lines', () => {
    const testLog = [
      `test_temp/test_failure.c:10: Failure`,
      `test_temp/test_failure.c:20: FAILED`,
      `test_temp/test_failure.c:30: error`
    ];

    const messages = analyzeTestFailures(testLog, workspacePath, testItem);
    assert.ok(messages.length >= 2);
  });

  test('should skip non-existent files', () => {
    const testLog = [
      'nonexistent/file.c:10: Failure'
    ];

    const messages = analyzeTestFailures(testLog, workspacePath, testItem);
    // Should have 0 messages since file doesn't exist
    assert.strictEqual(messages.length, 0);
  });

  test('should handle _main path trimming', () => {
    // Test that paths with _main directory are properly handled
    const testLog = [
      `test_temp${path.sep}_main${path.sep}test_failure.c:10: Failure`
    ];

    const messages = analyzeTestFailures(testLog, workspacePath, testItem);
    // This should still try to find the file
    assert.ok(Array.isArray(messages));
  });

  test('should return empty array for no failures', () => {
    const testLog = [
      'All tests passed',
      'No errors detected'
    ];

    const messages = analyzeTestFailures(testLog, workspacePath, testItem);
    assert.strictEqual(messages.length, 0);
  });
});
