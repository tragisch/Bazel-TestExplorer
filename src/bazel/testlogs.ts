/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/**
 * Utilities for locating Bazel test log directories and files
 */

import * as fs from 'fs';
import * as path from 'path';
import { logWithTimestamp, formatError } from '../logging';
import { runBazelCommand } from './process';

const testLogsCache = new Map<string, string>();

const cacheKey = (workspacePath: string, bazelPath: string): string =>
  `${workspacePath}::${bazelPath || 'bazel'}`;

export async function getBazelTestLogsDirectory(
  workspacePath: string,
  bazelPath: string = 'bazel'
): Promise<string | undefined> {
  const key = cacheKey(workspacePath, bazelPath);
  const cached = testLogsCache.get(key);
  if (cached) {
    return cached;
  }

  try {
    const { code, stdout, stderr } = await runBazelCommand(
      ['info', 'bazel-testlogs'],
      workspacePath,
      undefined,
      undefined,
      bazelPath
    );

    // New completion log line
    logWithTimestamp(`Finished running Bazel: bazel info bazel-testlogs (code ${code})`, 'info');

    if (code !== 0) {
      logWithTimestamp(`Failed to locate bazel-testlogs (${code}): ${stderr.trim()}`, 'warn');
      return undefined;
    }

    const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const logsDir = lines[lines.length - 1];
    if (!logsDir) {
      logWithTimestamp('bazel info bazel-testlogs returned no output', 'warn');
      return undefined;
    }

    testLogsCache.set(key, logsDir);
    return logsDir;
  } catch (error) {
    logWithTimestamp(`Error running "bazel info bazel-testlogs": ${formatError(error)}`, 'error');
    return undefined;
  }
}

export function buildTestXmlPath(targetLabel: string, logsDirectory: string): string {
  const normalized = targetLabel
    .replace(/^\/\//, '')
    .replace(/^:/, '')
    .replace(/:/g, path.sep);
  return path.join(logsDirectory, normalized, 'test.xml');
}

export function clearTestLogsCache(): void {
  testLogsCache.clear();
}

export function hasTestXmlFile(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}
