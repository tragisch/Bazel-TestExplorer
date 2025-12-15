/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/**
 * Test-Utilities für vereinfachte Test-Logik
 */

/**
 * Wartet für eine bestimmte Zeit (für Async-Tests)
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Führt eine Funktion n-mal aus und gibt Ergebnisse zurück
 */
export function repeat<T>(fn: (index: number) => T, count: number): T[] {
  return Array.from({ length: count }, (_, i) => fn(i));
}

/**
 * Erstellt ein Array von Test-Targets mit verschiedenen Types
 */
export function createTestTargets(count: number = 5): any[] {
  const types = ['cc_test', 'py_test', 'java_test', 'go_test'];
  return repeat((i: number) => ({
    target: `//package${i}:test_${i}`,
    type: types[i % types.length],
    tags: ['smoke', 'unit'],
    location: `package${i}/BUILD:${i * 10}`
  }), count);
}

/**
 * Assertions-Helper
 */
export namespace Assert {
  export function notNull<T>(value: T | null | undefined, message?: string): T {
    if (value === null || value === undefined) {
      throw new Error(message || 'Value should not be null/undefined');
    }
    return value;
  }

  export function isArray<T>(value: any, message?: string): T[] {
    if (!Array.isArray(value)) {
      throw new Error(message || 'Value should be an array');
    }
    return value;
  }

  export function arrayIncludes<T>(arr: T[], item: T, message?: string): void {
    if (!arr.includes(item)) {
      throw new Error(message || `Array should include ${item}`);
    }
  }

  export function arrayLength<T>(arr: T[], length: number, message?: string): void {
    if (arr.length !== length) {
      throw new Error(message || `Array length should be ${length}, got ${arr.length}`);
    }
  }

  export function stringIncludes(str: string, substr: string, message?: string): void {
    if (!str.includes(substr)) {
      throw new Error(message || `String should include "${substr}", got "${str}"`);
    }
  }
}
