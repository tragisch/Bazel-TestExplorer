

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { logWithTimestamp, measure, formatError } from '../logging';

export const spawnBazelTestProcess = (testId: string, cwd: string): Promise<{ code: number, stdout: string, stderr: string }> => {
  return new Promise((resolve, reject) => {
    const bazelProcess = cp.spawn('bazel', ['test', testId, '--test_output=all'], {
      cwd,
      shell: true
    });

    let stdout = '';
    let stderr = '';

    bazelProcess.stdout.on('data', data => {
      stdout += data.toString();
    });

    bazelProcess.stderr.on('data', data => {
      stderr += data.toString();
    });

    bazelProcess.on('close', code => {
      resolve({ code: code ?? 1, stdout, stderr });
    });

    bazelProcess.on('error', reject);
  });
};

export const parseBazelStdoutOutput = (stdout: string): { bazelLog: string[], testLog: string[] } => {
  const bazelLog: string[] = [];
  const testLog: string[] = [];

  stdout.split("\n").forEach(line => {
    if (line.startsWith("INFO:") || line.startsWith("WARNING:") || line.includes("Test execution time")) {
      bazelLog.push(line);
    } else {
      testLog.push(line);
    }
  });

  return { bazelLog, testLog };
};

const getStatusHeader = (code: number, testId: string): string => {
  const status = ({
    0: "✅ **Test Passed (Code 0)**",
    3: "❌ **Some Tests Failed (Code 3)**",
    4: "⚠️ **Flaky Test Passed (Code 4)**",
  })[code] ?? `🧨 **Build or Config Error (code ${code})**`;

  return `${status}: ${testId}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
};

const formatTestLog = (log: string[]): string =>
  log.length > 0 ? `📄 **Test Log:**\n${log.join("\n")}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` : "";

const formatBazelLog = (log: string[]): string =>
  log.length > 0 ? `📌 **Bazel Output:**\n${log.join("\n")}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` : "";

const formatStderr = (stderr: string): string =>
  `📕 **Bazel stderr:**\n${stderr.trim()}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

export const generateTestResultMessage = (
  testId: string,
  code: number,
  testLog: string[],
  bazelLog: string[],
  fullBazelOut?: string,
  fullStderr?: string
): string => {
  const header = getStatusHeader(code, testId);
  let output = header;

  if (testLog.length > 0) {
    output += formatTestLog(testLog);
  }

  if (code === 3 || code === 4) {
    output += formatBazelLog(bazelLog);
  }

  if (code === 1 || code > 4) {
    const bazelOutLines = fullBazelOut?.split('\n') ?? bazelLog;
    output += formatBazelLog(bazelOutLines);
    if (fullStderr?.trim()) {
      output += formatStderr(fullStderr);
    }
  }

  return output + "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";
};

export const executeBazelTest = async (
  testItem: vscode.TestItem,
  workspacePath: string,
  run: vscode.TestRun
) => {
  try {
    logWithTimestamp(`Running test: ${testItem.id}`);
    const { code, stdout, stderr } = await measure(`Execute test: ${testItem.id}`, () =>
      spawnBazelTestProcess(testItem.id, workspacePath)
    );
    const { bazelLog, testLog } = parseBazelStdoutOutput(stdout);
    const output = generateTestResultMessage(testItem.id, code, testLog, bazelLog, stdout, stderr);

    run.appendOutput(output.replace(/\r?\n/g, '\r\n') + "\r\n");

    if (code === 0) {
      run.passed(testItem);
    } else {
      const config = vscode.workspace.getConfiguration("bazelTestRunner");
      const customPatterns = config.get<string[]>("failLinePatterns", []);
      const failPatterns: { pattern: RegExp; source: string }[] = [
        ...customPatterns.map(p => {
          try {
            return { pattern: new RegExp(p), source: "Custom Setting" };
          } catch (e) {
            logWithTimestamp(`Invalid regex pattern in settings: "${p}"`, "warn");
            return null;
          }
        }).filter((p): p is { pattern: RegExp; source: string } => p !== null),
        { pattern: /^(.+?):(\d+): Failure/, source: "Built-in" },
        { pattern: /^(.+?):(\d+): FAILED/, source: "Built-in" },
        { pattern: /^(.+?)\((\d+)\): error/, source: "Built-in" },
        { pattern: /^(.+?):(\d+): error/, source: "Built-in" },
        { pattern: /^FAIL .*?\((.+?):(\d+)\)$/, source: "Built-in" },
        { pattern: /^Error: (.+?):(\d+): /, source: "Built-in" },
      ];

      const messages: vscode.TestMessage[] = [];
      const matchingLines = testLog.filter(line => failPatterns.some(({ pattern }) => pattern.test(line)));

      for (const line of matchingLines) {
        for (const { pattern, source } of failPatterns) {
          const match = line.match(pattern);
          if (match) {
            const [, file, lineStr] = match;
            const fullPath = path.isAbsolute(file)
              ? file
              : path.join(workspacePath, file);
            logWithTimestamp(`Pattern matched: [${source}] ${pattern}`);
            logWithTimestamp(`✔ Found & used: ${fullPath}:${lineStr}`);
            if (fs.existsSync(fullPath)) {
              const uri = vscode.Uri.file(fullPath);
              const location = new vscode.Location(uri, new vscode.Position(Number(lineStr) - 1, 0));
              const message = new vscode.TestMessage(line);
              message.location = location;
              messages.push(message);
              break;
            } else {
              logWithTimestamp(`File not found: ${fullPath}`);
            }
          }
        }
      }

      if (messages.length > 0) {
        run.failed(testItem, messages);
      } else {
        run.failed(testItem, new vscode.TestMessage(output));
      }
    }
  } catch (error) {
    const message = formatError(error);
    run.appendOutput(`Error executing test:\n${message}`.replace(/\r?\n/g, '\r\n') + "\r\n");
    run.failed(testItem, new vscode.TestMessage(message));
  }
};