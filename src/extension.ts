/*
MIT License

Copyright (c) 2025 @tragisch

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights 
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is 
furnished to do so, subject to the following conditions:

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL 
THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN 
THE SOFTWARE.
*/

import * as vscode from 'vscode';
import { initializeLogger, logWithTimestamp, formatError, measure } from './logging';
import { findBazelWorkspace } from './bazel/workspace';
import { queryBazelTestTargets } from './bazel/queries';
import { executeBazelTest } from './bazel/runner';
import { discoverAndDisplayTests } from './explorer/testTree';
import { showTestMetadataById } from './explorer/testInfoPanel';

let bazelTestController: vscode.TestController;
let metadataListenerRegistered = false;

export function activate(context: vscode.ExtensionContext) {
	initializeLogger();

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
			// Optional: Metadaten anzeigen
			showTestMetadataById(testItem?.id);
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