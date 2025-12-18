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

export async function activate(context: vscode.ExtensionContext) {
	initializeLogger();

	const extensionVersion = vscode.extensions.getExtension("tragisch.bazel-testexplorer")?.packageJSON.version;
	logWithTimestamp(`Bazel Test Explorer v${extensionVersion} aktiviert.`);

	const workspaceRoot = await findBazelWorkspace();
	if (!workspaceRoot) {
		// silently stop activation in non-Bazel workspaces to avoid noisy popups
		logWithTimestamp('No Bazel workspace detected. Extension remains idle.');
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
	const tree = vscode.window.createTreeView('bazelTestExplorer.history', { treeDataProvider: historyProvider });
	context.subscriptions.push(tree);

	// Status bar: show count of recent failures and total entries
	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBar.command = 'bazelTestExplorer.showTestHistory';
	context.subscriptions.push(statusBar);

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
			const detail = `Test: ${entry.testId}\nStatus: ${entry.type}\nDuration: ${entry.durationMs ?? '-'} ms\n\n${typeof entry.message === 'string' ? entry.message : (entry.message?.value ?? '')}`;
			const pick = await vscode.window.showInformationMessage(detail, 'Rerun');
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
