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
 * Central facade for all Bazel operations.
 * Encapsulates queries.ts, runner.ts, and process.ts with caching and error handling.
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
   * Queries all test targets with pattern (cache-aware)
   */
  async queryTests(): Promise<BazelTestTarget[]> {
    try {
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

      // Always use two-phase discovery: Phase 1 (labels), Phase 2 (chunked metadata)
      logWithTimestamp('Using two-phase discovery');
      const labels = await queryBazelTestLabelsOnly(this.workspaceRoot, this.config);
      const targets = await queryBazelTestMetadata(labels, this.workspaceRoot, this.config);
      
      // Store in cache
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
   * Retrieves metadata for a target
   * @param targetId Target ID/Label
   */
  getTargetMetadata(targetId: string): BazelTestTarget | undefined {
    return getTestTargetById(targetId);
  }

  /**
   * Validates Bazel installation with error handling
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
   * Clears the query cache (e.g., on BUILD file changes)
   */
  clearCache(pattern?: string): void {
    this.cache.clear(pattern);
    logWithTimestamp(`BazelClient cache cleared ${pattern ? `for pattern: ${pattern}` : ''}`);
  }

  /**
   * Returns cache statistics
   */
  getCacheStats(): { size: number; keys: string[] } {
    return this.cache.getStats();
  }

  /**
   * Getter for workspace root
   */
  get workspace(): string {
    return this.workspaceRoot;
  }

  /**
   * Getter for Bazel path
   */
  get bazel(): string {
    return this.config.bazelPath;
  }
}
