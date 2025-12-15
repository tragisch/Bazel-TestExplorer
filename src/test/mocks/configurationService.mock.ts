/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import { ConfigurationService } from '../../configuration';

/**
 * Mock ConfigurationService für Tests
 */
export class MockConfigurationService implements Partial<ConfigurationService> {
  private _bazelPath = 'bazel';
  private _queryPaths = ['//'];
  private _testTypes = ['cc_test', 'py_test'];
  private _sequentialTestTypes: string[] = [];
  private _testArgs: string[] = [];
  private _listeners: Array<() => void> = [];

  set bazelPath(value: string) {
    this._bazelPath = value;
    this._notifyListeners();
  }
  get bazelPath(): string {
    return this._bazelPath;
  }

  set queryPaths(value: string[]) {
    this._queryPaths = value;
  }
  get queryPaths(): string[] {
    return this._queryPaths;
  }

  set testTypes(value: string[]) {
    this._testTypes = value;
  }
  get testTypes(): string[] {
    return this._testTypes;
  }

  set sequentialTestTypes(value: string[]) {
    this._sequentialTestTypes = value;
  }
  get sequentialTestTypes(): string[] {
    return this._sequentialTestTypes;
  }

  set testArgs(value: string[]) {
    this._testArgs = value;
  }
  get testArgs(): string[] {
    return this._testArgs;
  }

  onDidChangeConfiguration(listener: () => void) {
    this._listeners.push(listener);
    return { dispose: () => {
      const index = this._listeners.indexOf(listener);
      if (index > -1) {
        this._listeners.splice(index, 1);
      }
    } };
  }

  private _notifyListeners(): void {
    this._listeners.forEach(listener => listener());
  }

  /**
   * Reset zu Defaults
   */
  reset(): void {
    this._bazelPath = '';
    this._queryPaths = [];
    this._testTypes = [];
    this._sequentialTestTypes = [];
    this._testArgs = [];
  }
}
