/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/**
 * Test filter strategies - framework-specific test filtering using native Bazel/framework features
 */

export type TestFramework = 
  | 'gtest' | 'pytest' | 'criterion' | 'doctest'
  | 'rust' | 'go' | 'java' | 'other';

interface FilterStrategy {
  /** Whether this framework supports filter parameters */
  supportsFilter: boolean;
  /** Parameters to run a specific test */
  getFilterArgs: (testName: string) => string[];
  /** Description for logging */
  description: string;
}

const strategies: Record<TestFramework, FilterStrategy> = {
  gtest: {
    supportsFilter: true,
    getFilterArgs: (testName: string) => [`--test_filter=${testName}*`],
    description: 'Google Test (C++) - unterstützt --test_filter'
  },
  pytest: {
    supportsFilter: true,
    getFilterArgs: (testName: string) => [`--test_filter=${testName}`],
    description: 'pytest (Python) - unterstützt --test_filter'
  },
  criterion: {
    supportsFilter: true,
    getFilterArgs: (testName: string) => [`--test_filter=^${testName}$`],
    description: 'Criterion (Rust) - unterstützt --test_filter mit Regex'
  },
  doctest: {
    supportsFilter: true,
    getFilterArgs: (testName: string) => [`--test_filter=${testName}`],
    description: 'doctest (Python) - unterstützt --test_filter'
  },
  
  // Frameworks without native filter - fallback to whole target
  rust: {
    supportsFilter: false,
    getFilterArgs: () => [],
    description: 'Rust (native) - no filter, runs whole target'
  },
  go: {
    supportsFilter: false,
    getFilterArgs: () => [],
    description: 'Go - no filter, runs whole target'
  },
  java: {
    supportsFilter: false,
    getFilterArgs: () => [],
    description: 'Java/JUnit - no filter, runs whole target'
  },
  other: {
    supportsFilter: false,
    getFilterArgs: () => [],
    description: 'Unknown framework - conservatively runs whole target'
  }
};

/**
 * Determine Bazel arguments for test filtering
 * 
 * @param testName Name of the specific test (e.g., "test_multiply")
 * @param framework Test framework (e.g., "gtest")
 * @returns Array of Bazel arguments, empty if not supported
 */
export function getTestFilterArgs(
  testName: string,
  framework: TestFramework = 'other'
): string[] {
  const strategy = strategies[framework] ?? strategies.other;
  return strategy.getFilterArgs(testName);
}

/**
 * Check if a framework supports test filtering
 */
export function supportsTestFilter(framework: TestFramework = 'other'): boolean {
  const strategy = strategies[framework] ?? strategies.other;
  return strategy.supportsFilter;
}

/**
 * Description of the filter strategy (for logging/debugging)
 */
export function getStrategyDescription(framework: TestFramework = 'other'): string {
  const strategy = strategies[framework] ?? strategies.other;
  return strategy.description;
}

/**
 * All supported frameworks
 */
export const SUPPORTED_FRAMEWORKS: TestFramework[] = Object.keys(strategies) as TestFramework[];