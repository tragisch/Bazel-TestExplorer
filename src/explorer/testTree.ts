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
import { discoverIndividualTestCases } from '../bazel/discovery';
import { findBazelWorkspace } from '../bazel/workspace';

function getDiscoveryEnabled(): boolean {
  try {
    const vscode = require('vscode');
    const cfg = vscode.workspace.getConfiguration('bazelTestRunner');
    return (cfg.get('enableTestCaseDiscovery', false) as boolean);
  } catch {
    // When running outside of VS Code (unit tests), default to true
    return true;
  }
}

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
  const icon = testType === "test_suite" ? "🧰 " : "";
  const discoveryEnabled = getDiscoveryEnabled();
  const label = `${icon}[${testType}] ${testName}`;

  const testItem = controller.createTestItem(target, label, uri);
  testItem.tags = ["bazel", ...tags].map(t => new vscode.TestTag(t));
  testItem.description = `Target: ${target}`;
  testItem.busy = false;
  
  // Enable children resolution for individual test case discovery
  const isSuite = testType === "test_suite";
  testItem.canResolveChildren = !isSuite && discoveryEnabled;
  if (!discoveryEnabled) {
    testItem.description = `${testItem.description} (individual test discovery disabled)`;

  }

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
// ───────────────────────────────────────────────────────────────
// Individual Test Case Discovery and Resolution
// ───────────────────────────────────────────────────────────────

/**
 * Resolves individual test cases for a given test target
 * Used by the TestController resolve handler for lazy-loading children
 */
export const resolveTestCaseChildren = async (
  testItem: vscode.TestItem,
  controller: vscode.TestController
): Promise<void> => {
  try {
    // Respect user setting: if discovery is disabled, do not attempt to resolve children
    try {
      const vscode = require('vscode');
      const cfg = vscode.workspace.getConfiguration('bazelTestRunner');
      const enabled = (cfg.get('enableTestCaseDiscovery', false) as boolean);
      if (!enabled) {
        logWithTimestamp(`Skipping resolution for ${testItem.id} because discovery is disabled by configuration.`);
        return;
      }
    } catch {
      // ignore and proceed when vscode not available (e.g. tests)
    }
    // Skip if already resolved
    if (testItem.children.size > 0) {
      logWithTimestamp(`Children already present for ${testItem.id}; skipping discovery.`);
      return;
    }

    // Skip for test suites
    const typeMatch = testItem.label.match(/\[(.*?)\]/);
    const testType = typeMatch?.[1];
    if (testType === "test_suite") {
      return;
    }

    const workspacePath = await findBazelWorkspace();
    if (!workspacePath) {
      logWithTimestamp(`No Bazel workspace found for resolving ${testItem.id}`);
      return;
    }

    logWithTimestamp(`Discovering individual test cases for ${testItem.id}...`);
    testItem.busy = true;

    try {
      const result = await discoverIndividualTestCases(testItem.id, workspacePath, testType);
      
      for (const testCase of result.testCases) {
        const testCaseId = `${testItem.id}::${testCase.name}`;
        const existing = testItem.children.get(testCaseId);

        if (!existing) {
          const statusIcon = '🧪';
          const uri = testCase.file
            ? vscode.Uri.file(path.join(workspacePath, testCase.file))
            : undefined;

          const testCaseItem = controller.createTestItem(testCaseId, `${statusIcon} ${testCase.name}`, uri);

          if (testCase.line && testCase.line > 0) {
            const lineZeroBased = Math.max(0, testCase.line - 1);
            testCaseItem.range = new vscode.Range(
              new vscode.Position(lineZeroBased, 0),
              new vscode.Position(lineZeroBased, 0)
            );
            testCaseItem.description = `Line ${testCase.line}`;
          }

          testCaseItem.canResolveChildren = false;
          testItem.children.add(testCaseItem);
        }
      }

      logWithTimestamp(`Resolved ${result.testCases.length} test cases for ${testItem.id}`);
    } finally {
      testItem.busy = false;
    }
  } catch (error) {
    const message = formatError(error);
    logWithTimestamp(`Failed to resolve test cases for ${testItem.id}: ${message}`, "error");
    testItem.busy = false;
  }
};