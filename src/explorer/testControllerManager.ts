/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/**
 * Test controller manager - orchestrates VS Code test discovery, execution, and UI integration
 */

import * as vscode from 'vscode';
import { BazelClient } from '../bazel/client';
import { ConfigurationService } from '../configuration';
import { discoverAndDisplayTests, resolveTestCaseChildren } from './testTree';
import { showTestMetadataById } from './testInfoPanel';
import { logWithTimestamp, formatError } from '../logging';
import { startTest, finishTest } from './testEventBus';
import { TestCaseAnnotations } from './testCaseAnnotations';
import { TestCaseInsights } from './testCaseInsights';

/**
 * Manages VS Code TestController and orchestrates test discovery,
 * run profiles, commands, and auto-reload.
 */
export class TestControllerManager {
  private controller: vscode.TestController;
  private debounceTimer?: NodeJS.Timeout;

  constructor(
    private readonly bazelClient: BazelClient,
    private readonly config: ConfigurationService,
    private readonly context: vscode.ExtensionContext,
    private readonly annotations: TestCaseAnnotations,
    private readonly insights: TestCaseInsights
  ) {
    this.controller = vscode.tests.createTestController(
      'bazelUnityTestController',
      'Bazel Unity Tests'
    );
    this.context.subscriptions.push(this.controller);
  }

  /**
   * Initialize commands, run profiles, and file watchers
   */
  initialize(): void {
    this.registerResolveHandler();
    this.registerCommands();
    this.registerRunProfile();
    this.registerFileWatcher();
    this.registerConfigListener();
  }

  /**
   * Register resolve handler for lazy-loading test cases
   */
  private registerResolveHandler(): void {
    this.controller.resolveHandler = async (item) => {
      if (!item) {
        // Root discovery - discover all test targets
        await this.discover();
        return;
      }

      // Individual test case discovery for a specific test item
      await resolveTestCaseChildren(item, this.controller, this.bazelClient, this.annotations, this.insights);
    };
  }

  /**
   * Discover tests with optional progress dialog
   */
  async discover(progress?: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
    try {
      this.annotations.clear();
      this.insights.clear();
      progress?.report({ message: 'Querying Bazel tests...' });
      await discoverAndDisplayTests(this.controller, this.bazelClient);
    } catch (error) {
      const message = formatError(error);
      vscode.window.showErrorMessage(`❌ Test discovery failed:\n${message}`);
      logWithTimestamp(`❌ Error in discover:\n${message}`);
      throw error;
    }
  }

  /**
   * Register commands (reload, showMetadata)
   */
  private registerCommands(): void {
    this.context.subscriptions.push(
      vscode.commands.registerCommand('extension.reloadBazelTests', async () => {
        logWithTimestamp('Reloading Bazel tests...');
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Window,
              title: 'Bazel Test Explorer',
              cancellable: false
            },
            async (progress) => {
              await this.discover(progress);
            }
          );
        } catch (error) {
          const message = formatError(error);
          vscode.window.showErrorMessage(`❌ Reload failed:\n${message}`);
          logWithTimestamp(`❌ Error in reloadBazelTests:\n${message}`);
        }
      }),

      vscode.commands.registerCommand('bazelTestExplorer.showSelectedTestMetadata', () => {
        vscode.window.showInformationMessage(
          "Automatic selection detection not implemented. Please right-click a test and use 'Show Metadata'."
        );
      }),

      vscode.commands.registerCommand('bazelTestExplorer.showTestMetadata', (testItem: vscode.TestItem) => {
        vscode.window.showInformationMessage(`Clicked on test: ${testItem?.id}`);
        showTestMetadataById(testItem?.id, this.bazelClient);
      })
    );
  }

  /**
   * Register run profiles for test execution
   */
  private registerRunProfile(): void {
    const runProfile = this.controller.createRunProfile(
      'Run Tests',
      vscode.TestRunProfileKind.Run,
      async (request, token) => {
        const run = this.controller.createTestRun(request);
        const sequentialTypes = this.config.sequentialTestTypes;

        const collectAllTests = (item: vscode.TestItem): vscode.TestItem[] => {
          const collected: vscode.TestItem[] = [];
          const visit = (node: vscode.TestItem) => {
            if (node.children.size === 0) {
              collected.push(node);
            } else {
              node.children.forEach(visit);
            }
          };
          visit(item);
          return collected;
        };

        const promises: Promise<void>[] = [];

        // If no tests are explicitly included, run all tests from controller
        const testsToRun = request.include && request.include.length > 0
          ? request.include
          : Array.from(this.controller.items).map(([_, item]) => item);

        try {
          for (const testItem of testsToRun) {
            const allTests = collectAllTests(testItem);
            for (const t of allTests) {
              // Check if cancellation was requested
              if (token.isCancellationRequested) {
                run.skipped(t);
                try { finishTest(t.id, 'skipped'); } catch { }
                logWithTimestamp(`Test skipped due to cancellation request: ${t.id}`, 'info');
                continue;
              }

              run.started(t);
              try { startTest(t.id, t.label); } catch { }
              const testTypeMatch = t.label.match(/^\[(.+?)\]/);
              const testType = testTypeMatch?.[1];
              const isSequential = sequentialTypes.includes(testType ?? '');
              const promise = this.bazelClient.runTest(t, run, token);
              if (isSequential) {
                await promise;
              } else {
                promises.push(promise);
              }
            }
          }
        } finally {
          try {
            await Promise.all(promises);
          } catch (err) {
            // Ensure failures in individual test promises do not prevent finalizing the run
            logWithTimestamp(`One or more test promises rejected: ${String(err)}`, 'error');
          } finally {
            run.end();
          }
        }
      },
      true
    );

    this.context.subscriptions.push(runProfile);
  }

  /**
   * Watch BUILD files (replaces window-focus reload)
   */
  private registerFileWatcher(): void {
    const watcher = vscode.workspace.createFileSystemWatcher(
      '**/{BUILD,BUILD.bazel,WORKSPACE,WORKSPACE.bazel,MODULE.bazel}'
    );

    const debouncedReload = () => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        // Invalidate cache on BUILD changes
        this.bazelClient.clearCache();
        logWithTimestamp('BUILD files changed, cache invalidated. Reloading tests...');
        vscode.commands.executeCommand('extension.reloadBazelTests');
      }, 2000);
    };

    watcher.onDidChange(debouncedReload);
    watcher.onDidCreate(debouncedReload);
    watcher.onDidDelete(debouncedReload);

    this.context.subscriptions.push(watcher);
  }

  /**
   * React to configuration changes
   */
  private registerConfigListener(): void {
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('bazelTestExplorer')) {
          logWithTimestamp('Configuration changed. Reloading tests...');
          vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Window,
              title: 'Bazel Test Explorer',
              cancellable: false
            },
            async (progress) => {
              await this.discover(progress);
            }
          );
        }
      })
    );
  }

  /**
   * Cleanup
   */
  dispose(): void {
    this.controller.dispose();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
  }

  /**
   * Run a set of tests identified by their TestItem ids.
   * Used by UI commands to re-run a test from history.
   */
  async runTestsByIds(ids: string[]): Promise<void> {
    const items = ids.map(id => this.findTestItemById(id)).filter(Boolean) as vscode.TestItem[];
    if (items.length === 0) {
      void vscode.window.showWarningMessage('No matching tests found to rerun.');
      return;
    }

    const run = this.controller.createTestRun({ include: items } as any);
    const sequentialTypes = this.config.sequentialTestTypes;

    const collectAllTests = (item: vscode.TestItem): vscode.TestItem[] => {
      const collected: vscode.TestItem[] = [];
      const visit = (node: vscode.TestItem) => {
        if (node.children.size === 0) collected.push(node);
        else node.children.forEach(visit);
      };
      visit(item);
      return collected;
    };

    const promises: Promise<void>[] = [];
    const token = new vscode.CancellationTokenSource().token;

    for (const testItem of items) {
      const allTests = collectAllTests(testItem);
      for (const t of allTests) {
        run.started(t);
        try { startTest(t.id, t.label); } catch { }
        const testTypeMatch = t.label.match(/^\[(.+?)\]/);
        const testType = testTypeMatch?.[1];
        const isSequential = sequentialTypes.includes(testType ?? '');
        const promise = this.bazelClient.runTest(t, run, token);
        if (isSequential) {
          await promise;
        } else {
          promises.push(promise);
        }
      }
    }

    try {
      await Promise.all(promises);
    } catch (err) {
      logWithTimestamp(`One or more test promises rejected in runTestsByIds: ${String(err)}`, 'error');
    } finally {
      run.end();
    }
  }

  /**
   * Find a TestItem by id recursively through the controller tree.
   */
  private findTestItemById(id: string): vscode.TestItem | undefined {
    for (const [, root] of this.controller.items) {
      const found = this.searchTestItem(root, id);
      if (found) return found;
    }
    return undefined;
  }

  private searchTestItem(node: vscode.TestItem, id: string): vscode.TestItem | undefined {
    if (node.id === id) return node;
    for (const [, child] of node.children) {
      const found = this.searchTestItem(child, id);
      if (found) return found;
    }
    return undefined;
  }
}
