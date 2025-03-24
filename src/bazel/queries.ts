

import * as vscode from 'vscode';
import { BazelTestTarget } from './types';
import * as cp from 'child_process';
import { logWithTimestamp } from '../logging';

const execShellCommand = async (command: string, cwd: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    cp.exec(command, { cwd, encoding: 'utf-8' }, (error, stdout, stderr) => {
      if (error) {
        reject(stderr || stdout);
      } else {
        resolve(stdout);
      }
    });
  });
};

export const queryBazelTestTargets = async (
  workspacePath: string
): Promise<BazelTestTarget[]> => {
  const config = vscode.workspace.getConfiguration("bazelTestRunner");
  const testTypes: string[] = config.get("testTypes", ["cc_test"]);
  const useKeepGoing = config.get<boolean>("useKeepGoing", false);
  const queryPaths: string[] = config.get("queryPaths", []);
  const sanitizedPaths = queryPaths.length > 0 ? queryPaths.filter(p => p.trim() !== "") : ["/"];

  let extractedTests: BazelTestTarget[] = [];

  for (const path of sanitizedPaths) {
    const query = testTypes.map(type => `kind(${type}, ${path}/...)`).join(" union ");
    const command = `bazel query "${query}" --output=streamed_jsonproto ${useKeepGoing ? "--keep_going" : ""}`;
    logWithTimestamp(`Executing Bazel query: ${command}`);

    let result: string;
    try {
      result = await execShellCommand(command, workspacePath);
    } catch (error) {
      logWithTimestamp(`No test targets found in path "${path}". Skipping.`);
      continue;
    }

    let parsed: any[] = [];
    try {
      parsed = result
        .trim()
        .split("\n")
        .map(line => JSON.parse(line));
    } catch (e) {
      logWithTimestamp("Failed to parse Bazel streamed_jsonproto output", "error");
      continue;
    }

    for (const target of parsed) {
      if (target.type !== "RULE" || !target.rule) continue;
      const rule = target.rule;
      const targetName = rule.name;
      const ruleClass = rule.ruleClass;
      const location = rule.location ?? undefined;
      const tags = rule.attribute?.find((a: any) => a.name === "tags")?.stringListValue?.value ?? [];

      extractedTests.push({
        target: targetName,
        type: ruleClass,
        location,
        tags,
        srcs: rule.attribute?.find((a: any) => a.name === "srcs")?.stringListValue ?? [],
        timeout: rule.attribute?.find((a: any) => a.name === "timeout")?.stringValue ?? undefined,
        size: rule.attribute?.find((a: any) => a.name === "size")?.stringValue ?? undefined,
        flaky: rule.attribute?.find((a: any) => a.name === "flaky")?.booleanValue ?? false,
        toolchain: rule.attribute?.find((a: any) => a.name === "$cc_toolchain")?.stringValue ?? undefined,
        compatiblePlatforms: rule.attribute?.find((a: any) => a.name === "target_compatible_with")?.stringListValue ?? [],
        visibility: rule.attribute?.find((a: any) => a.name === "visibility")?.stringListValue ?? []
      });
    }
  }

  logWithTimestamp(`Found ${extractedTests.length} test targets in Bazel workspace.`);
  return extractedTests;
};