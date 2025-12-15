/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import { BazelTestTarget } from './types';
import { logWithTimestamp } from '../logging';
import * as crypto from 'crypto';

/**
 * Gecachtes Query-Resultat
 */
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttlMs: number;
}

/**
 * Query-Cache mit TTL (Time-To-Live) für Bazel-Query-Resultate
 */
export class QueryCache {
  private cache = new Map<string, CacheEntry<BazelTestTarget[]>>();
  private readonly defaultTtlMs = 5 * 60 * 1000; // 5 Minuten

  /**
   * Holt einen Wert aus dem Cache, falls vorhanden und nicht abgelaufen
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
   * Speichert einen Wert im Cache
   */
  set(key: string, data: BazelTestTarget[], ttlMs?: number): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttlMs: ttlMs ?? this.defaultTtlMs
    });
    logWithTimestamp(`Cached ${data.length} test targets for key: ${key}`);
  }

  /**
   * Löscht einen spezifischen Cache-Eintrag
   */
  delete(key: string): boolean {
    const deleted = this.cache.delete(key);
    if (deleted) {
      logWithTimestamp(`Cache cleared for key: ${key}`);
    }
    return deleted;
  }

  /**
   * Löscht alle Cache-Einträge (optional: nur für bestimmtes Pattern)
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
   * Invalidiert abgelaufene Einträge
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
   * Gibt Cache-Statistiken zurück
   */
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys())
    };
  }

  /**
   * Erstellt einen Cache-Key aus Query-Parametern
   */
  static createKey(queryPaths: string[], testTypes: string[]): string {
    const sortedPaths = queryPaths.sort().join('|');
    const sortedTypes = testTypes.sort().join('|');
    const combined = `${sortedPaths}:${sortedTypes}`;
    return crypto.createHash('sha256').update(combined).digest('hex').slice(0, 16);
  }
}
