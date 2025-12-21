/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/**
 * Test patterns - regex patterns for parsing test output from various frameworks (gtest, pytest, etc.)
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
    // Optional: a pattern that always yields a fixed status (e.g. 'FAIL')
    fixedStatus?: string;
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
        id: "pytest_assertion_line",
        framework: "PyTest (Python)",
        pattern: /^\s*(.+?\.py):(\d+):\s*(AssertionError(?:.*)?)$/,
        groups: {
            file: 1,
            line: 2,
            testName: 0,
            status: 0,
            message: 3
        },
        description: "PyTest traceback line (file:line: AssertionError...) used to capture source locations",
        example: "apps/tests/test_math.py:7: AssertionError",
        supportsIndividual: false,
        fixedStatus: 'FAIL'
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
    },
    {
        id: "catch2_cpp",
        framework: "Catch2 (C++)",
        pattern: /^(.+?):(\d+):\s*FAILED:\s*(.+?)$/,
        groups: {
            file: 1,
            line: 2,
            testName: 3,
            status: 0,  // Always FAILED for this pattern
            message: 0
        },
        description: "Catch2 C++ test framework failure output",
        example: "tests/test_math.cpp:42: FAILED: test_addition",
        supportsIndividual: true,
        filterTemplate: '${name}'
    },
    {
        id: "catch2_passed",
        framework: "Catch2 (C++)",
        pattern: /^(.+?):(\d+):\s*PASSED:\s*(.+?)$/,
        groups: {
            file: 1,
            line: 2,
            testName: 3,
            status: 0,  // Always PASSED
            message: 0
        },
        description: "Catch2 C++ test framework success output",
        example: "tests/test_math.cpp:42: PASSED: test_addition",
        supportsIndividual: true,
        filterTemplate: '${name}'
    },
    {
        id: "catch2_summary",
        framework: "Catch2 (C++)",
        pattern: /^test case '(.+?)' (passed|failed)$/i,
        groups: {
            file: 0,
            line: 0,
            testName: 1,
            status: 2,
            message: 0
        },
        description: "Catch2 C++ test case summary line",
        example: "test case 'test_addition' passed",
        supportsIndividual: true,
        filterTemplate: '${name}'
    },
    {
        id: "doctest_cpp",
        framework: "doctest (C++)",
        pattern: /^(.+?)\((\d+)\):\s*(FAILED|PASSED|ERROR):\s*TEST_CASE\(\s*(.+?)\s*\)$/,
        groups: {
            file: 1,
            line: 2,
            testName: 4,
            status: 3,
            message: 0
        },
        description: "doctest C++ framework output",
        example: "tests/math_test.cpp(15): PASSED: TEST_CASE( test_multiplication )",
        supportsIndividual: true,
        filterTemplate: '${name}'
    },
    {
        id: "doctest_subcase",
        framework: "doctest (C++)",
        pattern: /^(.+?)\((\d+)\):\s*(FAILED|PASSED):\s*SUBCASE\(\s*(.+?)\s*\)$/,
        groups: {
            file: 1,
            line: 2,
            testName: 4,
            status: 3,
            message: 0
        },
        description: "doctest C++ subcase output",
        example: "tests/math_test.cpp(20): FAILED: SUBCASE( negative numbers )",
        supportsIndividual: false
    },
    {
        id: "check_framework",
        framework: "Check (C)",
        pattern: /^(.+?):(\d+):F:([^:]+):([^:]+):\d+:\s*(.+)$/,
        groups: {
            file: 1,
            line: 2,
            suite: 3,
            testName: 4,
            status: 0,
            message: 5
        },
        description: "Check unit test framework failure output",
        example: "apps/tests/mathlib_buggy_test.c:44:F:Multiply:test_multiply_zero:0: Assertion failed",
        supportsIndividual: true,
        filterTemplate: '${suite}.${name}',
        fixedStatus: 'FAIL'
    },
    {
        id: "ctest_output",
        framework: "CTest (CMake/Bazel)",
        pattern: /^\s*(\d+)\/(\d+)\s+Test\s+#\d+:\s+(.+?)\s+\.+\s*(Passed|Failed|\*\*\*Failed|\*\*\*Timeout)/,
        groups: {
            file: 0,
            line: 0,
            testName: 3,
            status: 4,
            message: 0
        },
        description: "CTest test runner output format",
        example: "  1/10 Test  #5: test_matrix_multiply ....   Passed",
        supportsIndividual: true,
        filterTemplate: '${name}'
    },
    {
        id: "ctest_verbose",
        framework: "CTest (CMake/Bazel)",
        pattern: /^test\s+(\d+)\s+Start\s+\d+:\s+(.+?)$/,
        groups: {
            file: 0,
            line: 0,
            testName: 2,
            status: 0,  // Status from separate line
            message: 0
        },
        description: "CTest verbose mode test start",
        example: "test 1      Start  5: test_matrix_multiply",
        supportsIndividual: true,
        filterTemplate: '${name}'
    }
]

// Mapping from Bazel rule/test type to allowed pattern IDs
// Note: Many C/C++ tests (cc_test) can use different frameworks (Unity, gtest, catch2, etc.).
// Therefore we include Unity patterns for cc_test as well.
export const PATTERN_IDS_BY_TEST_TYPE: Record<string, string[]> = {
    unity_test: ["unity_c_standard", "unity_c_with_message"],
    cc_test: [
        "unity_c_standard", 
        "unity_c_with_message", 
        "gtest_cpp", 
        "catch2_cpp", 
        "catch2_passed", 
        "catch2_summary",
        "doctest_cpp",
        "doctest_subcase",
        "ctest_output",
        "ctest_verbose",
        "parentheses_format"
    ],
    py_test: ["pytest_python", "pytest_assertion_line"],
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
    'ignored': 'SKIP',
    'passed': 'PASS',
    'failed': 'FAIL',
    '***Failed': 'FAIL',
    '***Timeout': 'TIMEOUT',
    'Passed': 'PASS',
    'Failed': 'FAIL'
};

export function getAllTestPatterns(): TestCasePattern[] {
    let allPatterns = [...BUILTIN_TEST_PATTERNS];

    try {
        const vscode = require('vscode');
        const config = vscode.workspace.getConfiguration("bazelTestExplorer");
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
