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
    this.verboseLogging = vscode.workspace.getConfiguration('bazelTestRunner').get('verboseLogging') === true;

    const d = onDidTestEvent((e: TestEvent) => this.handleEvent(e));
    this.disposables.push(d);
    this.context.subscriptions.push(this);
    logWithTimestamp('TestObserver initialized');

    // register quickpick command to show recent history
    const cmd = vscode.commands.registerCommand('bazelTestExplorer.showTestHistory', () => this.showHistory());
    this.disposables.push(cmd);
    this.context.subscriptions.push(cmd);

    // watch configuration changes for verbose logging toggle
    const cfg = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration && e.affectsConfiguration('bazelTestRunner.verboseLogging')) {
        this.verboseLogging = vscode.workspace.getConfiguration('bazelTestRunner').get('verboseLogging') === true;
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

  async showHistory() {
    if (this.history.length === 0) {
      void vscode.window.showInformationMessage('No recent test history available.');
      return;
    }

    const items = this.history.slice(0, 50).map(h => ({
      label: `${h.type.toUpperCase()}: ${h.testId}`,
      description: h.durationMs ? `${h.durationMs} ms` : undefined,
      detail: this.toMessageString(h.message),
      // attach the actual history entry so selection is stable even if history mutates
      entry: h
    } as vscode.QuickPickItem & { entry: TestHistoryEntry }));

    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Recent test history (select to view details)', matchOnDetail: true }) as (vscode.QuickPickItem & { entry: TestHistoryEntry }) | undefined;
    if (!pick) return;

    const entry = pick.entry;
    const content = `--- Test: ${entry.testId} ---\nStatus: ${entry.type}\nDuration: ${entry.durationMs ?? '-'} ms\n\n${this.toMessageString(entry.message)}`;
    const doc = await vscode.workspace.openTextDocument({ content, language: 'text' });
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    const action = await vscode.window.showInformationMessage('Opened test log in editor', 'Rerun');
    if (action === 'Rerun') {
      void vscode.commands.executeCommand('bazelTestExplorer.rerunTestFromHistory', entry.testId);
    }
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}

export default TestObserver;
