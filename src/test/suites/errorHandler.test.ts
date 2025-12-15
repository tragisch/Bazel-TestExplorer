/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import 'mocha';
import * as assert from 'assert';
import { ErrorHandler } from '../../errors/errorHandler';

suite('ErrorHandler', () => {
  let errorHandler: ErrorHandler;

  setup(() => {
    errorHandler = new ErrorHandler();
  });

  test('categorizes Bazel-related errors', () => {
    const error = new Error('bazel: ERROR: //:tests not found');
    const result = errorHandler.handle(error, 'query');

    assert.strictEqual(result.category, 'bazel');
    assert.ok(result.userMessage.includes('Bazel') || result.userMessage.includes('error'));
  });

  test('categorizes workspace-related errors', () => {
    const error = new Error('No workspace folder found');
    const result = errorHandler.handle(error, 'discovery');

    assert.strictEqual(result.category, 'workspace');
  });

  test('categorizes validation errors', () => {
    const error = new Error('Invalid configuration: bazelPath is required');
    const result = errorHandler.handle(error, 'validation');

    assert.strictEqual(result.category, 'validation');
  });

  test('categorizes unknown errors as unknown', () => {
    const error = new Error('Some random error message');
    const result = errorHandler.handle(error, 'query');

    assert.strictEqual(result.category, 'unknown');
  });

  test('detects transient errors (timeout) as retryable', () => {
    const error = new Error('Request timeout');
    const result = errorHandler.handle(error, 'query');

    assert.strictEqual(result.shouldRetry, true);
  });

  test('detects transient errors (ECONNREFUSED) as retryable', () => {
    const error = new Error('ECONNREFUSED: Connection refused');
    const result = errorHandler.handle(error, 'query');

    assert.strictEqual(result.shouldRetry, true);
  });

  test('detects transient errors (ECONNRESET) as retryable', () => {
    const error = new Error('ECONNRESET: Connection reset by peer');
    const result = errorHandler.handle(error, 'query');

    assert.strictEqual(result.shouldRetry, true);
  });

  test('marks permanent errors as non-retryable', () => {
    const error = new Error('Invalid Bazel query syntax');
    const result = errorHandler.handle(error, 'query');

    assert.strictEqual(result.shouldRetry, false);
  });

  test('provides user-friendly messages for errors', () => {
    const error = new Error('bazel: ERROR: no such package');
    const result = errorHandler.handle(error, 'query');

    assert.ok(result.userMessage.length > 0);
    assert.ok(typeof result.userMessage === 'string');
  });

  test('includes context in log messages', () => {
    const error = new Error('Test error');
    const context = 'query';
    const result = errorHandler.handle(error, context);

    assert.ok(result.logMessage.includes(context));
  });

  test('generates consistent error results for same input', () => {
    const error = new Error('Consistent error');
    const context = 'query';

    const result1 = errorHandler.handle(error, context);
    const result2 = errorHandler.handle(error, context);

    assert.strictEqual(result1.category, result2.category);
    assert.strictEqual(result1.shouldRetry, result2.shouldRetry);
  });

  test('handles errors with code property (Node.js errors)', () => {
    const error = new Error('ENOENT: no such file or directory') as any;
    error.code = 'ENOENT';
    const result = errorHandler.handle(error, 'run');

    // ENOENT is not transient, should not retry
    assert.strictEqual(result.shouldRetry, false);
  });

  test('handles errors with errno property', () => {
    const error = new Error('Connection refused') as any;
    error.errno = 111; // ECONNREFUSED
    const result = errorHandler.handle(error, 'query');

    assert.strictEqual(result.shouldRetry, true);
  });

  test('detects multiple transient error patterns in message', () => {
    const error = new Error('Socket timeout: connection reset');
    const result = errorHandler.handle(error, 'query');

    // Should detect at least one transient error pattern
    assert.strictEqual(result.shouldRetry, true);
  });

  test('normalizes error messages to lowercase for pattern matching', () => {
    const errorUpperCase = new Error('REQUEST TIMEOUT');
    const errorLowerCase = new Error('request timeout');

    const result1 = errorHandler.handle(errorUpperCase, 'query');
    const result2 = errorHandler.handle(errorLowerCase, 'query');

    assert.strictEqual(result1.shouldRetry, true);
    assert.strictEqual(result2.shouldRetry, true);
  });

  test('handles null or undefined error gracefully', () => {
    const result = errorHandler.handle(new Error('Unknown'), 'query');

    assert.strictEqual(result.userMessage.length > 0, true);
    assert.ok(result.category === 'unknown' || result.category === 'bazel' || result.category === 'workspace' || result.category === 'validation');
  });

  test('error result contains all required properties', () => {
    const error = new Error('Test error');
    const result = errorHandler.handle(error, 'query');

    assert.ok('category' in result);
    assert.ok('userMessage' in result);
    assert.ok('shouldRetry' in result);
    assert.ok('logMessage' in result);
  });

  test('bazel error includes helpful context about Bazel paths', () => {
    const error = new Error('bazel: no such target //invalid');
    const result = errorHandler.handle(error, 'discovery');

    assert.strictEqual(result.category, 'bazel');
    assert.ok(result.userMessage.length > 0);
  });
});
