/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/**
 * Bazel queries - constructs and executes Bazel query commands to discover test targets
 */

import { BazelTestTarget } from './types';
import { logWithTimestamp, measure } from '../logging';
import { runBazelCommand } from '../infrastructure/process';
import { ConfigurationService } from '../configuration';

const testMap: Map<string, BazelTestTarget> = new Map();

export const queryBazelTestTargets = async (
  workspacePath: string,
  config: ConfigurationService
): Promise<BazelTestTarget[]> => {
  logWithTimestamp(`Workspace path: ${workspacePath}`);

  // Clear testMap before querying to remove deleted/renamed targets
  testMap.clear();

  const testTypes: string[] = config.testTypes;
  const queryPaths: string[] = config.queryPaths;
  const sanitizedPaths = sanitizeQueryPaths(queryPaths);
  const queries = buildBazelQueries(sanitizedPaths, testTypes);

  await executeBazelQueries(queries, workspacePath, config);

  logWithTimestamp(`Found ${testMap.size} test targets in Bazel workspace.`);
  return Array.from(testMap.values());
};

/**
 * Phase 1 of two-phase discovery: Fast label-only query.
 * Returns just the test labels without metadata.
 * 
 * @param workspacePath Workspace root
 * @param config Configuration service
 * @returns Array of test target labels
 */
export const queryBazelTestLabelsOnly = async (
  workspacePath: string,
  config: ConfigurationService
): Promise<string[]> => {
  logWithTimestamp(`Two-phase discovery: Phase 1 (labels only)`);
  
  const testTypes: string[] = config.testTypes;
  const queryPaths: string[] = config.queryPaths;
  const sanitizedPaths = sanitizeQueryPaths(queryPaths);
  const allTypes = [...new Set([...testTypes, "test_suite"])];
  
  const labels: string[] = [];
  
  for (const path of sanitizedPaths) {
    const query = `"${allTypes.map(type => `kind(${type}, ${path}...)`).join(" union ")}"`;
    const bazelArgs = ['query', query, '--keep_going', '--output=label'];
    
    const { stdout } = await runBazelCommand(
      bazelArgs, 
      workspacePath, 
      undefined, 
      undefined, 
      config.bazelPath
    );
    
    labels.push(...stdout.split('\n').filter(l => l.trim() !== ''));
  }
  
  logWithTimestamp(`Phase 1 complete: Found ${labels.length} test labels`);
  return labels;
};

/**
 * Phase 2 of two-phase discovery: Chunked metadata query for specific labels.
 * Queries metadata for a list of labels in parallel chunks.
 * 
 * @param labels Array of test labels
 * @param workspacePath Workspace root
 * @param config Configuration service
 * @returns Array of BazelTestTarget with metadata
 */
export const queryBazelTestMetadata = async (
  labels: string[],
  workspacePath: string,
  config: ConfigurationService
): Promise<BazelTestTarget[]> => {
  logWithTimestamp(`Two-phase discovery: Phase 2 (metadata for ${labels.length} labels)`);
  
  if (labels.length === 0) {
    return [];
  }
  
  testMap.clear();
  
  const rawChunkSize = (config as any).metadataChunkSize;
  const chunkSize = typeof rawChunkSize === 'number' && rawChunkSize >= 1
    ? Math.min(2000, Math.max(50, Math.floor(rawChunkSize)))
    : 500;
  const chunks: string[][] = [];
  
  for (let i = 0; i < labels.length; i += chunkSize) {
    chunks.push(labels.slice(i, i + chunkSize));
  }
  
  logWithTimestamp(`Processing ${chunks.length} chunks (size=${chunkSize})`);
  
  // Process chunks with parallelism limit
  const rawLimit = (config as any).maxParallelQueries;
  const limit = typeof rawLimit === 'number' && rawLimit >= 1
    ? Math.min(64, Math.floor(rawLimit))
    : 4;
  let chunkIndex = 0;
  const workers: Promise<void>[] = [];
  
  for (let i = 0; i < limit; i++) {
    workers.push((async () => {
      while (chunkIndex < chunks.length) {
        const myIndex = chunkIndex++;
        const chunk = chunks[myIndex];
        await queryMetadataChunk(chunk, workspacePath, config);
      }
    })());
  }
  
  await Promise.all(workers);
  
  logWithTimestamp(`Phase 2 complete: Retrieved metadata for ${testMap.size} targets`);
  return Array.from(testMap.values());
};

async function queryMetadataChunk(
  labels: string[],
  workspacePath: string,
  config: ConfigurationService
): Promise<void> {
  const query = `"${labels.join(' union ')}"`;
  const bazelArgs = ['query', query, '--keep_going', '--output=streamed_jsonproto'];
  
  await runBazelCommand(bazelArgs, workspacePath, line => {
    parseBazelLine(line);
  }, undefined, config.bazelPath);
  
  logWithTimestamp(`Chunk complete: ${labels.length} labels processed`);
}

export const getTestTargetById = (target: string): BazelTestTarget | undefined => {
  return testMap.get(target);
};

function sanitizeQueryPaths(queryPaths: string[]): string[] {
  return queryPaths.length > 0 ? queryPaths.filter(p => p.trim() !== "") : ["//"];
}

function buildBazelQueries(paths: string[], testTypes: string[]): string[] {
  const allTypes = [...new Set([...testTypes, "test_suite"])];
  return paths.map(path =>
    `"${allTypes.map(type => `kind(${type}, ${path}...)`).join(" union ")}"`
  );
}

async function executeBazelQueries(queries: string[], workspacePath: string, config: ConfigurationService): Promise<void> {
  // Use configured limit when available; fall back to 4 for mocks
  const rawLimit = (config as any).maxParallelQueries;
  const limit = typeof rawLimit === 'number' && rawLimit >= 1 ? Math.min(64, Math.floor(rawLimit)) : 4;
  // Simple concurrency pool without external deps
  let index = 0;
  const workers: Promise<void>[] = [];
  for (let i = 0; i < limit; i++) {
    workers.push((async () => {
      while (index < queries.length) {
        const myIndex = index++;
        const q = queries[myIndex];
        await executeSingleBazelQuery(q, workspacePath, config);
      }
    })());
  }
  await Promise.all(workers);
}

async function executeSingleBazelQuery(query: string, workspacePath: string, config: ConfigurationService): Promise<void> {
  const queryStart = Date.now();
  const bazelArgs = ['query', query, '--keep_going', '--output=streamed_jsonproto'];

  const { code, stdout } = await runBazelCommand(bazelArgs, workspacePath, line => {
    parseBazelLine(line);
  }, undefined, config.bazelPath);

  const duration = ((Date.now() - queryStart) / 1000).toFixed(2);
  logWithTimestamp(`Query completed in ${duration}s`);
  if (code !== 0) {
    logWithTimestamp(`Bazel query failed with exit code ${code}. Please try running the query manually for more details.`, "warn");

  }
}

function parseBazelLine(line: string): void {
  if (line.trim() === '') return;

  try {
    const target = JSON.parse(line);
    if (target.type !== "RULE" || !target.rule) return;

    const rule = target.rule;
    const targetName = rule.name;

    testMap.set(targetName, {
      target: targetName,
      type: rule.ruleClass,
      location: rule.location ?? undefined,
      tags: getAttribute(rule, "tags")?.stringListValue ?? [],
      srcs: getAttribute(rule, "srcs")?.stringListValue ?? [],
      timeout: getAttribute(rule, "timeout")?.stringValue ?? undefined,
      size: getAttribute(rule, "size")?.stringValue ?? undefined,
      flaky: getAttribute(rule, "flaky")?.booleanValue ?? false,
      toolchain: getAttribute(rule, "$cc_toolchain")?.stringValue ?? undefined,
      deps: getAttribute(rule, "deps")?.stringListValue ?? [],
      tests: getAttribute(rule, "tests")?.stringListValue ?? [],
      visibility: getAttribute(rule, "visibility")?.stringListValue ?? [],
      shard_count: getAttribute(rule, "shard_count")?.intValue
    });
  } catch (e) {
    logWithTimestamp(`Failed to parse Bazel line: ${line}`, "warn");
  }
}

function getAttribute(rule: any, name: string) {
  return rule.attribute?.find((a: any) => a.name === name);
}

/**
 * Expand test_suite to get actual test targets.
 * 
 * @param suiteLabel test_suite label (e.g. //pkg:suite)
 * @param workspacePath Workspace root
 * @param config Configuration service
 * @returns Array of test target labels in the suite
 */
export const expandTestSuite = async (
  suiteLabel: string,
  workspacePath: string,
  config: ConfigurationService
): Promise<string[]> => {
  logWithTimestamp(`Expanding test_suite: ${suiteLabel}`);
  
  const query = `tests(${suiteLabel})`;
  const { stdout } = await runBazelCommand(
    ['query', query, '--output=label'],
    workspacePath, undefined, undefined, config.bazelPath
  );
  
  const tests = stdout.split('\n').filter(l => l.trim() !== '');
  logWithTimestamp(`Suite ${suiteLabel} contains ${tests.length} tests`);
  return tests;
};
