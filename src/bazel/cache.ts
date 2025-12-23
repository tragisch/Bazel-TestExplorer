/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/**
 * Query cache - TTL-based caching for Bazel query results to reduce repeated queries
 */

import { BazelTestTarget } from './types';
import { logWithTimestamp } from '../logging';
import * as crypto from 'crypto';

/**
 * cached query result
 */
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttlMs: number;
}

/**
 * query-cache with TTL (time-to-live) for Bazel query results
 */
export class QueryCache {
  private cache = new Map<string, CacheEntry<BazelTestTarget[]>>();
  private readonly defaultTtlMs = 5 * 60 * 1000; // 5 Minuten
  private readonly maxCacheSize = 1000; // Maximum cache entries
  private cleanupTimer?: NodeJS.Timeout;
  private readonly cleanupIntervalMs = 60 * 1000; // Cleanup every minute

  constructor() {
    this.startCleanupTimer();
  }

  /**
   * Starts automatic cleanup timer for expired entries
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.invalidateExpired();
      this.enforceSizeLimit();
    }, this.cleanupIntervalMs);
    // Allow Node.js to exit even if timer is active
    this.cleanupTimer.unref();
  }

  /**
   * Stops the cleanup timer (for proper disposal)
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.cache.clear();
  }

  /**
   * Enforces maximum cache size using LRU eviction
   */
  private enforceSizeLimit(): void {
    if (this.cache.size <= this.maxCacheSize) {
      return;
    }

    // Sort by timestamp (oldest first) and remove excess
    const entries = Array.from(this.cache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    
    const toRemove = entries.slice(0, this.cache.size - this.maxCacheSize);
    for (const [key] of toRemove) {
      this.cache.delete(key);
    }

    if (toRemove.length > 0) {
      logWithTimestamp(`Cache size limit enforced: removed ${toRemove.length} oldest entries`);
    }
  }

  /**
   * Retrieves a value from the cache if present and not expired
   */
  get(key: string): BazelTestTarget[] | null {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    const isExpired = Date.now() - entry.timestamp > entry.ttlMs;
    if (isExpired) {
      this.cache.delete(key);
      logWithTimestamp(`Cache expired for key: ${key}`);
      return null;
    }

    logWithTimestamp(`Cache hit for key: ${key} (${(Date.now() - entry.timestamp) / 1000}s old)`);
    return entry.data;
  }

  /**
   * Stores a value in the cache
   */
  set(key: string, data: BazelTestTarget[], ttlMs?: number): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttlMs: ttlMs ?? this.defaultTtlMs
    });
    logWithTimestamp(`Cached ${data.length} test targets for key: ${key}`);
    
    // Enforce size limit immediately if exceeded
    if (this.cache.size > this.maxCacheSize) {
      this.enforceSizeLimit();
    }
  }

  /**
   * Deletes a specific cache entry
   */
  delete(key: string): boolean {
    const deleted = this.cache.delete(key);
    if (deleted) {
      logWithTimestamp(`Cache cleared for key: ${key}`);
    }
    return deleted;
  }

  /**
   * Clears all cache entries (optionally only for a specific pattern)
   */
  clear(pattern?: string): void {
    if (!pattern) {
      const size = this.cache.size;
      this.cache.clear();
      logWithTimestamp(`Cache cleared (${size} entries removed)`);
      return;
    }

    let removed = 0;
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
        removed++;
      }
    }
    logWithTimestamp(`Cache cleared for pattern "${pattern}" (${removed} entries removed)`);
  }

  /**
   * Invalidates expired entries
   */
  invalidateExpired(): number {
    let count = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (Date.now() - entry.timestamp > entry.ttlMs) {
        this.cache.delete(key);
        count++;
      }
    }

    if (count > 0) {
      logWithTimestamp(`Invalidated ${count} expired cache entries`);
    }
    return count;
  }

  /**
   * Returns cache statistics
   */
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys())
    };
  }

  /**
   * Creates a cache key from query parameters
   */
  static createKey(queryPaths: string[], testTypes: string[]): string {
    const sortedPaths = queryPaths.sort().join('|');
    const sortedTypes = testTypes.sort().join('|');
    const combined = `${sortedPaths}:${sortedTypes}`;
    return crypto.createHash('sha256').update(combined).digest('hex').slice(0, 16);
  }
}
