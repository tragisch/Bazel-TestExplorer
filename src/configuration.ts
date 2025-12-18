/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 *
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/**
 * Configuration service - centralizes Bazel test runner settings with type-safe access
 */

import * as vscode from 'vscode';

/**
 * Centralizes Bazel test settings with type-safe getters and sensible defaults.
 * Avoids scattered workspace.getConfiguration calls.
 */
export class ConfigurationService {
  private readonly section = 'bazelTestExplorer';

  private get config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(this.section);
  }

  get bazelPath(): string {
    return this.config.get<string>('bazelPath', 'bazel');
  }

  get queryPaths(): string[] {
    return this.normalizeStringArray(this.config.get<string[]>('queryPaths', ['//']));
  }

  get testTypes(): string[] {
    return this.normalizeStringArray(this.config.get<string[]>('testTypes', ['cc_test', 'unity_test', 'java_test']));
  }

  get sequentialTestTypes(): string[] {
    return this.normalizeStringArray(this.config.get<string[]>('sequentialTestTypes', []));
  }

  get testArgs(): string[] {
    return this.normalizeStringArray(this.config.get<string[]>('testArgs', []));
  }

  get bazelFlags(): string[] {
    return this.normalizeStringArray(this.config.get<string[]>('bazelFlags', []));
  }

  get buildTestsOnly(): boolean {
    return this.config.get<boolean>('buildTestsOnly', false);
  }

  /**
   * Runs-per-test: number of times to run each test (0 = disabled)
   */
  get runsPerTest(): number {
    return this.config.get<number>('runsPerTest', 0);
  }

  /**
   * Optional regex to apply per-test runs in the form of Bazel's `--runs_per_test=<regex>@<number>`
   */
  get runsPerTestRegex(): string | undefined {
    return this.config.get<string | undefined>('runsPerTestRegex', undefined);
  }

  get runsPerTestDetectsFlakes(): boolean {
    return this.config.get<boolean>('runsPerTestDetectsFlakes', false);
  }

  get nocacheTestResults(): boolean {
    return this.config.get<boolean>('nocacheTestResults', false);
  }

  get testStrategyExclusive(): boolean {
    return this.config.get<boolean>('testStrategyExclusive', false);
  }

  get shardingEnabled(): boolean {
    return this.config.get<boolean>('shardingEnabled', false);
  }

  get shardTotal(): number {
    return this.config.get<number>('shardTotal', 0);
  }

  get shardIndex(): number {
    return this.config.get<number>('shardIndex', 0);
  }

  /**
   * Listen to configuration changes
   */
  onDidChangeConfiguration(listener: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(this.section)) {
        listener();
      }
    });
  }

  private normalizeStringArray(values: string[] | undefined, fallback: string[] = []): string[] {
    return (values ?? fallback)
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
}
