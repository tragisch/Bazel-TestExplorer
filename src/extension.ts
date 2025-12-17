/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/**
 * Extension entry point - initializes and activates the Bazel test explorer
 */

import * as vscode from 'vscode';
import { initializeLogger, logWithTimestamp, measure } from './logging';
import { findBazelWorkspace } from './bazel/workspace';
import { BazelClient } from './bazel/client';
import { ConfigurationService } from './configuration';
import { TestControllerManager } from './explorer/testControllerManager';
import { TestObserver } from './explorer/testObserver';
import TestHistoryProvider from './explorer/testHistoryProvider';
import { onDidTestEvent } from './explorer/testEventBus';
import TestSettingsView from './explorer/testSettingsView';

export async function activate(context: vscode.ExtensionContext) {
	initializeLogger();

	const extensionVersion = vscode.extensions.getExtension("tragisch.bazel-testexplorer")?.packageJSON.version;
	logWithTimestamp(`Bazel Test Explorer v${extensionVersion} aktiviert.`);

	const workspaceRoot = await findBazelWorkspace();
	if (!workspaceRoot) {
		vscode.window.showErrorMessage('No Bazel workspace found in the current directory');
		return;
	}

	const configurationService = new ConfigurationService();
	const bazelClient = new BazelClient(workspaceRoot, configurationService);

	const validation = await bazelClient.validate();
	if (!validation.valid) {
		vscode.window.showErrorMessage(`Bazel not available: ${validation.error}`);
		return;
	}
	logWithTimestamp(`Bazel validated: ${validation.version || 'OK'}`);

	// TestControllerManager orchestrates all test-related operations
	const testManager = new TestControllerManager(bazelClient, configurationService, context);
	testManager.initialize();

	// Observer for collecting runtimes and small in-memory history
	const testObserver = new TestObserver(context);
	context.subscriptions.push(testObserver);

	// Tree view for history
	const historyProvider = new TestHistoryProvider(testObserver);
	try {
		const tree = vscode.window.createTreeView('bazelTestExplorer.history', { treeDataProvider: historyProvider });
		context.subscriptions.push(tree);
		logWithTimestamp('Registered tree view: bazelTestExplorer.history');
	} catch (err) {
		logWithTimestamp(`Failed to create tree view 'bazelTestExplorer.history': ${formatError(err)}`, 'error');
		vscode.window.showErrorMessage("Failed to initialize Bazel Test History view. See 'Bazel-Test-Logs' output for details.");
	}

	// Settings view in the Testing sidebar (Webview)
	const settingsProvider = new TestSettingsView(configurationService, context);
	context.subscriptions.push(vscode.window.registerWebviewViewProvider(TestSettingsView.viewType, settingsProvider));

	// Status bar: show count of recent failures and total entries
	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBar.command = 'bazelTestExplorer.showTestHistory';
	context.subscriptions.push(statusBar);

	// Note: logs are opened in a readonly text editor tab when requested

	const updateStatus = () => {
 		const history = testObserver.getHistory();
 		const failed = history.filter(h => h.type === 'failed').length;
 		statusBar.text = `Bazel Tests: ${failed} failed — ${history.length} recent`;
 		statusBar.show();
	};

	// refresh on events (but ignore high-volume 'output' events)
	const testEventDisposable = onDidTestEvent((e) => {
		if (e?.type === 'output') return; // skip per-line output events to avoid UI churn
		historyProvider.refresh();
		updateStatus();
	});
	context.subscriptions.push(testEventDisposable);

	// Commands for history items
	context.subscriptions.push(
		vscode.commands.registerCommand('bazelTestExplorer.openHistoryItem', async (entry: any) => {
			if (!entry) return;
			const body = typeof entry.message === 'string' ? entry.message : (entry.message?.value ?? '');
			const contentLines: string[] = [];
			contentLines.push(`--- Test: ${entry.testId} ---`);
			contentLines.push(`Status: ${entry.type}`);
			contentLines.push(`Duration: ${entry.durationMs ?? '-'} ms`);
			contentLines.push('');
			if (body) contentLines.push(body);
			const content = contentLines.join('\n');
			const doc = await vscode.workspace.openTextDocument({ content, language: 'text' });
			await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
			const pick = await vscode.window.showInformationMessage('Opened test log in editor', 'Rerun');
			if (pick === 'Rerun') {
				void vscode.commands.executeCommand('bazelTestExplorer.rerunTestFromHistory', entry.testId);
			}
		}),

		vscode.commands.registerCommand('bazelTestExplorer.rerunTestFromHistory', async (testId: string) => {
			if (!testId) return;
			try {
				await testManager.runTestsByIds([testId]);
			} catch (err) {
				void vscode.window.showErrorMessage('Failed to rerun test from history');
			}
		})
	);

	// initial update
	updateStatus();

	// Initiales Test-Discovery
	await measure("Discover and display tests", async () => {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Window,
				title: "Bazel Test Explorer",
				cancellable: false
			},
			async (progress) => {
				await testManager.discover(progress);
			}
		);
	});
}

export function deactivate() { }

export { findBazelWorkspace };
