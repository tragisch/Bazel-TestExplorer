/*
 * Copyright (c) 2025 @tragisch
 * SPDX-License-Identifier: MIT
 */

/// <reference types="mocha" />
import * as assert from 'assert';
import { parseStructuredTestXml } from '../../bazel/testcase/parseXml';

suite('Structured test.xml parser', () => {
  const failingXml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="3" failures="2" disabled="0" errors="0" time="0." timestamp="2025-12-18T11:02:46.723" name="AllTests">
  <testsuite name="MathLibTestFail" tests="3" failures="2" disabled="0" skipped="0" errors="0" time="0." timestamp="2025-12-18T11:02:46.723">
    <testcase name="Add" file="apps/cc/tests/gtest/test_mathlib_buggy.cc" line="6" status="run" result="completed" time="0." timestamp="2025-12-18T11:02:46.723" classname="MathLibTestFail">
      <failure message="apps/cc/tests/gtest/test_mathlib_buggy.cc:7&#x0A;Expected equality of these values:&#x0A;  add(2, 3)&#x0A;    Which is: -1&#x0A;  5&#x0A;" type=""><![CDATA[apps/cc/tests/gtest/test_mathlib_buggy.cc:7
Expected equality of these values:
  add(2, 3)
    Which is: -1
  5
]]></failure>
    </testcase>
    <testcase name="Multiply" file="apps/cc/tests/gtest/test_mathlib_buggy.cc" line="10" status="run" result="completed" time="0." timestamp="2025-12-18T11:02:46.723" classname="MathLibTestFail">
      <failure message="apps/cc/tests/gtest/test_mathlib_buggy.cc:11&#x0A;Expected equality of these values:&#x0A;  multiply(4, 2)&#x0A;    Which is: 4&#x0A;  8&#x0A;" type=""><![CDATA[apps/cc/tests/gtest/test_mathlib_buggy.cc:11
Expected equality of these values:
  multiply(4, 2)
    Which is: 4
  8
]]></failure>
    </testcase>
    <testcase name="DivideByZero" file="apps/cc/tests/gtest/test_mathlib_buggy.cc" line="14" status="run" result="completed" time="0." timestamp="2025-12-18T11:02:46.723" classname="MathLibTestFail" />
  </testsuite>
</testsuites>`;

  const passingXml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="3" failures="0" disabled="0" errors="0" time="0." timestamp="2025-12-18T11:00:50.715" name="AllTests">
  <testsuite name="MathLibTest" tests="3" failures="0" disabled="0" skipped="0" errors="0" time="0." timestamp="2025-12-18T11:00:50.715">
    <testcase name="Add" file="apps/cc/tests/gtest/test_mathlib.cc" line="6" status="run" result="completed" time="0." timestamp="2025-12-18T11:00:50.715" classname="MathLibTest" />
    <testcase name="Multiply" file="apps/cc/tests/gtest/test_mathlib.cc" line="8" status="run" result="completed" time="0." timestamp="2025-12-18T11:00:50.715" classname="MathLibTest" />
    <testcase name="Divide" file="apps/cc/tests/gtest/test_mathlib.cc" line="10" status="run" result="completed" time="0." timestamp="2025-12-18T11:00:50.715" classname="MathLibTest" />
  </testsuite>
</testsuites>`;

  test('parses failing Bazel test xml with failure messages', () => {
    const result = parseStructuredTestXml(failingXml, '//apps:mathlib_test_fail');

    assert.strictEqual(result.testCases.length, 3);
    assert.strictEqual(result.summary.failed, 2);
    const failingCase = result.testCases.find(tc => tc.name === 'Add');
    assert.ok(failingCase, 'Expected Add testcase');
    assert.strictEqual(failingCase?.status, 'FAIL');
    assert.ok(failingCase?.errorMessage?.includes('Expected equality of these values'));
  });

  test('parses successful Bazel test xml', () => {
    const result = parseStructuredTestXml(passingXml, '//apps:mathlib_test');

    assert.strictEqual(result.testCases.length, 3);
    assert.strictEqual(result.summary.passed, 3);
    assert.strictEqual(result.summary.failed, 0);
    assert.ok(result.testCases.every(tc => tc.status === 'PASS'));
  });

  test('parses skipped and timeout cases', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Mixed">
    <testcase name="SkippedCase"><skipped message="disabled via flag"/></testcase>
    <testcase name="TimeoutCase"><failure type="TIMEOUT" message="timed out">Operation timed out</failure></testcase>
  </testsuite>
</testsuites>`;

    const result = parseStructuredTestXml(xml, '//mixed:cases');

    const skipped = result.testCases.find(tc => tc.name === 'SkippedCase');
    const timeout = result.testCases.find(tc => tc.name === 'TimeoutCase');

    assert.strictEqual(skipped?.status, 'SKIP');
    assert.strictEqual(timeout?.status, 'TIMEOUT');
    assert.ok(timeout?.errorMessage?.includes('Operation timed out'));
  });
});
