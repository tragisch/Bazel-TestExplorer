/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

export interface TestCasePattern {
    id: string;
    framework: string;
    pattern: RegExp;
    groups: {
        file: number;
        line: number;
        testName: number;
        status: number;
        message?: number;
        suite?: number;   // optional: suite/testcase group (e.g., gtest)
        class?: number;   // optional: class group (e.g., junit)
    };
    description: string;
    example: string;
    // Whether this framework supports individual test execution
    supportsIndividual?: boolean;
    // Template to build a filter string for individual test execution
    // Supported placeholders: ${name}, ${suite}, ${class}, ${file}
    filterTemplate?: string;
}

// We now filter the patterns below by their `id` using `PATTERN_IDS_BY_TEST_TYPE` in runner.ts to avoid trying all regexes unnecessarily.
export const BUILTIN_TEST_PATTERNS: TestCasePattern[] = [
    {
        id: "unity_c_standard",
        framework: "Unity C Framework",
        pattern: /^(.+?):(\d+):([^:]+):(PASS|FAIL|TIMEOUT|SKIP)(?::\s*(.+))?$/,
        groups: {
            file: 1,
            line: 2,
            testName: 3,
            status: 4,
            message: 5
        },
        description: "Standard Unity C test framework output",
        example: "app/matrix/tests/test_sm.c:40:test_sm_active_library_should_return_non_null:PASS",
        supportsIndividual: true,
        filterTemplate: '${name}'
    },
    {
        id: "unity_c_with_message",
        framework: "Unity C Framework (with error message)",
        pattern: /^(.+?):(\d+):([^:]+):(PASS|FAIL|TIMEOUT|SKIP):\s*(.+)$/,
        groups: {
            file: 1,
            line: 2,
            testName: 3,
            status: 4,
            message: 5
        },
        description: "Unity C test framework with detailed error messages",
        example: "app/matrix/tests/test_sm.c:576:test_sm_determinant_5x5:FAIL: Expected -120120 Was -120120.008",
        supportsIndividual: true,
        filterTemplate: '${name}'
    },
    {
        id: "gtest_cpp",
        framework: "Google Test (C++)",
        pattern: /^\[\s*(PASSED|FAILED|TIMEOUT|SKIPPED)\s*\]\s+(.+?)\.(.+?)\s+\((\d+)\s+ms\)$/,
        groups: {
            file: 0,
            line: 0,
            testName: 3,
            status: 1,
            message: 0,
            suite: 2
        },
        description: "Google Test C++ framework output",
        example: "[  PASSED  ] MatrixTest.test_sm_create (5 ms)",
        supportsIndividual: true,
        filterTemplate: '${suite}.${name}'
    },
    {
        id: "pytest_python",
        framework: "PyTest (Python)",
        pattern: /^(.+?)::(.+?)\s+(PASSED|FAILED|SKIPPED|ERROR)(?:\s+(.+))?$/,
        groups: {
            file: 1,
            line: 0,
            testName: 2,
            status: 3,
            message: 4
        },
        description: "Python PyTest framework output",
        example: "tests/test_matrix.py::test_sm_create PASSED",
        supportsIndividual: true,
        filterTemplate: '${file}::${name}'
    },
    {
        id: "go_test",
        framework: "Go Test",
        pattern: /^\s*=== (RUN|PASS|FAIL|SKIP)\s+(.+?)$/,
        groups: {
            file: 0,
            line: 0,
            testName: 2,
            status: 1,
            message: 0
        },
        description: "Go test framework output",
        example: "=== PASS TestMatrixCreate",
        supportsIndividual: true,
        filterTemplate: '${name}'
    },
    {
        id: "rust_test",
        framework: "Rust Test",
        pattern: /^test\s+(.+?)\s+\.\.\.\s+(ok|FAILED|ignored)(?:\s+(.+))?$/,
        groups: {
            file: 0,
            line: 0,
            testName: 1,
            status: 2,
            message: 3
        },
        description: "Rust test framework output",
        example: "test matrix::test_sm_create ... ok",
        supportsIndividual: true,
        filterTemplate: '${name}'
    },
    {
        id: "junit_java",
        framework: "JUnit (Java)",
        pattern: /^(.+?)\((.+?)\):\s+(PASS|FAIL|ERROR|SKIP)(?:\s+(.+))?$/,
        groups: {
            file: 0,
            line: 0,
            testName: 1,
            status: 3,
            message: 4,
            class: 2
        },
        description: "JUnit Java framework output",
        example: "testMatrixCreate(MatrixTest): PASS",
        supportsIndividual: true,
        filterTemplate: '${class}#${name}'
    },
    {
        id: "parentheses_format",
        framework: "Generic (Parentheses Format)",
        pattern: /^(.+?)\((\d+)\):\s*([^:]+):\s*(PASS|FAIL|TIMEOUT|SKIP)(?:\s+(.+))?$/,
        groups: {
            file: 1,
            line: 2,
            testName: 3,
            status: 4,
            message: 5
        },
        description: "Generic test framework with file(line): format",
        example: "matrix_test.c(45): test_create: PASS",
        supportsIndividual: true,
        filterTemplate: '${name}'
    }
];

// Mapping from Bazel rule/test type to allowed pattern IDs
// Note: Many C/C++ tests (cc_test) can use different frameworks (Unity, gtest, catch2, etc.).
// Therefore we include Unity patterns for cc_test as well.
export const PATTERN_IDS_BY_TEST_TYPE: Record<string, string[]> = {
    unity_test: ["unity_c_standard", "unity_c_with_message"],
    cc_test: ["unity_c_standard", "unity_c_with_message", "gtest_cpp", "parentheses_format"],
    py_test: ["pytest_python"],
    rust_test: ["rust_test"],
    go_test: ["go_test"],
    java_test: ["junit_java"],
};

export const STATUS_MAPPING: Record<string, 'PASS' | 'FAIL' | 'TIMEOUT' | 'SKIP'> = {
    'PASS': 'PASS',
    'FAIL': 'FAIL',
    'TIMEOUT': 'TIMEOUT',
    'SKIP': 'SKIP',
    'PASSED': 'PASS',
    'FAILED': 'FAIL',
    'SKIPPED': 'SKIP',
    'ERROR': 'FAIL',
    'RUN': 'SKIP',
    'ok': 'PASS',
    'ignored': 'SKIP'
};

export function getAllTestPatterns(): TestCasePattern[] {
    let allPatterns = [...BUILTIN_TEST_PATTERNS];

    try {
        const vscode = require('vscode');
        const config = vscode.workspace.getConfiguration("bazelTestRunner");
        const customPatterns = config.get("customTestPatterns", []) as any[];

        for (const customPattern of customPatterns) {
            if (customPattern.id && customPattern.pattern && customPattern.groups) {
                try {
                    const pattern: TestCasePattern = {
                        id: customPattern.id,
                        framework: customPattern.framework || 'Custom',
                        pattern: new RegExp(customPattern.pattern),
                        groups: customPattern.groups,
                        description: customPattern.description || 'Custom pattern from settings',
                        example: customPattern.example || 'No example provided'
                    };
                    allPatterns.push(pattern);
                } catch (error) {
                    console.warn(`Invalid custom test pattern "${customPattern.id}":`, error);
                }
            }
        }
    } catch (error) {
        // VS Code module not available, use built-in patterns only
    }

    return allPatterns;
}

export function normalizeStatus(status: string): 'PASS' | 'FAIL' | 'TIMEOUT' | 'SKIP' {
    const normalized = STATUS_MAPPING[status];
    return normalized || 'FAIL';
}
