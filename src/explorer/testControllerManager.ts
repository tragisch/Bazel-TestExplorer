/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import * as vscode from 'vscode';
import { BazelClient } from '../bazel/client';
import { ConfigurationService } from '../configuration';
import { discoverAndDisplayTests } from './testTree';
import { showTestMetadataById } from './testInfoPanel';
import { logWithTimestamp, formatError } from '../logging';

/**
 * Verwaltet den VS Code TestController und orchestriert Test-Discovery,
 * Run-Profile, Commands und Auto-Reload.
 */
export class TestControllerManager {
  private controller: vscode.TestController;
  private debounceTimer?: NodeJS.Timeout;

  constructor(
    private readonly bazelClient: BazelClient,
    private readonly config: ConfigurationService,
    private readonly context: vscode.ExtensionContext
  ) {
    this.controller = vscode.tests.createTestController(
      'bazelUnityTestController',
      'Bazel Unity Tests'
    );
    this.context.subscriptions.push(this.controller);
  }

  /**
   * Initialisiert Commands, RunProfile und FileWatcher
   */
  initialize(): void {
    this.registerCommands();
    this.registerRunProfile();
    this.registerFileWatcher();
    this.registerConfigListener();
  }

  /**
   * Test-Discovery mit optionalem Progress-Dialog
   */
  async discover(progress?: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
    try {
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
   * Commands registrieren (reload, showMetadata)
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
   * Run-Profile für Test-Execution
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

        for (const testItem of request.include ?? []) {
          const allTests = collectAllTests(testItem);
          for (const t of allTests) {
            run.started(t);
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

        await Promise.all(promises);
        run.end();
      },
      true
    );

    this.context.subscriptions.push(runProfile);
  }

  /**
   * FileSystemWatcher für BUILD-Dateien (ersetzt Window-Focus-Reload)
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
        logWithTimestamp('BUILD files changed, reloading tests...');
        vscode.commands.executeCommand('extension.reloadBazelTests');
      }, 2000);
    };

    watcher.onDidChange(debouncedReload);
    watcher.onDidCreate(debouncedReload);
    watcher.onDidDelete(debouncedReload);

    this.context.subscriptions.push(watcher);
  }

  /**
   * Reagiert auf Config-Änderungen
   */
  private registerConfigListener(): void {
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('bazelTestRunner')) {
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
}
