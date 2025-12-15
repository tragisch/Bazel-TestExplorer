/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import { BazelTestTarget } from './types';
import { logWithTimestamp, measure } from '../logging';
import { runBazelCommand } from './process';
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
  await Promise.all(
    queries.map(query => executeSingleBazelQuery(query, workspacePath, config))
  );
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
      visibility: getAttribute(rule, "visibility")?.stringListValue ?? []
    });
  } catch (e) {
    logWithTimestamp(`Failed to parse Bazel line: ${line}`, "warn");
  }
}

function getAttribute(rule: any, name: string) {
  return rule.attribute?.find((a: any) => a.name === name);
}
