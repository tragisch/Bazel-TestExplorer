/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import * as vscode from 'vscode';

/**
 * Mock VS Code TestItem
 */
export class MockTestItem implements Partial<vscode.TestItem> {
  id: string;
  label: string;
  tags: vscode.TestTag[] = [];
  canResolveChildren = false;
  busy = false;
  uri?: vscode.Uri;
  description?: string;
  // Children stored separately for testing
  childrenMap = new Map<string, MockTestItem>();
  children: any;

  constructor(id: string, label: string, uri?: vscode.Uri) {
    this.id = id;
    this.label = label;
    this.uri = uri;
    // Minimal TestItemCollection implementation used by TestControllerManager
    this.children = {
      add: (child: MockTestItem) => {
        this.childrenMap.set(child.id, child);
      },
      get size() {
        return (Array.from((this as any).owner.childrenMap.keys()).length);
      },
      forEach: (callback: (item: MockTestItem) => void) => {
        for (const [, child] of (this.childrenMap as Map<string, MockTestItem>).entries()) {
          callback(child);
        }
      },
      [Symbol.iterator]: () => (this.childrenMap as Map<string, MockTestItem>)[Symbol.iterator]()
    } as any;
    // bind owner reference for size getter
    (this.children as any).owner = this;
  }

  addChild(child: MockTestItem): void {
    this.childrenMap.set(child.id, child);
  }
}

/**
 * Mock VS Code TestRun
 */
export class MockTestRun implements Partial<vscode.TestRun> {
  private startedTests: vscode.TestItem[] = [];
  private passedTests: vscode.TestItem[] = [];
  private failedTests: vscode.TestItem[] = [];
  private skippedTests: vscode.TestItem[] = [];
  private outputs: { output: string; item?: vscode.TestItem }[] = [];

  started(test: vscode.TestItem): void {
    this.startedTests.push(test);
  }

  passed(test: vscode.TestItem): void {
    this.passedTests.push(test);
  }

  failed(test: vscode.TestItem, messages: vscode.TestMessage | readonly vscode.TestMessage[]): void {
    this.failedTests.push(test);
  }

  skipped(test: vscode.TestItem): void {
    this.skippedTests.push(test);
  }

  appendOutput(output: string, location?: vscode.Location, test?: vscode.TestItem): void {
    this.outputs.push({ output, item: test });
  }

  end(): void {
    // Mock-Implementierung
  }

  getStartedTests(): vscode.TestItem[] {
    return this.startedTests;
  }

  getPassedTests(): vscode.TestItem[] {
    return this.passedTests;
  }

  getFailedTests(): vscode.TestItem[] {
    return this.failedTests;
  }

  getSkippedTests(): vscode.TestItem[] {
    return this.skippedTests;
  }

  getOutputs(): { output: string; item?: vscode.TestItem }[] {
    return this.outputs;
  }

  reset(): void {
    this.startedTests = [];
    this.passedTests = [];
    this.failedTests = [];
    this.skippedTests = [];
    this.outputs = [];
  }
}

/**
 * Mock VS Code TestController
 */
export class MockTestController implements Partial<vscode.TestController> {
  itemsArray: MockTestItem[] = [];
  private runProfiles: any[] = [];
  id = 'mock-controller';
  label = 'Mock Test Controller';
  // Minimal items collection to emulate vscode.TestItemCollection
  private itemsMap = new Map<string, MockTestItem>();
  items: any = {
    add: (item: MockTestItem) => {
      this.itemsMap.set(item.id, item);
    },
    [Symbol.iterator]: () => this.itemsMap[Symbol.iterator]()
  } as any;

  createTestItem(id: string, label: string, uri?: vscode.Uri): any {
    const item = new MockTestItem(id, label, uri);
    this.itemsArray.push(item);
    return item;
  }

  createRunProfile(
    label: string,
    kind: vscode.TestRunProfileKind,
    runHandler: (request: vscode.TestRunRequest, token: vscode.CancellationToken) => Thenable<void> | void,
    isDefault?: boolean
  ): vscode.TestRunProfile {
    const profile = { label, kind, runHandler, isDefault };
    this.runProfiles.push(profile);
    return profile as any;
  }

  createTestRun(request: vscode.TestRunRequest): vscode.TestRun {
    const run = new MockTestRun();
    (this as any)._lastRun = run;
    return run as any;
  }

  dispose(): void {
    // Mock-Implementierung
  }

  getRunProfiles(): any[] {
    return this.runProfiles;
  }

  getLastRun(): MockTestRun | undefined {
    return (this as any)._lastRun as MockTestRun | undefined;
  }

  reset(): void {
    this.itemsArray = [];
    this.runProfiles = [];
    this.itemsMap.clear();
    (this as any)._lastRun = undefined;
  }
}

/**
 * Test-Utility: Erstellt Mock-BazelTestTargets
 */
export function createMockBazelTestTarget(overrides?: Partial<any>): any {
  return {
    target: '//test:example',
    type: 'cc_test',
    location: 'test/BUILD:10',
    tags: ['smoke'],
    srcs: ['test.cc'],
    timeout: '30',
    size: 'small',
    toolchain: 'gcc',
    deps: [],
    tests: [],
    visibility: ['//visibility:public'],
    ...overrides
  };
}
