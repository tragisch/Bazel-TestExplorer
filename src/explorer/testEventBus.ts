/*
 * Lightweight event bus for test lifecycle events used by the TestObserver.
 */

import * as vscode from 'vscode';

export type TestStatus = 'started' | 'passed' | 'failed' | 'skipped' | 'output';

export interface TestEvent {
  type: TestStatus;
  testId: string;
  label?: string;
  durationMs?: number;
  // accept either plain string or MarkdownString from VS Code APIs
  message?: string | vscode.MarkdownString;
  timestamp: number;
}

const emitter = new vscode.EventEmitter<TestEvent>();
const startTimes = new Map<string, number>();

export const onDidTestEvent = emitter.event;

export function startTest(testId: string, label?: string) {
  startTimes.set(testId, Date.now());
  emitter.fire({ type: 'started', testId, label, timestamp: Date.now() });
}

export function finishTest(testId: string, status: Exclude<TestStatus, 'started' | 'output'>, message?: string | vscode.MarkdownString) {
  const now = Date.now();
  const started = startTimes.get(testId) ?? now;
  const duration = Math.max(0, now - started);
  startTimes.delete(testId);
  emitter.fire({ type: status, testId, durationMs: duration, message, timestamp: now });
}

export function publishOutput(testId: string, output: string) {
  emitter.fire({ type: 'output', testId, message: output, timestamp: Date.now() });
}

export function clearStartTime(testId: string) {
  startTimes.delete(testId);
}

export default {
  onDidTestEvent,
  startTest,
  finishTest,
  publishOutput,
  clearStartTime
};
