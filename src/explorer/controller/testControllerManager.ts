/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

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
import { BazelClient } from '../../bazel/client';
import { ConfigurationService } from '../../configuration';
import { discoverAndDisplayTests, resolveTestCaseChildren } from '../tree';
import { showCombinedTestPanel } from '../panel';
import { logWithTimestamp, formatError } from '../../logging';
import { startTest, finishTest } from '../events';
import { TestCaseAnnotations } from '../annotations';
import { TestCaseInsights } from '../panel';

/**
 * Manages VS Code TestController and orchestrates test discovery,
 * run profiles, commands, and auto-reload.
 */
export class TestControllerManager {
  private controller: vscode.TestController;
  private coverageProfile?: vscode.TestRunProfile;
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
    this.registerCoverageProfile();
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

      // legacy metadata commands removed; use 'bazelTestExplorer.showTestDetails' instead
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
            // If this is a Bazel target (id has ':' but not '::'), run it as a unit
            const isTarget = node.id.includes(':') && !node.id.includes('::');
            if (isTarget) {
              collected.push(node);
              return; // do not expand to children; target run should be single Bazel invocation
            }

            if (node.children.size === 0) {
              collected.push(node);
              return;
            }

            node.children.forEach(visit);
          };
          visit(item);
          return collected;
        };

        const promises: Promise<void>[] = [];

        // If no tests are explicitly included, run all tests from controller
        const isGlobalRun = !request.include || request.include.length === 0;
        const testsToRun = isGlobalRun
          ? Array.from(this.controller.items).map(([_, item]) => item)
          : request.include;

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

              // Enforce Bazel 'manual' tag semantics: only run when explicitly named
              const metadata = this.bazelClient.getTargetMetadata(t.id);
              const isManual = metadata?.tags?.includes('manual');
              if (isGlobalRun && isManual) {
                run.skipped(t);
                try { finishTest(t.id, 'skipped'); } catch { }
                logWithTimestamp(`Skipping manual target on global run: ${t.id}`, 'info');
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

  private registerCoverageProfile(): void {
    this.coverageProfile = this.controller.createRunProfile(
      'Bazel Coverage',
      vscode.TestRunProfileKind.Coverage,
      async (request) => {
        const collectLeafTests = (item: vscode.TestItem): vscode.TestItem[] => {
          const collected: vscode.TestItem[] = [];
          const visit = (node: vscode.TestItem) => {
            if (node.children.size === 0) {
              collected.push(node);
              return;
            }
            node.children.forEach(visit);
          };
          visit(item);
          return collected;
        };

        const targets = request.include && request.include.length > 0
          ? request.include
          : await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Window,
                title: 'Collecting Bazel coverage targets...',
                cancellable: false
              },
              async () => {
                return Array.from(this.controller.items).flatMap(([, item]) => collectLeafTests(item));
              }
            );

        if (targets.length === 0) {
          void vscode.window.showInformationMessage('No test targets available for coverage.');
          return;
        }

        await vscode.commands.executeCommand('bazelTestExplorer.showCoverageDetails', targets);
      }
    );
    this.coverageProfile.isDefault = false;
  }

  publishCoverage(
    targetId: string,
    coverages: vscode.FileCoverage[],
    detailsProvider?: (coverage: vscode.FileCoverage) => vscode.FileCoverageDetail[],
    kind?: string,
    artifacts?: { lcov?: string[]; profraw?: string[]; profdata?: string[]; testlogs?: string[] },
    coverageArgs?: string[],
    generated?: boolean
  ): { kind?: string; covered: number; total: number; percent: number; files: { path: string; covered: number; total: number; percent: number }[]; artifacts?: { lcov?: string[]; profraw?: string[]; profdata?: string[]; testlogs?: string[] }; coverageArgs?: string[]; generated?: boolean } | undefined {
    const targetItem = this.findTestItemById(targetId);
    if (!targetItem) {
      return undefined;
    }

    if (detailsProvider && this.coverageProfile) {
      this.coverageProfile.loadDetailedCoverage = async (_, fileCoverage) => detailsProvider(fileCoverage);
    }

    const run = this.controller.createTestRun(
      new vscode.TestRunRequest([targetItem], undefined, this.coverageProfile),
      `Coverage: ${targetId}`,
      false
    );
    run.started(targetItem);
    for (const coverage of coverages) {
      run.addCoverage(coverage);
    }
    run.passed(targetItem);
    run.end();

    const summary = this.computeCoverageSummary(coverages, kind, artifacts, coverageArgs, generated);
    this.applyCoverageDescription(targetItem, summary);
    return summary;
  }

  private computeCoverageSummary(
    coverages: vscode.FileCoverage[],
    kind?: string,
    artifacts?: { lcov?: string[]; profraw?: string[]; profdata?: string[]; testlogs?: string[] },
    coverageArgs?: string[],
    generated?: boolean
  ): { kind?: string; covered: number; total: number; percent: number; files: { path: string; covered: number; total: number; percent: number }[]; artifacts?: { lcov?: string[]; profraw?: string[]; profdata?: string[]; testlogs?: string[] }; coverageArgs?: string[]; generated?: boolean } {
    let covered = 0;
    let total = 0;
    const files = coverages.map((coverage) => {
      const fileCovered = coverage.statementCoverage.covered;
      const fileTotal = coverage.statementCoverage.total;
      const percent = fileTotal === 0 ? 0 : (fileCovered / fileTotal) * 100;
      covered += fileCovered;
      total += fileTotal;
      return {
        path: coverage.uri.fsPath,
        covered: fileCovered,
        total: fileTotal,
        percent
      };
    });
    const percent = total === 0 ? 0 : (covered / total) * 100;
    const normalizedArtifacts = artifacts
      ? {
          lcov: artifacts.lcov?.filter(p => p !== '<llvm-cov export>'),
          profraw: artifacts.profraw,
          profdata: artifacts.profdata,
          testlogs: artifacts.testlogs
        }
      : undefined;
    return { kind, covered, total, percent, files, artifacts: normalizedArtifacts, coverageArgs, generated };
  }

  private applyCoverageDescription(
    item: vscode.TestItem,
    summary: { covered: number; total: number; percent: number }
  ): void {
    if (!this.config.showMetadataInLabel) {
      return;
    }
    const covText = `cov=${summary.percent.toFixed(1)}%`;
    const base = item.description ?? '';
    if (base.includes('cov=')) {
      item.description = base.replace(/cov=[^\\s]+/, covText);
      return;
    }
    item.description = base ? `${base} ${covText}` : covText;
  }

  private findTestItemById(targetId: string): vscode.TestItem | undefined {
    const visit = (item: vscode.TestItem): vscode.TestItem | undefined => {
      if (item.id === targetId) return item;
      for (const [, child] of item.children) {
        const found = visit(child);
        if (found) return found;
      }
      return undefined;
    };

    for (const [, item] of this.controller.items) {
      const found = visit(item);
      if (found) return found;
    }
    return undefined;
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
}
