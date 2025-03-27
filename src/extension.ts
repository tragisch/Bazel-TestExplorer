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
				await discoverAndDisplayTests(bazelTestController);
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

		for (const testItem of request.include ?? []) {
			run.started(testItem);
			await executeBazelTest(testItem, workspacePath, run);
		}

		run.end();
	}, true);

	measure("Discover and display tests", async () => {
		await discoverAndDisplayTests(bazelTestController);
	});

	vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration("bazelTestRunner")) {
			logWithTimestamp("Configuration changed. Reloading tests...");
			discoverAndDisplayTests(bazelTestController);
		}
	});
}

export function deactivate() { }