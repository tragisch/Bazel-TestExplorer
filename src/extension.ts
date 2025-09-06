/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { initializeLogger, logWithTimestamp, formatError, measure } from './logging';
import { findBazelWorkspace } from './bazel/workspace';
import { queryBazelTestTargets } from './bazel/queries';
import { executeBazelTest, discoverIndividualTestCases } from './bazel/runner';
import { discoverAndDisplayTests } from './explorer/testTree';
import { showTestMetadataById } from './explorer/testInfoPanel';

let bazelTestController: vscode.TestController;
let metadataListenerRegistered = false;

export function activate(context: vscode.ExtensionContext) {
	initializeLogger();

	const extensionVersion = vscode.extensions.getExtension("tragisch.bazel-testexplorer")?.packageJSON.version;
	logWithTimestamp(`Bazel Test Explorer v${extensionVersion} aktiviert.`);

	bazelTestController = vscode.tests.createTestController('bazelUnityTestController', 'Bazel Unity Tests');
	context.subscriptions.push(bazelTestController);

	bazelTestController.resolveHandler = async (item) => {
		if (!item) {
			// Root discovery - discover all test targets
			await discoverAndDisplayTests(bazelTestController);
			return;
		}

		// Individual test case discovery for a specific test item
		const workspacePath = await findBazelWorkspace();
		if (!workspacePath) {
			logWithTimestamp("No Bazel workspace found during resolve");
			return;
		}

		// Only resolve children for non-test_suite targets
		const typeMatch = item.label.match(/\[(.*?)\]/);
		const testType = typeMatch?.[1] ?? "";

		// Skip if children are already resolved
		if (item.children.size > 0) {
			logWithTimestamp(`Children already present for ${item.id}; skip discovery.`);
			return;
		}

		if (testType === "test_suite") {
			return; // Test suites don't have individual test cases
		}

		try {
			logWithTimestamp(`Resolving children for ${item.id}`);
			const result = await discoverIndividualTestCases(item.id, workspacePath, testType);

			// Add individual test cases as children
			for (const testCase of result.testCases) {
				const testCaseId = `${item.id}::${testCase.name}`;
				const existing = item.children.get(testCaseId);

				if (!existing) {
					const statusIcon = '🧪';  //testCase.status === 'FAIL' ? '❌' : testCase.status === 'PASS' ? '✅' : '🔘';
					const testCaseItem = bazelTestController.createTestItem(
						testCaseId,
						`${statusIcon} ${testCase.name}`,
						vscode.Uri.file(path.join(workspacePath, testCase.file))
					);

					testCaseItem.range = new vscode.Range(
						new vscode.Position(testCase.line - 1, 0),
						new vscode.Position(testCase.line - 1, 0)
					);

					testCaseItem.description = `Line ${testCase.line}`;
					testCaseItem.canResolveChildren = false;

					item.children.add(testCaseItem);
				}
			}
		} catch (error) {
			logWithTimestamp(`Failed to resolve children for ${item.id}: ${formatError(error)}`);
		}
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("extension.reloadBazelTests", async () => {
			logWithTimestamp("Reloading Bazel tests...");
			try {
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Window,
						title: "Bazel Test Explorer",
						cancellable: false
					},
					async (progress) => {
						progress.report({ message: "Querying Bazel tests..." });
						await discoverAndDisplayTests(bazelTestController);
					}
				);
			} catch (error) {
				const message = formatError(error);
				vscode.window.showErrorMessage(`❌ Reload failed:\n${message}`);
				logWithTimestamp(`❌ Error in reloadBazelTests:\n${message}`);
			}
		}),
		// Removed invalid object as it does not conform to the expected type
		vscode.commands.registerCommand('bazelTestExplorer.showSelectedTestMetadata', () => {
			vscode.window.showInformationMessage("Automatic selection detection not implemented. Please right-click a test and use 'Show Metadata'.");
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('bazelTestExplorer.showTestMetadata', (testItem: vscode.TestItem) => {
			vscode.window.showInformationMessage(`Clicked on test: ${testItem?.id}`);
			showTestMetadataById(testItem?.id);
		})
	);

	// Throttle focus-based reloads
	let lastReloadAt = 0;
	const RELOAD_DEBOUNCE_MS = 5000; // configurable later via settings
	let isDiscoveringTests = false; // Used for debounce
	context.subscriptions.push(
		vscode.window.onDidChangeWindowState((windowState) => {
			if (windowState.focused) {
				const now = Date.now();
				if (now - lastReloadAt < RELOAD_DEBOUNCE_MS || isDiscoveringTests) {
					logWithTimestamp("🔄 Window focus: debounce/skip reload.");
					return;
				}
				lastReloadAt = now;
				logWithTimestamp("🔄 Window focus regained, reloading Bazel tests...");
				vscode.commands.executeCommand("extension.reloadBazelTests");
			}
		})
	);

	bazelTestController.createRunProfile('Run Tests', vscode.TestRunProfileKind.Run, async (request, token) => {
		const run = bazelTestController.createTestRun(request);
		const workspacePath = await findBazelWorkspace();
		if (!workspacePath) {
			vscode.window.showErrorMessage("No Bazel workspace detected.");
			logWithTimestamp("No Bazel workspace detected.");
			return;
		}

		const config = vscode.workspace.getConfiguration("bazelTestRunner");
		const sequentialTypes: string[] = config.get("sequentialTestTypes", []);

		const collectAllTests = (item: vscode.TestItem): vscode.TestItem[] => {
			const collected: vscode.TestItem[] = [];
			const visit = (node: vscode.TestItem) => {
				if (node.children.size === 0) {
					collected.push(node);
				} else {
					node.children.forEach(visit);
				}
			};
			visit(item);
			return collected;
		};

		const promises: Promise<void>[] = [];

		for (const testItem of request.include ?? []) {
			const allTests = collectAllTests(testItem);
			for (const t of allTests) {
				run.started(t);
				const testTypeMatch = t.label.match(/^\[(.+?)\]/);
				const testType = testTypeMatch?.[1];
				const isSequential = sequentialTypes.includes(testType ?? "");
				const promise = executeBazelTest(t, workspacePath, run);
				if (isSequential) {
					await promise;
				} else {
					promises.push(promise);
				}
			}
		}

		await Promise.all(promises);

		run.end();
	}, true);

	measure("Discover and display tests", async () => {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Window,
				title: "Bazel Test Explorer",
				cancellable: false
			},
			async (progress) => {
				progress.report({ message: "Querying Bazel tests..." });
				await discoverAndDisplayTests(bazelTestController);
			}
		);
	});

	vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration("bazelTestRunner")) {
			logWithTimestamp("Configuration changed. Reloading tests...");
			vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Window,
					title: "Bazel Test Explorer",
					cancellable: false
				},
				async (progress) => {
					progress.report({ message: "Querying Bazel tests..." });
					await discoverAndDisplayTests(bazelTestController);
				}
			);
		}
	});
}

export function deactivate() { }

export { findBazelWorkspace };
