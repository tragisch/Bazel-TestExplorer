/*
 * TestCaseAnnotations
 * - Tracks resolved Bazel test case locations
 * - Provides CodeLens and diagnostic data for editor integrations
 */

import * as vscode from 'vscode';
import { IndividualTestCase } from '../bazel/types';

export interface TestCaseAnnotationEntry {
  id: string;
  parentTargetId: string;
  testName: string;
  uri: vscode.Uri;
  range?: vscode.Range;
  status: IndividualTestCase['status'];
  message?: string;
}

export type AnnotationUpdate = Omit<TestCaseAnnotationEntry, 'parentTargetId'> & { parentTargetId?: string };

export class TestCaseAnnotations implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('bazelTestExplorer');
  private readonly byTarget = new Map<string, TestCaseAnnotationEntry[]>();
  private readonly byFile = new Map<string, { uri: vscode.Uri; entries: TestCaseAnnotationEntry[] }>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  dispose(): void {
    this.diagnostics.dispose();
    this.changeEmitter.dispose();
    this.byTarget.clear();
    this.byFile.clear();
  }

  setTestCasesForTarget(targetId: string, entries: AnnotationUpdate[]): void {
    this.removeTarget(targetId);
    const additions: TestCaseAnnotationEntry[] = [];
    for (const entry of entries) {
      if (!entry.uri) {
        continue;
      }
      const normalized: TestCaseAnnotationEntry = {
        ...entry,
        parentTargetId: targetId
      } as TestCaseAnnotationEntry;
      additions.push(normalized);
      this.addToFileIndex(normalized);
    }
    if (additions.length > 0) {
      this.byTarget.set(targetId, additions);
    }
    this.changeEmitter.fire();
  }

  getTestCasesForDocument(uri: vscode.Uri): TestCaseAnnotationEntry[] {
    const item = this.byFile.get(uri.toString());
    return item ? item.entries : [];
  }

  clear(): void {
    this.diagnostics.clear();
    this.byTarget.clear();
    this.byFile.clear();
    this.changeEmitter.fire();
  }

  private removeTarget(targetId: string): void {
    const existing = this.byTarget.get(targetId);
    if (!existing) {
      return;
    }
    this.byTarget.delete(targetId);
    const affected = new Set<string>();
    for (const entry of existing) {
      const key = entry.uri.toString();
      affected.add(key);
      const fileEntry = this.byFile.get(key);
      if (!fileEntry) {
        continue;
      }
      const updated = fileEntry.entries.filter(e => e.id !== entry.id);
      if (updated.length > 0) {
        this.byFile.set(key, { uri: fileEntry.uri, entries: updated });
      } else {
        this.byFile.delete(key);
      }
    }
    for (const key of affected) {
      const fileEntry = this.byFile.get(key);
      const uri = fileEntry ? fileEntry.uri : vscode.Uri.parse(key);
      if (fileEntry && fileEntry.entries.length > 0) {
        this.updateDiagnostics(uri, fileEntry.entries);
      } else {
        this.diagnostics.delete(uri);
      }
    }
  }

  private addToFileIndex(entry: TestCaseAnnotationEntry): void {
    const key = entry.uri.toString();
    const existing = this.byFile.get(key);
    const entries = existing ? existing.entries : [];
    entries.push(entry);
    this.byFile.set(key, { uri: entry.uri, entries });
    this.updateDiagnostics(entry.uri, entries);
  }

  private updateDiagnostics(uri: vscode.Uri, entries: TestCaseAnnotationEntry[]): void {
    const diagnostics = entries
      .filter(entry => entry.range && (entry.status === 'FAIL' || entry.status === 'TIMEOUT'))
      .map(entry => {
        const message = entry.message?.trim() || `${entry.testName} failed`;
        const diagnostic = new vscode.Diagnostic(entry.range!, `Bazel Test ${entry.testName}: ${message}`, vscode.DiagnosticSeverity.Error);
        diagnostic.source = 'Bazel Test Explorer';
        return diagnostic;
      });

    if (diagnostics.length > 0) {
      this.diagnostics.set(uri, diagnostics);
    } else {
      this.diagnostics.delete(uri);
    }
  }
}

export class TestCaseCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;
  private readonly annotationListener: vscode.Disposable;

  constructor(private readonly annotations: TestCaseAnnotations) {
    this.annotationListener = this.annotations.onDidChange(() => this.onDidChangeCodeLensesEmitter.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const entries = this.annotations.getTestCasesForDocument(document.uri);
    if (!entries || entries.length === 0) {
      return [];
    }
    const lenses: vscode.CodeLens[] = [];
    for (const entry of entries) {
      if (!entry.range) {
        continue;
      }
      const statusLabel = entry.status === 'PASS' ? 'Run' : entry.status === 'SKIP' ? 'Run' : 'Rerun failed';
      lenses.push(
        new vscode.CodeLens(entry.range, {
          title: `${statusLabel} Bazel Test`,
          command: 'bazelTestExplorer.runTestCase',
          arguments: [entry.id]
        })
      );
    }
    return lenses;
  }

  dispose(): void {
    this.annotationListener.dispose();
    this.onDidChangeCodeLensesEmitter.dispose();
  }
}

export class TestCaseHoverProvider implements vscode.HoverProvider {
  constructor(private readonly annotations: TestCaseAnnotations) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
    const entries = this.annotations.getTestCasesForDocument(document.uri);
    if (!entries || entries.length === 0) {
      return undefined;
    }
    const match = entries.find(entry => entry.range?.contains(position));
    if (!match) {
      return undefined;
    }

    const status = match.status === 'PASS' ? '✅ Passed' :
      match.status === 'SKIP' ? '⚠️ Skipped' :
      match.status === 'TIMEOUT' ? '⏱️ Timeout' :
      '❌ Failed';

    const message = match.message ? `\n\n${match.message.trim()}` : '';
    const md = new vscode.MarkdownString(`**${status}** — ${match.testName}${message}`);
    md.isTrusted = true;
    return new vscode.Hover(md, match.range);
  }
}
