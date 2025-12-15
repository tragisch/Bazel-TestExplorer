/*
 * Copyright (c) 2025 @tragisch
 * SPDX-License-Identifier: MIT
 */

/**
 * Framework-spezifische Strategien für Test-Filterung
 * 
 * Bazel-First-Prinzip:
 * - Nutze native Bazel/Framework Features wo vorhanden
 * - Fallback auf ganzes Target wenn nicht unterstützt
 * - Keine Nachbauten von Bazel-Features
 */

export type TestFramework = 
  | 'gtest' | 'pytest' | 'criterion' | 'doctest'
  | 'rust' | 'go' | 'java' | 'other';

interface FilterStrategy {
  /** Ob dieses Framework Filter-Parameter unterstützt */
  supportsFilter: boolean;
  /** Parameter zum Ausführen eines spezifischen Tests */
  getFilterArgs: (testName: string) => string[];
  /** Beschreibung für Logging */
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
  
  // Frameworks ohne nativen Filter - Fallback auf ganzes Target
  rust: {
    supportsFilter: false,
    getFilterArgs: () => [],
    description: 'Rust (native) - kein Filter, führt ganzes Target aus'
  },
  go: {
    supportsFilter: false,
    getFilterArgs: () => [],
    description: 'Go - kein Filter, führt ganzes Target aus'
  },
  java: {
    supportsFilter: false,
    getFilterArgs: () => [],
    description: 'Java/JUnit - kein Filter, führt ganzes Target aus'
  },
  other: {
    supportsFilter: false,
    getFilterArgs: () => [],
    description: 'Unbekanntes Framework - konservativ ganzes Target'
  }
};

/**
 * Bestimme Bazel-Argumente für Test-Filterung
 * 
 * @param testName Name des spezifischen Tests (z.B. "test_multiply")
 * @param framework Test-Framework (z.B. "gtest")
 * @returns Array von Bazel-Argumenten, leer wenn nicht unterstützt
 */
export function getTestFilterArgs(
  testName: string,
  framework: TestFramework = 'other'
): string[] {
  const strategy = strategies[framework] ?? strategies.other;
  return strategy.getFilterArgs(testName);
}

/**
 * Prüfe ob ein Framework Test-Filterung unterstützt
 */
export function supportsTestFilter(framework: TestFramework = 'other'): boolean {
  const strategy = strategies[framework] ?? strategies.other;
  return strategy.supportsFilter;
}

/**
 * Beschreibung der Filter-Strategie (für Logging/Debugging)
 */
export function getStrategyDescription(framework: TestFramework = 'other'): string {
  const strategy = strategies[framework] ?? strategies.other;
  return strategy.description;
}

/**
 * Alle verfügbaren Frameworks
 */
export const SUPPORTED_FRAMEWORKS: TestFramework[] = Object.keys(strategies) as TestFramework[];