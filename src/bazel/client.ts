/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/**
 * Bazel client facade - unified interface for Bazel operations with caching and error handling
 */

import { TestRun, CancellationToken } from 'vscode';
import { BazelTestTarget } from './types';
import { queryBazelTestTargets, queryBazelTestLabelsOnly, queryBazelTestMetadata, getTestTargetById } from './queries';
import { executeBazelTest } from './runner';
import { runBazelCommand } from './process';
import { ConfigurationService } from '../configuration';
import { QueryCache } from './cache';
import { ErrorHandler } from '../errors/errorHandler';
import { logWithTimestamp } from '../logging';

/**
 * Zentrale Fassade für alle Bazel-Operationen.
 * Kapselt queries.ts, runner.ts und process.ts mit Caching und Error-Handling.
 */
export class BazelClient {
  private cache: QueryCache;
  private errorHandler: ErrorHandler;

  constructor(
    private readonly workspaceRoot: string,
    private readonly config: ConfigurationService
  ) {
    this.cache = new QueryCache();
    this.errorHandler = new ErrorHandler();
  }

  /**
   * Query alle Test-Targets mit Pattern (Cache-aware)
   */
  async queryTests(): Promise<BazelTestTarget[]> {
    try {
      const useTwoPhase = this.config.twoPhaseDiscovery;
      
      // Create cache key based on config
      const cacheKey = QueryCache.createKey(
        this.config.queryPaths,
        this.config.testTypes
      );

      // Get from cache if available
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return cached;
      }

      let targets: BazelTestTarget[];
      
      if (useTwoPhase) {
        logWithTimestamp('Using two-phase discovery');
        // Phase 1: Fast label query
        const labels = await queryBazelTestLabelsOnly(this.workspaceRoot, this.config);
        // Phase 2: Chunked metadata query
        targets = await queryBazelTestMetadata(labels, this.workspaceRoot, this.config);
      } else {
        logWithTimestamp('Using single-phase discovery');
        // Original single-phase query
        targets = await queryBazelTestTargets(this.workspaceRoot, this.config);
      }
      
      // Im Cache speichern
      this.cache.set(cacheKey, targets);
      
      return targets;
    } catch (error) {
      const result = this.errorHandler.handle(error, 'query');
      this.errorHandler.logError(result, 'QueryTests');
      throw new Error(result.userMessage);
    }
  }

  /**
   * Execute a single test with error handling and cancellation support
   */
  async runTest(
    testItem: any,
    run: TestRun,
    token?: CancellationToken
  ): Promise<void> {
    try {
      return await executeBazelTest(testItem, this.workspaceRoot, run, this.config, token);
    } catch (error) {
      const result = this.errorHandler.handle(error, 'run');
      this.errorHandler.logError(result, 'RunTest');
      throw new Error(result.userMessage);
    }
  }

  /**
   * Holt Metadata für ein Target
   * @param targetId Target ID/Label
   */
  getTargetMetadata(targetId: string): BazelTestTarget | undefined {
    return getTestTargetById(targetId);
  }

  /**
   * Validiert Bazel-Installation mit Error-Handling
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
        },
        undefined,
        this.config.bazelPath
      );
      
      if (code === 0) {
        return { valid: true, version };
      } else {
        return { valid: false, error: `Bazel exited with code ${code}` };
      }
    } catch (error) {
      const result = this.errorHandler.handle(error, 'validation');
      this.errorHandler.logError(result, 'Validate');
      return { 
        valid: false, 
        error: result.userMessage
      };
    }
  }

  /**
   * Löscht den Query-Cache (z.B. bei BUILD-Datei-Änderungen)
   */
  clearCache(pattern?: string): void {
    this.cache.clear(pattern);
    logWithTimestamp(`BazelClient cache cleared ${pattern ? `for pattern: ${pattern}` : ''}`);
  }

  /**
   * Gibt Cache-Statistiken zurück
   */
  getCacheStats(): { size: number; keys: string[] } {
    return this.cache.getStats();
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
    return this.config.bazelPath;
  }
}
