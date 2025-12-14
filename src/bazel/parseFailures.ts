/*
 * Copyright (c) 2025 @tragisch
 * SPDX-License-Identifier: MIT
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { logWithTimestamp } from '../logging';

export function analyzeTestFailures(
  testLog: string[],
  workspacePath: string,
  testItem: vscode.TestItem
): vscode.TestMessage[] {
  const config = vscode.workspace.getConfiguration('bazelTestRunner');
  const customPatterns = config.get<string[]>('failLinePatterns', []);
  const failPatterns: { pattern: RegExp; source: string }[] = [
    ...customPatterns
      .map(p => {
        try {
          return { pattern: new RegExp(p), source: 'Custom Setting' };
        } catch (e) {
          logWithTimestamp(`Invalid regex pattern in settings: "${p}"`, 'warn');
          return null as any;
        }
      })
      .filter((p): p is { pattern: RegExp; source: string } => p !== null),
    { pattern: /^(.+?):(\d+): Failure/, source: 'Built-in' },
    { pattern: /^(.+?):(\d+): FAILED/, source: 'Built-in' },
    { pattern: /^(.+?):(\d+):\d+: error/, source: 'Built-in' },
    { pattern: /^(.+?)\((\d+)\): error/, source: 'Built-in' },
    { pattern: /^(.+?):(\d+): error/, source: 'Built-in' },
    { pattern: /^FAIL .*?\((.+?):(\d+)\)$/, source: 'Built-in' },
    { pattern: /^(.+?):(\d+):.+?:FAIL:/, source: 'Built-in' },
    { pattern: /^Error: (.+?):(\d+): /, source: 'Built-in' },
    { pattern: /^\s*File "(.*?)", line (\d+), in .+$/, source: 'Python Traceback' },
    { pattern: /^(.+?):(\d+): AssertionError$/, source: 'Python AssertionError' },
    { pattern: /^\[----\] (.+?):(\d+): Assertion Failed$/, source: 'Built-in' },
    { pattern: /^.*panicked at .*?([^\s:]+):(\d+):\d+:$/, source: 'Rust panic' },
    { pattern: /^(.*):(\d+):\s+ERROR:\s+(REQUIRE|CHECK|CHECK_EQ)\(\s*(.*?)\s*\)\s+is\s+NOT\s+correct!/, source: 'Built-in' },
    { pattern: /^Assertion failed: .*?, function .*?, file (.+?), line (\d+)\./, source: 'Built-in' },
  ];

  const messages: vscode.TestMessage[] = [];
  const matchingLines = testLog.filter(line => failPatterns.some(({ pattern }) => pattern.test(line)));

  for (const line of matchingLines) {
    let bestMatch: {
      match: RegExpMatchArray;
      pattern: RegExp;
      source: string;
    } | null = null;
    for (const { pattern, source } of failPatterns) {
      const match = line.match(pattern);
      if (match) {
        if (!bestMatch || match[0].length > bestMatch.match[0].length) {
          bestMatch = { match, pattern, source };
        }
      }
    }
    if (bestMatch) {
      const [, file, lineStr] = bestMatch.match;
      const normalizedPath = path.normalize(file);
      const trimmedPath = normalizedPath.includes(`${path.sep}_main${path.sep}`)
        ? normalizedPath.substring(normalizedPath.indexOf(`${path.sep}_main${path.sep}`) + '_main'.length + 1)
        : normalizedPath;
      const fullPath = path.join(workspacePath, trimmedPath);
      logWithTimestamp(`Pattern matched: [${bestMatch.source}] ${bestMatch.pattern}`);
      logWithTimestamp(`✔ Found & used: ${file}:${lineStr}`);
      if (fs.existsSync(fullPath)) {
        const uri = vscode.Uri.file(fullPath);
        const zeroBased = Math.max(0, Number(lineStr) - 1);
        const location = new vscode.Location(uri, new vscode.Position(zeroBased, 0));
        const fullText = [line, '', ...testLog].join('\n');
        const message = new vscode.TestMessage(fullText);
        message.location = location;
        messages.push(message);
      } else {
        logWithTimestamp(`File not found: ${fullPath}`);
      }
    }
  }

  return messages;
}

