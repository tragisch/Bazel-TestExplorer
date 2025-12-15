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
  private readonly section = 'bazelTestRunner';

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
