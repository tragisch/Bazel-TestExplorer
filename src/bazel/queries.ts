import * as vscode from 'vscode';
import { BazelTestTarget } from './types';
import * as cp from 'child_process';
import { logWithTimestamp, measure } from '../logging';
import { showTestMetadataById } from '../explorer/testInfoPanel';

const execShellCommand = async (command: string, cwd: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    cp.exec(command, { cwd, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10, timeout: 25000 }, (error, stdout, stderr) => {
      if (error) {
        if (stdout) {
          // logWithTimestamp(`Command completed with errors, but results are available:\n${stderr}`, "warn");
          logWithTimestamp('I am here\n');
          resolve(stdout);
        } else {

          logWithTimestamp(`Command failed with error: ${error.message}`, "error");
          reject(stderr || stdout);
        }
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
  const testTypes: string[] = config.get("testTypes", ["cc_test", "unity_test", "java_test"]);
  const queryPaths: string[] = config.get("queryPaths", []);
  const sanitizedPaths = queryPaths.length > 0 ? queryPaths.filter(p => p.trim() !== "") : ["//"];

  for (const path of sanitizedPaths) {
    const query = testTypes.map(type => `kind(${type}, ${path}...)`).join(" union ");
    const command = `bazel query "${query}" --keep_going --output=streamed_jsonproto`;
    logWithTimestamp(`Executing Bazel query: ${command}`);

    let result: string;
    try {
      result = await execShellCommand(command, workspacePath);
    } catch (error) {
      // logWithTimestamp(`Error executing Bazel query for path "${path}": ${ error } `, "error");
      continue;
    }

    let parsed: any[] = [];
    for (const line of result.trim().split("\n")) {
      if (line.trim() === "") continue;
      try {
        parsed.push(JSON.parse(line));
      } catch (e) {
        logWithTimestamp(`Failed to parse line: ${line.slice(0, 120)}...`, "warn");
      }
    }

    logWithTimestamp(`Parsed ${parsed.length} targets`);

    for (const target of parsed) {
      if (target.type !== "RULE" || !target.rule) { continue; }
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