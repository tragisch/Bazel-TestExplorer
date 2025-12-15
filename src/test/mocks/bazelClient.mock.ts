/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import { BazelTestTarget } from '../../bazel/types';
import { BazelClient } from '../../bazel/client';

/**
 * Mock BazelClient für Tests
 */
export class MockBazelClient implements Partial<BazelClient> {
  private queryTestsResult: BazelTestTarget[] = [];
  private queryTestsError: Error | null = null;
  private queryTestsCallCount = 0;
  private runTestCallCount = 0;
  private validateResult = { valid: true, version: '6.0.0' };

  /**
   * Setzt Mock-Daten für queryTests
   */
  setQueryTestsResult(targets: BazelTestTarget[]): void {
    this.queryTestsResult = targets;
    this.queryTestsError = null;
  }

  /**
   * Setzt Mock-Error für queryTests
   */
  setQueryTestsError(error: Error): void {
    this.queryTestsError = error;
  }

  /**
   * Gibt die Anzahl der queryTests-Aufrufe zurück
   */
  getQueryTestsCallCount(): number {
    return this.queryTestsCallCount;
  }

  /**
   * Gibt die Anzahl der runTest-Aufrufe zurück
   */
  getRunTestCallCount(): number {
    return this.runTestCallCount;
  }

  /**
   * Mock queryTests
   */
  async queryTests(): Promise<BazelTestTarget[]> {
    this.queryTestsCallCount++;
    if (this.queryTestsError) {
      throw this.queryTestsError;
    }
    return this.queryTestsResult;
  }

  /**
   * Mock runTest
   */
  async runTest(testItem: any, run: any, token?: any): Promise<void> {
    this.runTestCallCount++;
    // Mock-Implementierung - keine echte Aktion
  }

  /**
   * Mock getTargetMetadata
   */
  getTargetMetadata(targetId: string): BazelTestTarget | undefined {
    return this.queryTestsResult.find(t => t.target === targetId);
  }

  /**
   * Mock validate
   */
  async validate(): Promise<{ valid: boolean; version?: string; error?: string }> {
    return this.validateResult;
  }

  /**
   * Mock clearCache
   */
  clearCache(pattern?: string): void {
    // Mock-Implementierung
  }

  /**
   * Mock getCacheStats
   */
  getCacheStats(): { size: number; keys: string[] } {
    return { size: 0, keys: [] };
  }

  /**
   * Getter für workspace
   */
  get workspace(): string {
    return '/mock/workspace';
  }

  /**
   * Getter für bazel
   */
  get bazel(): string {
    return 'bazel';
  }

  /**
   * Reset zu Defaults
   */
  reset(): void {
    this.queryTestsResult = [];
    this.queryTestsError = null;
    this.queryTestsCallCount = 0;
    this.runTestCallCount = 0;
    this.validateResult = { valid: true, version: '6.0.0' };
  }
}
