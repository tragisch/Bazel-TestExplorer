/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

export interface BazelTestTarget {
    target: string;
    type: string;
    location?: string;
    tags?: string[];
    srcs?: string[];
    timeout?: string;
    size?: string;
    flaky?: boolean;
    toolchain?: string;
    deps?: string[];
    tests?: string[];
    visibility?: string[];
}

/**
 * Represents an individual test case within a Bazel test target
 */
export interface IndividualTestCase {
    /** The name of the test case (e.g., "test_sm_create") */
    name: string;
    /** File path where the test is defined */
    file: string;
    /** Line number where the test is defined */
    line: number;
    /** The parent Bazel target (e.g., "//app/matrix:test_sm") */
    parentTarget: string;
    /** Status of the test case: PASS, FAIL, etc. */
    status?: 'PASS' | 'FAIL' | 'TIMEOUT' | 'SKIP';
    /** Error message if the test failed */
    errorMessage?: string;
}

/**
 * Result of parsing Bazel test output for individual test cases
 */
export interface TestCaseParseResult {
    /** List of individual test cases found */
    testCases: IndividualTestCase[];
    /** Summary information */
    summary: {
        total: number;
        passed: number;
        failed: number;
        ignored: number;
    };
}