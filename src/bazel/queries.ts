import * as vscode from 'vscode';
import { BazelTestTarget } from './types';
import * as cp from 'child_process';
import { logWithTimestamp, measure } from '../logging';
import * as readline from 'readline';

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

// const execShellCommand = async (command: string, cwd: string): Promise<string> => {
//   return new Promise((resolve, reject) => {
//     cp.exec(command, { cwd, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10, timeout: 25000 }, (error, stdout, stderr) => {
//       if (error) {
//         if (stdout) {
//           resolve(stdout);
//         } else {
//           logWithTimestamp(`Command failed with error: ${error.message}`, "error");
//           reject(stderr || stdout);
//         }
//       } else {
//         resolve(stdout);
//       }
//     });
//   });
// };

export const getTestTargetById = (target: string): BazelTestTarget | undefined => {
  return testMap.get(target);
};

function sanitizeQueryPaths(queryPaths: string[]): string[] {
  return queryPaths.length > 0 ? queryPaths.filter(p => p.trim() !== "") : ["//"];
}

function buildBazelQueries(paths: string[], testTypes: string[]): string[] {
  return paths.map(path =>
    testTypes.map(type => `kind(${type}, ${path}...)`).join(" union ")
  );
}

async function executeBazelQueries(queries: string[], workspacePath: string): Promise<void> {
  await Promise.all(
    queries.map(query => executeSingleBazelQuery(query, workspacePath))
  );
}

async function executeSingleBazelQuery(query: string, workspacePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const queryStart = Date.now();
    const bazelArgs = ['query', query, '--keep_going', '--output=streamed_jsonproto'];
    logWithTimestamp(`Executing Bazel query: bazel ${bazelArgs.join(" ")}`);

    const proc = cp.spawn('bazel', bazelArgs, { cwd: workspacePath });
    const rl = readline.createInterface({ input: proc.stdout });

    parseBazelLines(rl);

    proc.stderr.on('data', (data) => {
      // logWithTimestamp(`Bazel stderr: ${data.toString()}`, "warn");
    });

    proc.on('exit', (code) => {
      const duration = ((Date.now() - queryStart) / 1000).toFixed(2);
      logWithTimestamp(`Query completed in ${duration}s`);
      if (code !== 0) {
        logWithTimestamp(`Bazel query failed with exit code ${code}. This may indicate a malformed query or missing targets.`, "warn");
      }
      rl.close();
      resolve();
    });

    proc.on('error', (err) => {
      logWithTimestamp(`Bazel process error: ${err.message}`, "error");
      reject(err);
    });
  });
}

function parseBazelLines(rl: readline.Interface): void {
  let lineCount = 0;
  let failedParseCount = 0;

  rl.on('line', (line) => {
    lineCount++;
    if (lineCount % 1000 === 0) {
      logWithTimestamp(`Processed ${lineCount} lines...`);
    }
    if (line.trim() === '') {
      failedParseCount++;
      return;
    }

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
      failedParseCount++;
    }
  });

  rl.on('close', () => {
    if (failedParseCount > 0) {
      logWithTimestamp(`Failed to parse ${failedParseCount} lines.`, "warn");
    }
  });
}

function getAttribute(rule: any, name: string) {
  return rule.attribute?.find((a: any) => a.name === name);
}
