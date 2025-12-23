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
import { ConfigurationService } from '../configuration';
import { expandTestSuite } from '../bazel/queries';
import { formatCoverageShort, getCoverageSummary } from '../coverageState';
import {
  resolveSourceUri,
  resolveSourceFromMetadata,
  selectFilePath,
  toAbsolutePath
} from './sourceUtils';

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
    
    const config = new ConfigurationService();
    updateTestTree(controller, testEntries, config);
    logDiscoveryResult(controller, testEntries);
  } catch (error) {
    handleDiscoveryError(error);
  } finally {
    isDiscoveringTests = false;
  }
};
function updateTestTree(
  controller: vscode.TestController,
  testEntries: BazelTestTarget[],
  config: ConfigurationService
): void {
  const packageCache = new Map<string, vscode.TestItem>();

  removeStaleItems(controller, testEntries);

  const sortedEntries = sortTestEntries(testEntries);
  for (const entry of sortedEntries) {
    addTestItemToController(controller, entry, packageCache, config);
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
  packageCache: Map<string, vscode.TestItem>,
  config: ConfigurationService
): void => {
  const target = testTarget.target;
  const [packageName, testName] = parseTargetLabel(target);

  const packageItem = getOrCreatePackageItem(controller, packageName, packageCache);
  const testItem = createTestItem(controller, testTarget, testName, packageName, config);

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
  packageName: string,
  config: ConfigurationService
): vscode.TestItem {
  const target = testTarget.target;
  const testType = testTarget.type;
  const tags = testTarget.tags ?? [];
  
  // Prefer source file from metadata over guessing
  const uri = resolveSourceUri(testTarget, packageName, testName);
  
  const icon = testType === "test_suite" ? "🧰 " : "";
  const discoveryEnabled = config.enableTestCaseDiscovery;
  let label = `${icon}[${testType}] ${testName}`;
  
  // Add flaky indicator in label
  if (testTarget.flaky) {
    label = `⚠️ ${label}`;
  }
  
  // Add size and timeout warnings for large/long-running tests
  const sizeIcon = testTarget.size === 'enormous' ? '🔴 ' : testTarget.size === 'large' ? '🟠 ' : '';
  const timeoutValue = testTarget.timeout != null ? parseInt(testTarget.timeout, 10) : NaN;
  const timeoutIcon = !Number.isNaN(timeoutValue) && timeoutValue > 300 ? '⏱️ ' : '';
  if (sizeIcon || timeoutIcon) {
    label = `${sizeIcon}${timeoutIcon}${label}`;
  }

  const testItem = controller.createTestItem(target, label, uri);
  testItem.tags = ["bazel", ...tags].map(t => new vscode.TestTag(t));
  testItem.description = `Target: ${target}`;
  testItem.busy = false;
  
  // Add metadata description if enabled
  if (config.showMetadataInLabel) {
    const metadata = buildMetadataString(testTarget);
    const coverageSummary = getCoverageSummary(target);
    const coverageShort = coverageSummary ? formatCoverageShort(coverageSummary) : '';
    const combined = [metadata, coverageShort].filter(Boolean).join(' ');
    if (combined) {
      testItem.description = combined;
    }
  }
  
  // Enable children resolution for individual test case discovery
  const isSuite = testType === "test_suite";
  // test_suite can have children (lazy-loaded), tests can have test cases
  testItem.canResolveChildren = isSuite || discoveryEnabled;
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
 * Build metadata string for test item description/tooltip.
 * Shows size, timeout, flaky status, and relevant tags.
 */
function buildMetadataString(target: BazelTestTarget): string {
  const parts: string[] = [];
  
  if (target.size) {
    parts.push(`size=${target.size}`);
  }
  
  if (target.timeout) {
    parts.push(`timeout=${target.timeout}`);
  }
  
  if (target.flaky) {
    parts.push('flaky');
  }
  
  if (target.tags && target.tags.length > 0) {
    const relevantTags = target.tags.filter(t => 
      t === 'exclusive' || t === 'external' || t === 'manual' || t === 'local'
    );
    if (relevantTags.length > 0) {
      parts.push(`tags=${relevantTags.join(',')}`);
    }
  }
  
  return parts.join(' ');
}

// Prefer non-runner source selection moved to sourceUtils

// Source resolution moved to src/explorer/sourceUtils.ts
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
    let discoveryEnabled = true;
    try {
      const cfg = new ConfigurationService();
      discoveryEnabled = cfg.enableTestCaseDiscovery;
    } catch (error) {
      logWithTimestamp(`Could not read enableTestCaseDiscovery config: ${formatError(error)}`, 'info');
    }
    if (!discoveryEnabled) {
      logWithTimestamp(`Skipping resolution for ${testItem.id} because discovery is disabled by configuration.`);
      return;
    }
    // Skip if already resolved
    if (testItem.children.size > 0) {
      logWithTimestamp(`Children already present for ${testItem.id}; skipping discovery.`);
      return;
    }

    // Check if this is a test_suite
    const typeMatch = testItem.label.match(/\[(.*?)\]/);
    const testType = typeMatch?.[1];
    if (testType === "test_suite") {
      // Expand test_suite to show contained tests
      const config = new ConfigurationService();
      await resolveTestSuiteChildren(testItem, controller, bazelClient, config);
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

/**
 * Resolve test_suite children by expanding the suite to show contained tests
 */
async function resolveTestSuiteChildren(
  suiteItem: vscode.TestItem,
  controller: vscode.TestController,
  bazelClient: BazelClient,
  config: ConfigurationService
): Promise<void> {
  try {
    const workspacePath = await findBazelWorkspace();
    if (!workspacePath) {
      logWithTimestamp(`No Bazel workspace found for expanding suite ${suiteItem.id}`);
      return;
    }

    logWithTimestamp(`Expanding test_suite: ${suiteItem.id}...`);
    suiteItem.busy = true;

    try {
      const tests = await expandTestSuite(suiteItem.id, workspacePath, config);
      
      for (const testLabel of tests) {
        const metadata = bazelClient.getTargetMetadata(testLabel);
        const childLabel = metadata 
          ? `[${metadata.type}] ${testLabel.split(':').pop() || testLabel}`
          : testLabel;
        
        const childItem = controller.createTestItem(testLabel, childLabel);
        childItem.canResolveChildren = false;
        childItem.description = `Target: ${testLabel}`;
        suiteItem.children.add(childItem);
      }
      
      logWithTimestamp(`Suite ${suiteItem.id} expanded: ${tests.length} tests`);
    } finally {
      suiteItem.busy = false;
    }
  } catch (error) {
    const message = formatError(error);
    logWithTimestamp(`Failed to expand test_suite ${suiteItem.id}: ${message}`, 'error');
    suiteItem.busy = false;
  }
}

// Source utilities are now provided by src/explorer/sourceUtils.ts
