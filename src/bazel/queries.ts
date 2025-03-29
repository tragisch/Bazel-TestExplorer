import * as vscode from 'vscode';
import { BazelTestTarget } from './types';
import * as cp from 'child_process';
import { logWithTimestamp, logMemoryUsage, measure } from '../logging';
import { showTestMetadataById } from '../explorer/testInfoPanel';

const execShellCommand = async (command: string, cwd: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    cp.exec(command, { cwd, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10, timeout: 6000 }, (error, stdout, stderr) => {
      if (error) {
        reject(stderr || stdout);
      } else {
        resolve(stdout);
      }
    });
  });
};

const testMap: Map<string, BazelTestTarget> = new Map();

export const queryBazelTestTargets = async (
  workspacePath: string
): Promise<BazelTestTarget[]> => {
  const config = vscode.workspace.getConfiguration("bazelTestRunner");
  const testTypes: string[] = config.get("testTypes", ["cc_test"]);
  const useKeepGoing = config.get<boolean>("useKeepGoing", false);
  const queryPaths: string[] = config.get("queryPaths", []);
  const sanitizedPaths = queryPaths.length > 0 ? queryPaths.filter(p => p.trim() !== "") : ["/"];

  const query = testTypes.map(type => `kind(${type}, //...)`).join(" union ");

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

    logWithTimestamp(`Parsed ${parsed.length} targets`);
    logMemoryUsage();

    for (const target of parsed) {
      if (target.type !== "RULE" || !target.rule) continue;
      const rule = target.rule;
      const targetName = rule.name;
      const ruleClass = rule.ruleClass;
      const location = rule.location ?? undefined;
      const tags = rule.attribute?.find((a: any) => a.name === "tags")?.stringListValue?.value ?? [];

      testMap.set(targetName, {
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

  logWithTimestamp(`Found ${testMap.size} test targets in Bazel workspace.`);
  return Array.from(testMap.values());
};

export const getTestTargetById = (target: string): BazelTestTarget | undefined => {
  return testMap.get(target);
};