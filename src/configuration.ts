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

// Configuration constants
const MIN_PARALLEL_QUERIES = 1;
const MAX_PARALLEL_QUERIES = 64;
const DEFAULT_PARALLEL_QUERIES = 4;

const MIN_CHUNK_SIZE = 50;
const MAX_CHUNK_SIZE = 2000;
const DEFAULT_CHUNK_SIZE = 500;

/**
 * Clamps a value between min and max
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Centralizes Bazel test settings with type-safe getters and sensible defaults.
 * Restores the `ConfigurationService` API expected across the codebase while
 * providing runtime fallbacks if settings were removed from package.json.
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

  get coverageArgs(): string[] {
    return this.normalizeStringArray(this.config.get<string[]>('coverageArgs', ['--instrumentation_filter=.*']));
  }

  get cppDemanglerPath(): string | undefined {
    const value = this.config.get<string>('demangler.cpp', '').trim();
    return value.length > 0 ? value : undefined;
  }

  get rustDemanglerPath(): string | undefined {
    const value = this.config.get<string>('demangler.rust', '').trim();
    return value.length > 0 ? value : undefined;
  }

  get buildTestsOnly(): boolean {
    return this.config.get<boolean>('buildTestsOnly', false);
  }

  get enableTestCaseDiscovery(): boolean {
    return this.config.get<boolean>('enableTestCaseDiscovery', false) ?? false;
  }

  // Fallback defaults for settings that may be removed from package.json
  get runsPerTest(): number {
    return this.config.get<number>('runsPerTest', 0) ?? 0;
  }

  get runsPerTestDetectsFlakes(): boolean {
    return this.config.get<boolean>('runsPerTestDetectsFlakes', false) ?? false;
  }

  get nocacheTestResults(): boolean {
    return this.config.get<boolean>('nocacheTestResults', false) ?? false;
  }

  get testStrategyExclusive(): boolean {
    return this.config.get<boolean>('testStrategyExclusive', false) ?? false;
  }

  // Performance tuning: cap parallel Bazel queries to avoid process oversubscription
  get maxParallelQueries(): number {
    const value = this.config.get<number>('maxParallelQueries', DEFAULT_PARALLEL_QUERIES);
    const n = typeof value === 'number' ? value : DEFAULT_PARALLEL_QUERIES;
    return clamp(n, MIN_PARALLEL_QUERIES, MAX_PARALLEL_QUERIES);
  }

  get showMetadataInLabel(): boolean {
    return this.config.get<boolean>('showMetadataInLabel', false);
  }
  get metadataChunkSize(): number {
    const value = this.config.get<number>('discovery.metadataChunkSize', DEFAULT_CHUNK_SIZE);
    const n = typeof value === 'number' ? value : DEFAULT_CHUNK_SIZE;
    return clamp(n, MIN_CHUNK_SIZE, MAX_CHUNK_SIZE);
  }

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
