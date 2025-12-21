/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/**
 * Test tree builder - constructs hierarchical test tree structure from Bazel targets
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BazelClient } from '../bazel/client';
import { BazelTestTarget, IndividualTestCase } from '../bazel/types';
import { logWithTimestamp, measure, formatError } from '../logging';
import { discoverIndividualTestCases } from '../bazel/discovery';
import { findBazelWorkspace } from '../bazel/workspace';
import { TestCaseAnnotations, AnnotationUpdate } from './testCaseAnnotations';
import { TestCaseInsights } from './testCaseInsights';

function getDiscoveryEnabled(): boolean {
  try {
    const vscode = require('vscode');
    const cfg = vscode.workspace.getConfiguration('bazelTestExplorer');
    return (cfg.get('enableTestCaseDiscovery', false) as boolean);
  } catch {
    // When running outside of VS Code (unit tests), default to true
    return true;
  }
}

let isDiscoveringTests = false;

/**
 * Main entry point for test discovery
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
 * Update test tree with new entries
 */
function updateTestTree(
  controller: vscode.TestController,
  testEntries: BazelTestTarget[]
): void {
  const packageCache = new Map<string, vscode.TestItem>();

  removeStaleItems(controller, testEntries);

  const sortedEntries = sortTestEntries(testEntries);
  for (const entry of sortedEntries) {
    addTestItemToController(controller, entry, packageCache);
  }
}

/**
 * Remove stale test items from controller
 */
export function removeStaleItems(
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
 * Sort test entries (test_suite first, then alphabetically)
 */
export function sortTestEntries(entries: BazelTestTarget[]): BazelTestTarget[] {
  return entries.sort((a, b) => {
    const aIsSuite = a.type === "test_suite" ? -1 : 0;
    const bIsSuite = b.type === "test_suite" ? -1 : 0;
    return aIsSuite - bIsSuite || a.target.localeCompare(b.target);
  });
}

/**
 * Log discovery results
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
 * Central error handling for discovery
 */
function handleDiscoveryError(error: unknown): void {
  const message = formatError(error);
  vscode.window.showErrorMessage(`❌ Failed to discover tests:\n${message}`);
  logWithTimestamp(`❌ Error in discoverAndDisplayTests:\n${message}`);
}

/**
 * Add test item to controller
 */
export const addTestItemToController = (
  controller: vscode.TestController,
  testTarget: BazelTestTarget,
  packageCache: Map<string, vscode.TestItem>
): void => {
  const target = testTarget.target;
  const [packageName, testName] = parseTargetLabel(target);

  const packageItem = getOrCreatePackageItem(controller, packageName, packageCache);
  const testItem = createTestItem(controller, testTarget, testName, packageName);

  packageItem.children.add(testItem);
};

/**
 * Parse Bazel target label into package and test name
 */
export function parseTargetLabel(target: string): [string, string] {
  return target.includes(":")
    ? target.split(":") as [string, string]
    : [target, target];
}

/**
 * Get or create package item
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
 * Create test item
 */
function createTestItem(
  controller: vscode.TestController,
  testTarget: BazelTestTarget,
  testName: string,
  packageName: string
): vscode.TestItem {
  const target = testTarget.target;
  const testType = testTarget.type;
  const tags = testTarget.tags ?? [];
  
  // Prefer source file from metadata over guessing
  const uri = resolveSourceUri(testTarget, packageName, testName);
  
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
    // individual test discovery is disabled; leave description unchanged

  }

  return testItem;
}

// ───────────────────────────────────────────────────────────────
// Helper Functions
// ───────────────────────────────────────────────────────────────

/**
 * Format package label for display
 */
export function formatPackageLabel(bazelPath: string): { label: string; tooltip: string } {
  const withoutSlashes = bazelPath.replace(/^\/\//, "");
  const parts = withoutSlashes.split('/');
  const root = parts[0] || '';
  const tail = parts.slice(-2).join('/');
  const tooltip = `//${withoutSlashes}`;
  return { label: `${root}: ${tail}`, tooltip };
}

/**
 * Resolve source URI for test - uses metadata srcs if available, otherwise guesses
 */
function resolveSourceUri(
  testTarget: BazelTestTarget,
  packageName: string,
  testName: string
): vscode.Uri | undefined {
  // Try to use source files from metadata first
  if (testTarget.srcs && testTarget.srcs.length > 0) {
    // Special handling for ThrowTheSwitch: prefer non-Runner file
    const preferredSrc = selectPreferredSourceFile(testTarget.srcs);
    const srcUri = bazelLabelToUri(preferredSrc);
    if (srcUri) {
      return srcUri;
    }
  }
  
  // Fallback to guessing strategy
  return guessSourceUri(packageName, testName, testTarget.type);
}

/**
 * Select preferred source file from srcs list.
 * For ThrowTheSwitch: prefer file WITHOUT _Runner suffix.
 */
function selectPreferredSourceFile(srcs: string[]): string {
  if (srcs.length === 1) {
    return srcs[0];
  }
  
  // Check if this is a ThrowTheSwitch test (has _Runner.c file)
  const runnerFile = srcs.find(src => src.includes('_Runner.c') || src.includes('_Runner.cc'));
  
  if (runnerFile) {
    // Find the non-Runner file
    const nonRunnerFile = srcs.find(src => 
      !src.includes('_Runner.c') && !src.includes('_Runner.cc')
    );
    if (nonRunnerFile) {
      return nonRunnerFile;
    }
  }
  
  // Default: return first source file
  return srcs[0];
}

/**
 * Convert Bazel label (//package:file.cc) to VS Code URI
 */
function bazelLabelToUri(label: string): vscode.Uri | undefined {
  const workspace = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  if (!workspace) return undefined;

  // Parse label format: //package/path:filename or //package/path:subdir/filename
  let packagePath: string;
  let fileName: string;

  if (label.includes(':')) {
    const [pkg, file] = label.split(':');
    packagePath = pkg.replace(/^\/\//, '');
    fileName = file;
  } else {
    // Handle labels without colon (file in same package)
    packagePath = label.replace(/^\/\//, '');
    const parts = packagePath.split('/');
    fileName = parts.pop() || '';
    packagePath = parts.join('/');
  }

  const fullPath = path.join(workspace, packagePath, fileName);
  
  // Verify file exists
  try {
    if (fs.existsSync(fullPath)) {
      return vscode.Uri.file(fullPath);
    }
  } catch (e) {
    // Ignore errors
  }
  
  return undefined;
}

/**
 * Guess source URI for test
 */
export function guessSourceUri(
  packageName: string,
  testName: string,
  testType: string
): vscode.Uri | undefined {
  const workspace = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
  const packagePath = packageName.replace(/^\/\//, '');
  const extensions = getExtensionsByType(testType);

  // Package-level cache to avoid repeated fs.existsSync calls for the same package.
  // Cache entry contains whether the directory exists and the set of file names.
  type PackageCacheEntry = { dirExists: boolean; files?: Set<string> };
  const packageCacheKey = packagePath;

  // Initialize module-scoped cache map lazily
  if (!(global as any).__bazel_testexplorer_packageFileCache) {
    (global as any).__bazel_testexplorer_packageFileCache = new Map<string, PackageCacheEntry>();
  }
  const packageFileCache: Map<string, PackageCacheEntry> = (global as any).__bazel_testexplorer_packageFileCache;

  // Ensure cache populated for this package
  if (!packageFileCache.has(packageCacheKey)) {
    const dirFull = path.join(workspace, packagePath);
    try {
      if (fs.existsSync(dirFull) && fs.statSync(dirFull).isDirectory()) {
        const names = new Set<string>(fs.readdirSync(dirFull));
        packageFileCache.set(packageCacheKey, { dirExists: true, files: names });
      } else {
        packageFileCache.set(packageCacheKey, { dirExists: false });
      }
    } catch (e) {
      packageFileCache.set(packageCacheKey, { dirExists: false });
    }
  }

  const cacheEntry = packageFileCache.get(packageCacheKey)!;
  if (!cacheEntry.dirExists) return undefined;

  for (const ext of extensions) {
    const candidate = testName + ext;
    if (cacheEntry.files && cacheEntry.files.has(candidate)) {
      return vscode.Uri.file(path.join(workspace, packagePath, candidate));
    }
  }

  return undefined;
}

/**
 * Return possible file extensions for test type
 */
export function getExtensionsByType(testType: string): string[] {
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
  controller: vscode.TestController,
  bazelClient: BazelClient,
  annotations?: TestCaseAnnotations,
  insights?: TestCaseInsights
): Promise<void> => {
  try {
    // Respect user setting: if discovery is disabled, do not attempt to resolve children
    try {
      const vscode = require('vscode');
      const cfg = vscode.workspace.getConfiguration('bazelTestExplorer');
      const enabled = (cfg.get('enableTestCaseDiscovery', false) as boolean);
      if (!enabled) {
        logWithTimestamp(`Skipping resolution for ${testItem.id} because discovery is disabled by configuration.`);
        return;
      }
    } catch (error) {
      // Proceed when vscode not available (e.g. tests)
      logWithTimestamp(`Could not read enableTestCaseDiscovery config: ${formatError(error)}`, 'info');
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
      const targetMetadata = bazelClient.getTargetMetadata(testItem.id);
      const fallbackLocation = targetMetadata
        ? resolveSourceFromMetadata(testItem.id, workspacePath, targetMetadata)
        : undefined;
      const annotationEntries: AnnotationUpdate[] = [];

      for (const testCase of result.testCases) {
        const testCaseId = `${testItem.id}::${testCase.name}`;
        const existing = testItem.children.get(testCaseId);
        const resolvedFile = selectFilePath(testCase.file, fallbackLocation?.file);
        const absolutePath = resolvedFile ? toAbsolutePath(resolvedFile, workspacePath) : undefined;
        const uri = absolutePath ? vscode.Uri.file(absolutePath) : undefined;
        const resolvedLine = testCase.line && testCase.line > 0
          ? testCase.line
          : fallbackLocation?.line;
        const range = resolvedLine && resolvedLine > 0
          ? new vscode.Range(
              new vscode.Position(Math.max(0, resolvedLine - 1), 0),
              new vscode.Position(Math.max(0, resolvedLine - 1), 0)
            )
          : undefined;

        if (absolutePath) {
          testCase.file = absolutePath;
        }
        if (resolvedLine && resolvedLine > 0 && resolvedLine !== testCase.line) {
          testCase.line = resolvedLine;
        }

        if (!existing) {
          const statusIcon = '🧪';
          const testCaseItem = controller.createTestItem(testCaseId, `${statusIcon} ${testCase.name}`, uri);
          if (range) {
            testCaseItem.range = range;
            testCaseItem.description = `Line ${resolvedLine}`;
          }
          testCaseItem.canResolveChildren = false;
          testItem.children.add(testCaseItem);
        } else if (range) {
          existing.range = range;
          existing.description = `Line ${resolvedLine}`;
        }

        if (uri) {
          annotationEntries.push({
            id: testCaseId,
            testName: testCase.name,
            status: testCase.status,
            message: testCase.errorMessage,
            uri,
            range
          });
        }
      }

      logWithTimestamp(`Resolved ${result.testCases.length} test cases for ${testItem.id}`);
      annotations?.setTestCasesForTarget(testItem.id, annotationEntries);
      insights?.setResult(testItem.id, result);
    } finally {
      testItem.busy = false;
    }
  } catch (error) {
    const message = formatError(error);
    logWithTimestamp(`Failed to resolve test cases for ${testItem.id}: ${message}`, "error");
    testItem.busy = false;
  }
};

function selectFilePath(primary?: string, fallback?: string): string | undefined {
  if (primary && primary.trim().length > 0) {
    const normalized = primary.trim();
    const hasSeparator = normalized.includes('/') || normalized.includes(path.sep);
    if (hasSeparator || !fallback) {
      return normalized;
    }
    const fallbackDir = fallback.includes('/') || fallback.includes(path.sep)
      ? path.posix.dirname(fallback).replace(/\\/g, '/')
      : '';
    if (fallbackDir) {
      return path.posix.join(fallbackDir, normalized);
    }
    return normalized;
  }
  return fallback;
}

function toAbsolutePath(filePath: string, workspacePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.join(workspacePath, filePath);
}

function resolveSourceFromMetadata(
  targetId: string,
  workspacePath: string,
  metadata: BazelTestTarget
): { file: string; line?: number } | undefined {
  const [packageLabel] = parseTargetLabel(targetId);
  const packagePath = packageLabel.replace(/^\/\//, '');
  const candidates: { file: string; line?: number }[] = [];

  if (metadata.srcs && metadata.srcs.length > 0) {
    for (const src of metadata.srcs) {
      const normalized = normalizeSrcEntry(src, packagePath);
      if (normalized) {
        candidates.push({ file: normalized });
      }
    }
  }

  if (metadata.location) {
    const parsedLocation = parseLocation(metadata.location);
    if (parsedLocation) {
      candidates.push(parsedLocation);
    }
  }

  for (const candidate of candidates) {
    const absolute = toAbsolutePath(candidate.file, workspacePath);
    if (fs.existsSync(absolute)) {
      return candidate;
    }
  }

  return undefined;
}

function normalizeSrcEntry(src: string, packagePath: string): string | undefined {
  if (!src) {
    return undefined;
  }

  if (src.startsWith('//')) {
    const withoutPrefix = src.slice(2);
    const [pkg, file] = withoutPrefix.split(':');
    if (pkg && file) {
      return path.posix.join(pkg, file);
    }
    return pkg;
  }

  if (src.startsWith(':')) {
    const file = src.slice(1);
    return path.posix.join(packagePath, file);
  }

  if (src.includes(':')) {
    const [pkg, file] = src.split(':');
    if (file) {
      return path.posix.join(pkg.replace(/^\/\//, ''), file);
    }
  }

  return path.posix.join(packagePath, src);
}

function parseLocation(location: string): { file: string; line?: number } | undefined {
  const match = location.match(/^(.*?):(\d+)(?::\d+)?$/);
  if (!match) {
    return undefined;
  }

  const file = match[1];
  const line = parseInt(match[2], 10);
  return {
    file,
    line: Number.isFinite(line) ? line : undefined
  };
}
