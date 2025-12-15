/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BazelClient } from '../bazel/client';
import { BazelTestTarget } from '../bazel/types';
import { logWithTimestamp, measure, formatError } from '../logging';

let isDiscoveringTests = false;

/**
 * Haupt-Entry-Point für Test-Discovery
 */
export const discoverAndDisplayTests = async (
  controller: vscode.TestController,
  bazelClient: BazelClient
): Promise<void> => {
  if (isDiscoveringTests) {
    logWithTimestamp("Already discovering tests. Skipping.");
    return;
  }

  isDiscoveringTests = true;
  try {
    const testEntries = await measure("Query Bazel test targets", () =>
      bazelClient.queryTests()
    );

    updateTestTree(controller, testEntries);
    logDiscoveryResult(controller, testEntries);
  } catch (error) {
    handleDiscoveryError(error);
  } finally {
    isDiscoveringTests = false;
  }
};

/**
 * Aktualisiert den Test-Tree mit neuen Entries
 */
function updateTestTree(
  controller: vscode.TestController,
  testEntries: BazelTestTarget[]
): void {
  const packageCache = new Map<string, vscode.TestItem>();

  removeStaleItems(controller, testEntries);

  const sortedEntries = sortTestEntries(testEntries);
  for (const entry of sortedEntries) {
    addTestItemToController(controller, entry.target, entry.type, entry.tags ?? [], packageCache);
  }
}

/**
 * Entfernt veraltete Test-Items aus dem Controller
 */
function removeStaleItems(
  controller: vscode.TestController,
  testEntries: BazelTestTarget[]
): void {
  const currentTestIds = new Set(testEntries.map(entry => entry.target));

  controller.items.forEach((item) => {
    const hasLiveChildren = Array.from(item.children).some(([childId]) =>
      currentTestIds.has(childId)
    );
    if (!currentTestIds.has(item.id) && !hasLiveChildren) {
      logWithTimestamp(`Removing stale test item: ${item.id}`);
      controller.items.delete(item.id);
    }
  });
}

/**
 * Sortiert Test-Entries (test_suite zuerst, dann alphabetisch)
 */
function sortTestEntries(entries: BazelTestTarget[]): BazelTestTarget[] {
  return entries.sort((a, b) => {
    const aIsSuite = a.type === "test_suite" ? -1 : 0;
    const bIsSuite = b.type === "test_suite" ? -1 : 0;
    return aIsSuite - bIsSuite || a.target.localeCompare(b.target);
  });
}

/**
 * Loggt das Ergebnis der Discovery
 */
function logDiscoveryResult(
  controller: vscode.TestController,
  testEntries: BazelTestTarget[]
): void {
  const newTestIds: string[] = [];
  controller.items.forEach((item) => newTestIds.push(item.id));

  const maxDisplayCount = 10;
  const displayedTestIds = newTestIds.slice(0, maxDisplayCount);
  const additionalCount = newTestIds.length - maxDisplayCount;

  if (additionalCount > 0) {
    logWithTimestamp(
      `Registered test targets:\n ${displayedTestIds.join("\n ")}\n ...and ${additionalCount} more.`
    );
  } else if (displayedTestIds.length > 0) {
    logWithTimestamp(`Registered test targets:\n ${displayedTestIds.join("\n ")}`);
  }
}

/**
 * Zentrale Fehlerbehandlung für Discovery
 */
function handleDiscoveryError(error: unknown): void {
  const message = formatError(error);
  vscode.window.showErrorMessage(`❌ Failed to discover tests:\n${message}`);
  logWithTimestamp(`❌ Error in discoverAndDisplayTests:\n${message}`);
}

/**
 * Fügt ein Test-Item zum Controller hinzu
 */
export const addTestItemToController = (
  controller: vscode.TestController,
  target: string,
  testType: string,
  tags: string[],
  packageCache: Map<string, vscode.TestItem>
): void => {
  const [packageName, testName] = parseTargetLabel(target);

  const packageItem = getOrCreatePackageItem(controller, packageName, packageCache);
  const testItem = createTestItem(controller, target, testName, testType, tags, packageName);

  packageItem.children.add(testItem);
};

/**
 * Parst ein Bazel Target-Label in Package und Test-Name
 */
function parseTargetLabel(target: string): [string, string] {
  return target.includes(":")
    ? target.split(":") as [string, string]
    : [target, target];
}

/**
 * Holt oder erstellt ein Package-Item
 */
function getOrCreatePackageItem(
  controller: vscode.TestController,
  packageName: string,
  cache: Map<string, vscode.TestItem>
): vscode.TestItem {
  let packageItem = cache.get(packageName);
  if (!packageItem) {
    const { label, tooltip } = formatPackageLabel(packageName);
    packageItem = controller.createTestItem(packageName, `📦 ${label}`);
    packageItem.description = tooltip;
    controller.items.add(packageItem);
    cache.set(packageName, packageItem);
  }
  return packageItem;
}

/**
 * Erstellt ein Test-Item
 */
function createTestItem(
  controller: vscode.TestController,
  target: string,
  testName: string,
  testType: string,
  tags: string[],
  packageName: string
): vscode.TestItem {
  const uri = guessSourceUri(packageName, testName, testType);
  const icon = testType === "test_suite" ? "🧪 " : "";
  const label = `${icon}[${testType}] ${testName}`;

  const testItem = controller.createTestItem(target, label, uri);
  testItem.tags = ["bazel", ...tags].map(t => new vscode.TestTag(t));
  testItem.description = `Target: ${target}`;
  testItem.busy = false;
  testItem.canResolveChildren = false;

  return testItem;
}

// ───────────────────────────────────────────────────────────────
// Helper Functions
// ───────────────────────────────────────────────────────────────

/**
 * Formatiert ein Package-Label für die Anzeige
 */
function formatPackageLabel(bazelPath: string): { label: string; tooltip: string } {
  const withoutSlashes = bazelPath.replace(/^\/\//, "");
  const parts = withoutSlashes.split('/');
  const root = parts[0] || '';
  const tail = parts.slice(-2).join('/');
  const tooltip = `//${withoutSlashes}`;
  return { label: `${root}: ${tail}`, tooltip };
}

/**
 * Versucht die Source-URI für einen Test zu erraten
 */
function guessSourceUri(
  packageName: string,
  testName: string,
  testType: string
): vscode.Uri | undefined {
  const workspace = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
  const packagePath = packageName.replace(/^\/\//, '');
  const extensions = getExtensionsByType(testType);

  for (const ext of extensions) {
    const filePath = path.join(workspace, packagePath, testName + ext);
    if (fs.existsSync(filePath)) {
      return vscode.Uri.file(filePath);
    }
  }

  return undefined;
}

/**
 * Gibt mögliche Datei-Endungen für einen Test-Typ zurück
 */
function getExtensionsByType(testType: string): string[] {
  const typeMap: Record<string, string[]> = {
    'cc_test': ['.cc', '.cpp', '.c'],
    'unity_test': ['.c'],
    'py_test': ['.py'],
    'java_test': ['.java'],
    'go_test': ['.go'],
    'ts_test': ['.ts', '.tsx'],
    'rust_test': ['.rs']
  };
  return typeMap[testType] || ['.c'];
}
