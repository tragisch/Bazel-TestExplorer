/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

// Bazel query: 

import * as vscode from 'vscode';
import { BazelTestTarget } from './types';
import { logWithTimestamp } from '../logging';
import { runBazelCommand } from './process';

const testMap: Map<string, BazelTestTarget> = new Map();

export const queryBazelTestTargets = async (
  workspacePath: string
): Promise<BazelTestTarget[]> => {
  logWithTimestamp(`Workspace path: ${workspacePath}`);

  // Reset cache for a fresh discovery pass
  testMap.clear();

  const config = vscode.workspace.getConfiguration("bazelTestRunner");
  const testTypes: string[] = config.get("testTypes", ["cc_test", "unity_test", "rust_test"]);
  const queryPaths: string[] = config.get("queryPaths", []);
  const queries = buildBazelQueries(queryPaths, testTypes);

  await executeBazelQueries(queries, workspacePath);

  logWithTimestamp(`Found ${testMap.size} test targets in Bazel workspace.`);
  return Array.from(testMap.values());
};

export const getTestTargetById = (target: string): BazelTestTarget | undefined => {
  return testMap.get(target);
};

function buildBazelQueries(queryPaths: string[], testTypes: string[]): string[] {
  // clean query paths, default to ["//"] if empty or only whitespace
  const paths = queryPaths.length > 0 ? queryPaths.filter(p => p.trim() !== "") : ["//"];
  const allTypes = [...new Set([...testTypes, "test_suite"])];
  return paths.map(path =>
    `"${allTypes.map(type => `kind(${type}, ${path}...)`).join(" union ")}"`
  );
}

async function executeBazelQueries(queries: string[], workspacePath: string): Promise<void> {
  await Promise.all(
    queries.map(query => executeSingleBazelQuery(query, workspacePath))
  );
}

async function executeSingleBazelQuery(query: string, workspacePath: string): Promise<void> {
  const queryStart = Date.now();
  const bazelArgs = ['query', query, '--keep_going', '--output=streamed_jsonproto'];
  const prettyQuery = truncateMiddle(query, 160);
  logWithTimestamp(`Query start: ${prettyQuery}`);

  let matchCount = 0;
  const { code } = await runBazelCommand(bazelArgs, workspacePath, {
    onLine: (line) => { if (parseBazelLine(line)) matchCount++; },
    collectStdout: false,
    collectStderr: false,
    logCommand: false,
  });

  const duration = ((Date.now() - queryStart) / 1000).toFixed(2);
  logWithTimestamp(`Query completed in ${duration}s (${matchCount} matches)`);
  if (code !== 0) {
    logWithTimestamp(`Bazel query failed with exit code ${code}. (${matchCount} matches parsed)`, "warn");

  }
}

function parseBazelLine(line: string): boolean {
  if (line.trim() === '') return false;

  try {
    const target = JSON.parse(line);
    if (target.type !== "RULE" || !target.rule) return false;

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
    return true;
  } catch (e) {
    logWithTimestamp(`Failed to parse Bazel line: ${line}`, "warn");
    return false;
  }
}

function getAttribute(rule: any, name: string) {
  return rule.attribute?.find((a: any) => a.name === name);
}

// Truncate long strings in the middle to keep logs readable
function truncateMiddle(input: string, max = 120): string {
  if (input.length <= max) return input;
  const keep = Math.max(10, Math.floor((max - 3) / 2));
  return input.slice(0, keep) + '...' + input.slice(input.length - keep);
}
