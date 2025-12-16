/*
 * TestHistoryProvider - TreeDataProvider for TestObserver history
 */
import * as vscode from 'vscode';
import { TestObserver, TestHistoryEntry } from './testObserver';

export class TestHistoryProvider implements vscode.TreeDataProvider<TestHistoryEntry> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TestHistoryEntry | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly observer: TestObserver) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TestHistoryEntry): vscode.TreeItem {
    const label = `${element.testId}`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = element.durationMs ? `${element.durationMs} ms — ${element.type}` : element.type;
    const detail = typeof element.message === 'string' ? element.message : (element.message?.value ?? '');
    item.tooltip = `Status: ${element.type}\n${element.durationMs ?? '-'} ms\n\n${detail}`;
    item.contextValue = element.type;
    // allow clicking the tree item to open details and offer rerun
    item.command = {
      command: 'bazelTestExplorer.openHistoryItem',
      title: 'Open Test History Item',
      arguments: [element]
    };
    return item;
  }

  getChildren(): Thenable<TestHistoryEntry[]> {
    // expose a shallow copy limited to most recent 200 entries
    return Promise.resolve(this.observer.getHistory().slice(0, 200));
  }
}

export default TestHistoryProvider;
