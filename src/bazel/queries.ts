/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import * as vscode from 'vscode';
import { BazelTestTarget } from './types';
import { logWithTimestamp, measure } from '../logging';
import { runBazelCommand } from './process';

const testMap: Map<string, BazelTestTarget> = new Map();

export const queryBazelTestTargets = async (
  workspacePath: string
): Promise<BazelTestTarget[]> => {
  logWithTimestamp(`Workspace path: ${workspacePath}`);

  const config = vscode.workspace.getConfiguration("bazelTestRunner");
  const testTypes: string[] = config.get("testTypes", ["cc_test", "unity_test", "java_test"]);
  const queryPaths: string[] = config.get("queryPaths", []);
  const sanitizedPaths = sanitizeQueryPaths(queryPaths);
  const queries = buildBazelQueries(sanitizedPaths, testTypes);

  await executeBazelQueries(queries, workspacePath);

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
  return paths.map(path =>
    `"${testTypes.map(type => `kind(${type}, ${path}...)`).join(" union ")}"`
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

  const { code, stdout } = await runBazelCommand(bazelArgs, workspacePath, line => {
    parseBazelLine(line);
  });

  const duration = ((Date.now() - queryStart) / 1000).toFixed(2);
  logWithTimestamp(`Query completed in ${duration}s`);
  if (code !== 0) {
    logWithTimestamp(`Bazel query failed with exit code ${code}.`, "warn");
    
  }
}

function parseBazelLine(line: string): void {
  if (line.trim() === '') return;

  try {
    const target = JSON.parse(line);
    if (target.type !== "RULE" || !target.rule) return;

    const rule = target.rule;
    const targetName = rule.name;
    const tags = getAttribute(rule, "tags")?.stringListValue?.value ?? [];

    testMap.set(targetName, {
      target: targetName,
      type: rule.ruleClass,
      location: rule.location ?? undefined,
      tags,
      srcs: getAttribute(rule, "srcs")?.stringListValue ?? [],
      timeout: getAttribute(rule, "timeout")?.stringValue ?? undefined,
      size: getAttribute(rule, "size")?.stringValue ?? undefined,
      flaky: getAttribute(rule, "flaky")?.booleanValue ?? false,
      toolchain: getAttribute(rule, "$cc_toolchain")?.stringValue ?? undefined,
      compatiblePlatforms: getAttribute(rule, "target_compatible_with")?.stringListValue ?? [],
      visibility: getAttribute(rule, "visibility")?.stringListValue ?? []
    });
  } catch (e) {
    logWithTimestamp(`Failed to parse Bazel line: ${line}`, "warn");
  }
}

function getAttribute(rule: any, name: string) {
  return rule.attribute?.find((a: any) => a.name === name);
}
