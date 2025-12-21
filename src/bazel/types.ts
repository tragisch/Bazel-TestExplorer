/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/**
 * Type definitions - interfaces for Bazel targets, test cases, and parsing results
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
    shard_count?: number;
}

/**
 * Represents an individual test case discovered from test output
 */
export interface IndividualTestCase {
    name: string;
    file: string;
    line: number;
    parentTarget: string;
    status: 'PASS' | 'FAIL' | 'TIMEOUT' | 'SKIP';
    errorMessage?: string;
    suite?: string;
    className?: string;
    frameworkId?: string;
}

/**
 * Result of parsing test output to extract individual test cases
 */
export interface TestCaseParseResult {
    testCases: IndividualTestCase[];
    summary: {
        total: number;
        passed: number;
        failed: number;
        ignored: number;
    };
}