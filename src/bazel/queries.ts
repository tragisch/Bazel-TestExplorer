import * as vscode from 'vscode';
import { BazelTestTarget } from './types';
import * as cp from 'child_process';
import { logWithTimestamp, measure } from '../logging';
import * as readline from 'readline';
import { showTestMetadataById } from '../explorer/testInfoPanel';

const execShellCommand = async (command: string, cwd: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    cp.exec(command, { cwd, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10, timeout: 25000 }, (error, stdout, stderr) => {
      if (error) {
        if (stdout) {
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
  const queries = sanitizedPaths.map(path => testTypes.map(type => `kind(${type}, ${path}...)`).join(" union "));

  for (const query of queries) {
    const bazelArgs = ['query', query, '--keep_going', '--output=streamed_jsonproto'];
    logWithTimestamp(`Executing Bazel query: bazel ${bazelArgs.join(" ")}`);

    await new Promise<void>((resolve, reject) => {
      const proc = cp.spawn('bazel', bazelArgs, { cwd: workspacePath });

      const rl = readline.createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        if (line.trim() === '') return;
        try {
          const target = JSON.parse(line);
          if (target.type !== "RULE" || !target.rule) return;
          const rule = target.rule;
          const targetName = rule.name;
          const tags = rule.attribute?.find((a: any) => a.name === "tags")?.stringListValue?.value ?? [];

          testMap.set(targetName, {
            target: targetName,
            type: rule.ruleClass,
            location: rule.location ?? undefined,
            tags,
            srcs: rule.attribute?.find((a: any) => a.name === "srcs")?.stringListValue ?? [],
            timeout: rule.attribute?.find((a: any) => a.name === "timeout")?.stringValue ?? undefined,
            size: rule.attribute?.find((a: any) => a.name === "size")?.stringValue ?? undefined,
            flaky: rule.attribute?.find((a: any) => a.name === "flaky")?.booleanValue ?? false,
            toolchain: rule.attribute?.find((a: any) => a.name === "$cc_toolchain")?.stringValue ?? undefined,
            compatiblePlatforms: rule.attribute?.find((a: any) => a.name === "target_compatible_with")?.stringListValue ?? [],
            visibility: rule.attribute?.find((a: any) => a.name === "visibility")?.stringListValue ?? []
          });
        } catch (e) {
          logWithTimestamp(`Failed to parse line: ${line.slice(0, 120)}...`, "warn");
        }
      });

      proc.on('exit', (code) => {
        if (code !== 0) {
          logWithTimestamp(`Bazel query exited with code ${code}`, "warn");
        }
        rl.close();
        resolve();
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  logWithTimestamp(`Found ${testMap.size} test targets in Bazel workspace.`);
  return Array.from(testMap.values());
};

export const getTestTargetById = (target: string): BazelTestTarget | undefined => {
  return testMap.get(target);
};