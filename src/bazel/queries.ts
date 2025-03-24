

import * as vscode from 'vscode';
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
): Promise<{ target: string, type: string }[]> => {
  const config = vscode.workspace.getConfiguration("bazelTestRunner");
  const testTypes: string[] = config.get("testTypes", ["cc_test"]);
  const useKeepGoing = config.get<boolean>("useKeepGoing", false);
  const queryPaths: string[] = config.get("queryPaths", []);
  const sanitizedPaths = queryPaths.length > 0 ? queryPaths.filter(p => p.trim() !== "") : ["/"];

  let extractedTests: { target: string; type: string }[] = [];

  for (const path of sanitizedPaths) {
    const query = testTypes.map(type => `kind(${type}, ${path}/...)`).join(" union ");
    const command = `bazel query "${query}" --output=label_kind ${useKeepGoing ? "--keep_going" : ""}`;
    logWithTimestamp(`Executing Bazel query: ${command}`);

    let result: string;
    try {
      result = await execShellCommand(command, workspacePath);
    } catch (error) {
      logWithTimestamp(`No test targets found in path "${path}". Skipping.`);
      continue;
    }

    if (!result.trim()) {
      logWithTimestamp(`No test targets found in path: ${path}`);
      continue;
    }

    const lines = result.split("\n").map(line => line.trim());
    const tests = lines.map(line => {
      const match = line.match(/^(\S+) rule (\/\/.+)$/);
      return match ? { type: match[1], target: match[2] } : null;
    }).filter((entry): entry is { type: string; target: string } => entry !== null);

    extractedTests.push(...tests);
  }

  logWithTimestamp(`Found ${extractedTests.length} test targets in Bazel workspace.`);
  return extractedTests;
};