import * as vscode from 'vscode';
import { initializeLogger, logWithTimestamp, formatError, measure } from './logging';
import { findBazelWorkspace } from './bazel/workspace';
import { queryBazelTestTargets } from './bazel/queries';
import { executeBazelTest } from './bazel/runner';
import { discoverAndDisplayTests } from './explorer/testTree';

let bazelTestController: vscode.TestController;

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

	measure("Discover and display tests", () => discoverAndDisplayTests(bazelTestController));
}

export function deactivate() { }