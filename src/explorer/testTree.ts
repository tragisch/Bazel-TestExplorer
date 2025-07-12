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
import { queryBazelTestTargets } from '../bazel/queries';
import { getWorkspaceOrShowError } from '../bazel/workspace';
import { logWithTimestamp, measure, formatError } from '../logging';
import { showTestMetadataById } from './testInfoPanel';

let isDiscoveringTests = false;

export const discoverAndDisplayTests = async (
  controller: vscode.TestController
): Promise<void> => {
  if (isDiscoveringTests) {
    logWithTimestamp("Already discovering tests. Skipping.");
    return;
  }
  isDiscoveringTests = true;
  try {
    const packageItemCache = new Map<string, vscode.TestItem>();
    const workspacePath = await getWorkspaceOrShowError();
    if (!workspacePath) return;

    const testEntries = await measure("Query Bazel test targets", () =>
      queryBazelTestTargets(workspacePath)
    );

    const currentTestIds = new Set(testEntries.map(entry => entry.target));
    controller.items.forEach((item) => {
      const id = item.id;
      const hasLiveChildren = Array.from(item.children).some(([childId]) =>
        currentTestIds.has(childId)
      );
      if (!currentTestIds.has(id) && !hasLiveChildren) {
        logWithTimestamp(`Removing stale test item: ${id}`);
        controller.items.delete(id);
      }
    });

    testEntries
      .sort((a, b) => {
        const aIsSuite = a.type === "test_suite" ? -1 : 0;
        const bIsSuite = b.type === "test_suite" ? -1 : 0;
        return aIsSuite - bIsSuite || a.target.localeCompare(b.target);
      })
      .forEach(({ target, type, tags }) => {
        addTestItemToController(controller, target, type, tags ?? [], packageItemCache);
      });

    const newTestIds: string[] = [];
    controller.items.forEach((item) => {
      newTestIds.push(item.id);
    });

    if (
      newTestIds.length !== currentTestIds.size ||
      !newTestIds.every((id) => currentTestIds.has(id))
    ) {
      const maxDisplayCount = 10;
      const displayedTestIds = newTestIds.slice(0, maxDisplayCount);
      const additionalCount = newTestIds.length - maxDisplayCount;

      logWithTimestamp(
        `Registered test targets:\n ${displayedTestIds.join("\n ")}${additionalCount > 0 ? `\n ...and ${additionalCount} more.` : ""
        }`
      );
    }
  } catch (error) {
    const message = formatError(error);
    vscode.window.showErrorMessage(`❌ Failed to discover tests:\n${message}`);
    logWithTimestamp(`❌ Error in discoverAndDisplayTests:\n${message}`);
  } finally {
    isDiscoveringTests = false;
  }
};

export const addTestItemToController = (
  controller: vscode.TestController,
  target: string,
  testType: string,
  tags: string[],
  packageItemCache: Map<string, vscode.TestItem>
): void => {
  const [packageName, testName] = target.includes(":")
    ? target.split(":")
    : [target, target];

  const formatPackageLabel = (bazelPath: string): { label: string; tooltip: string } => {
    const withoutSlashes = bazelPath.replace(/^\/\//, "");
    const parts = withoutSlashes.split('/');
    const root = parts[0] || '';
    const tail = parts.slice(-2).join('/');
    const tooltip = `//${withoutSlashes}`;
    return { label: `${root}: ${tail}`, tooltip };
  };

  let packageItem = packageItemCache.get(packageName);
  if (!packageItem) {
    const { label, tooltip } = formatPackageLabel(packageName);
    packageItem = controller.createTestItem(packageName, `📦 ${label}`);
    packageItem.description = tooltip;
    controller.items.add(packageItem);
    packageItemCache.set(packageName, packageItem);
  }

  const testTypeLabel = `[${testType}]`;
  const guessedFilePath = path.join(
    vscode.workspace.workspaceFolders?.[0].uri.fsPath || '',
    packageName.replace(/^\/\//, ''),
    `${testName}.c`
  );
  const uri = fs.existsSync(guessedFilePath)
    ? vscode.Uri.file(guessedFilePath)
    : undefined;

  const icon = testType === "test_suite" ? "🧪" : "";
  const testItem = controller.createTestItem(target, `${icon} ${testTypeLabel} ${testName}`, uri);
  packageItem.children.add(testItem);

  testItem.busy = false;
  testItem.canResolveChildren = false;

  // Add command to show metadata when selected
  testItem.tags = ["bazel", ...(tags || [])].map(t => new vscode.TestTag(t));
  testItem.description = `Target: ${target}`;

  // Define the missing command
  const command = {
    command: "bazelTestExplorer.showTestMetadata",
    title: "Bazel-TestExplorer: Show Metadata for Test Target"
  };
}