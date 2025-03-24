

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { queryBazelTestTargets } from '../bazel/queries';
import { getWorkspaceOrShowError } from '../bazel/workspace';
import { logWithTimestamp, measure, formatError } from '../logging';

export const discoverAndDisplayTests = async (
  controller: vscode.TestController
): Promise<void> => {
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

    testEntries.forEach(({ target, type }) => {
      addTestItemToController(controller, target, type, packageItemCache);
    });

    const newTestIds: string[] = [];
    controller.items.forEach((item) => {
      newTestIds.push(item.id);
    });

    if (
      newTestIds.length !== currentTestIds.size ||
      !newTestIds.every((id) => currentTestIds.has(id))
    ) {
      logWithTimestamp(`Registered test targets: ${newTestIds.join("\n")}`);
    }
  } catch (error) {
    const message = formatError(error);
    vscode.window.showErrorMessage(`❌ Failed to discover tests:\n${message}`);
    logWithTimestamp(`❌ Error in discoverAndDisplayTests:\n${message}`);
  }
};

export const addTestItemToController = (
  controller: vscode.TestController,
  target: string,
  testType: string,
  packageItemCache: Map<string, vscode.TestItem>
): void => {
  const [packageName, testName] = target.includes(":")
    ? target.split(":")
    : [target, target];

  let packageItem = packageItemCache.get(packageName);
  if (!packageItem) {
    const label = `📦 ${packageName.replace(/^\/\//, "")}`;
    packageItem = controller.createTestItem(packageName, label);
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

  const testItem = controller.createTestItem(target, `${testTypeLabel} ${testName}`, uri);
  packageItem.children.add(testItem);
  testItem.canResolveChildren = false;
};