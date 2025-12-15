/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import { TestRun, CancellationToken } from 'vscode';
import { BazelTestTarget } from './types';
import { queryBazelTestTargets, getTestTargetById } from './queries';
import { executeBazelTest } from './runner';
import { runBazelCommand } from './process';

/**
 * Zentrale Fassade für alle Bazel-Operationen.
 * Kapselt queries.ts, runner.ts und process.ts.
 */
export class BazelClient {
  constructor(
    private readonly workspaceRoot: string,
    private readonly bazelPath: string = 'bazel'
  ) {}

  /**
   * Query alle Test-Targets mit Pattern
   * @param workspacePath Bazel workspace path
   */
  async queryTests(workspacePath: string): Promise<BazelTestTarget[]> {
    return queryBazelTestTargets(workspacePath);
  }

  /**
   * Führt einen einzelnen Test aus
   * @param testItem VS Code TestItem
   * @param workspacePath Bazel workspace path
   * @param run VS Code TestRun für Status-Updates
   */
  async runTest(
    testItem: any,
    workspacePath: string,
    run: TestRun
  ): Promise<void> {
    return executeBazelTest(testItem, workspacePath, run);
  }

  /**
   * Holt Metadata für ein Target
   * @param targetId Target ID/Label
   */
  getTargetMetadata(targetId: string): BazelTestTarget | undefined {
    return getTestTargetById(targetId);
  }

  /**
   * Validiert Bazel-Installation
   */
  async validate(): Promise<{ valid: boolean; version?: string; error?: string }> {
    try {
      let version = '';
      
      const { code } = await runBazelCommand(
        ['version'],
        this.workspaceRoot,
        (line) => { 
          if (line.startsWith('Build label:')) {
            version = line;
          }
        }
      );
      
      if (code === 0) {
        return { valid: true, version };
      } else {
        return { valid: false, error: `Bazel exited with code ${code}` };
      }
    } catch (error) {
      return { 
        valid: false, 
        error: error instanceof Error ? error.message : String(error) 
      };
    }
  }

  /**
   * Getter für Workspace-Root
   */
  get workspace(): string {
    return this.workspaceRoot;
  }

  /**
   * Getter für Bazel-Pfad
   */
  get bazel(): string {
    return this.bazelPath;
  }
}
