/*
 * TestObserver
 * - subscribes to test lifecycle events published on the event bus
 * - collects a small in-memory history of recent runs
 */

import * as vscode from 'vscode';
import { onDidTestEvent, TestEvent } from './testEventBus';
import { logWithTimestamp } from '../logging';

export interface TestHistoryEntry {
  testId: string;
  type: string; // passed/failed/skipped
  durationMs?: number;
  message?: string | vscode.MarkdownString;
  timestamp: number;
}

export class TestObserver implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly history: TestHistoryEntry[] = [];
  private readonly maxEntries = 200;
  private verboseLogging = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.verboseLogging = vscode.workspace.getConfiguration('bazelTestExplorer').get('verboseLogging') === true;

    const d = onDidTestEvent((e: TestEvent) => this.handleEvent(e));
    this.disposables.push(d);
    this.context.subscriptions.push(this);
    logWithTimestamp('TestObserver initialized');

    // watch configuration changes for verbose logging toggle
    const cfg = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration && e.affectsConfiguration('bazelTestExplorer.verboseLogging')) {
        this.verboseLogging = vscode.workspace.getConfiguration('bazelTestExplorer').get('verboseLogging') === true;
      }
    });
    this.disposables.push(cfg);
  }

  private handleEvent(e: TestEvent) {
    switch (e.type) {
      case 'started':
        if (this.verboseLogging) logWithTimestamp(`Test started: ${e.testId}`);
        break;
      case 'passed':
      case 'failed':
      case 'skipped':
        this.pushHistory({ testId: e.testId, type: e.type, durationMs: e.durationMs, message: e.message, timestamp: e.timestamp });
        if (this.verboseLogging) logWithTimestamp(`Test ${e.type}: ${e.testId} (${e.durationMs ?? 0}ms)`);
        break;
      case 'output':
        // Throttle or silence per-line output unless verbose logging enabled
        if (this.verboseLogging) {
          logWithTimestamp(`Test output (${e.testId}): ${this.toMessageString(e.message as any)}`);
        }
        break;
    }
  }

  private pushHistory(entry: TestHistoryEntry) {
    this.history.unshift(entry);
    if (this.history.length > this.maxEntries) this.history.length = this.maxEntries;
  }

  getHistory(): ReadonlyArray<TestHistoryEntry> {
    return this.history;
  }

  private toMessageString(msg?: string | vscode.MarkdownString): string {
    if (!msg) return '';
    return typeof msg === 'string' ? msg : msg.value ?? String(msg);
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}

export default TestObserver;
