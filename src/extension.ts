/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import * as vscode from 'vscode';
import { initializeLogger, logWithTimestamp, formatError, measure } from './logging';
import { findBazelWorkspace } from './bazel/workspace';
import { BazelClient } from './bazel/client';
import { discoverAndDisplayTests } from './explorer/testTree';
import { showTestMetadataById } from './explorer/testInfoPanel';
import { ConfigurationService } from './configuration';

let bazelTestController: vscode.TestController;
let metadataListenerRegistered = false;
let bazelClient: BazelClient;
let configurationService: ConfigurationService;

export async function activate(context: vscode.ExtensionContext) {
	initializeLogger();

	const extensionVersion = vscode.extensions.getExtension("tragisch.bazel-testexplorer")?.packageJSON.version;
	logWithTimestamp(`Bazel Test Explorer v${extensionVersion} aktiviert.`);
	logWithTimestamp(`Bazel Test Explorer -- simplify architcture ---.`);

	const workspaceRoot = await findBazelWorkspace();
	if (!workspaceRoot) {
		vscode.window.showErrorMessage('No Bazel workspace found in the current directory');
		return;
	}

	configurationService = new ConfigurationService();
	bazelClient = new BazelClient(workspaceRoot, configurationService);

	const validation = await bazelClient.validate();
	if (!validation.valid) {
		vscode.window.showErrorMessage(`Bazel not available: ${validation.error}`);
		return;
	}
	logWithTimestamp(`Bazel validated: ${validation.version || 'OK'}`);

	bazelTestController = vscode.tests.createTestController('bazelUnityTestController', 'Bazel Unity Tests');
	context.subscriptions.push(bazelTestController);

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
						await discoverAndDisplayTests(bazelTestController, bazelClient);
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
			showTestMetadataById(testItem?.id, bazelClient);
		})
	);

	context.subscriptions.push(
		vscode.window.onDidChangeWindowState((windowState) => {
			if (windowState.focused) {
				logWithTimestamp("🔄 Window focus regained, reloading Bazel tests...");
				vscode.commands.executeCommand("extension.reloadBazelTests");
			}
		})
	);

	bazelTestController.createRunProfile('Run Tests', vscode.TestRunProfileKind.Run, async (request, token) => {
		const run = bazelTestController.createTestRun(request);
		const sequentialTypes: string[] = configurationService.sequentialTestTypes;

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
				const promise = bazelClient.runTest(t, run, token);
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
				await discoverAndDisplayTests(bazelTestController, bazelClient);
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
					await discoverAndDisplayTests(bazelTestController, bazelClient);
				}
			);
		}
	});
}

export function deactivate() { }

export { findBazelWorkspace };
