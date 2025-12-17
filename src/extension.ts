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
import { initializeLogger, logWithTimestamp, measure, formatError } from './logging';
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
	let historyTree: vscode.TreeView<any> | undefined;
	try {
		historyTree = vscode.window.createTreeView('bazelTestExplorer.history', { treeDataProvider: historyProvider });
		context.subscriptions.push(historyTree);
		logWithTimestamp('Registered tree view: bazelTestExplorer.history');
	} catch (err) {
		logWithTimestamp(`Failed to create tree view 'bazelTestExplorer.history': ${formatError(err)}`, 'error');
		vscode.window.showErrorMessage("Failed to initialize Bazel Test History view. See 'Bazel-Test-Logs' output for details.");
	}

	// Settings view in the Testing sidebar (Webview)
	try {
		const settingsProvider = new TestSettingsView(configurationService, context);
		context.subscriptions.push(vscode.window.registerWebviewViewProvider(TestSettingsView.viewType, settingsProvider));
		logWithTimestamp(`Registered webview view: ${TestSettingsView.viewType}`);
	} catch (err) {
		logWithTimestamp(`Failed to register webview view '${TestSettingsView.viewType}': ${formatError(err)}`, 'error');
	}

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

	// Command to open a standalone settings WebviewPanel (works regardless of Test Explorer integration)
	context.subscriptions.push(vscode.commands.registerCommand('bazelTestExplorer.openSettingsView', async () => {
		try {
			// open our activity-bar container
			await vscode.commands.executeCommand('workbench.view.extension.bazelTestExplorer');
		} catch (e) {
			// fallback: open Explorer
			try { await vscode.commands.executeCommand('workbench.view.explorer'); } catch { /* ignore */ }
		}

		// also open a standalone panel as fallback to ensure settings are reachable
		const panel = vscode.window.createWebviewPanel(
			'bazelTestExplorer.settingsPanel',
			'Bazel Test Settings',
			vscode.ViewColumn.Active,
			{ enableScripts: true }
		);

		const nonce = Date.now().toString(36);
		const settingsPayload = {
			flaky: configurationService.flaky,
			retryCount: configurationService.retryCount,
			bazelFlags: configurationService.bazelFlags
		};

		panel.webview.html = `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); }
      label { display:block; margin: 8px 0; }
      input[type="text"] { width: 100%; }
      .flags { font-size: 0.9em; color: var(--vscode-descriptionForeground); }
      button { margin-top: 8px; }
    </style>
    <title>Bazel Test Settings</title>
  </head>
  <body>
    <h3>Bazel Test Settings</h3>
    <label><input id="flaky" type="checkbox"/> Treat flaky tests</label>
    <label>Retry count: <input id="retryCount" type="number" min="0" style="width:4em"/></label>
    <label>Bazel flags (comma separated):</label>
    <input id="bazelFlags" type="text" placeholder="--test_output=errors, --build_tests_only" />
    <div><button id="save">Save</button></div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const initial = ${JSON.stringify(settingsPayload)};
      document.getElementById('flaky').checked = !!initial.flaky;
      document.getElementById('retryCount').value = initial.retryCount ?? 1;
      document.getElementById('bazelFlags').value = (initial.bazelFlags || []).join(', ');

      window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.command === 'updated') {
          // simple ack
        }
      });

      document.getElementById('save').addEventListener('click', () => {
        const flaky = document.getElementById('flaky').checked;
        const retryCount = Number(document.getElementById('retryCount').value) || 0;
        const flags = document.getElementById('bazelFlags').value.split(',').map(s => s.trim()).filter(Boolean);
        vscode.postMessage({ command: 'setSetting', payload: { key: 'flaky', value: flaky } });
        vscode.postMessage({ command: 'setSetting', payload: { key: 'retryCount', value: retryCount } });
        vscode.postMessage({ command: 'setSetting', payload: { key: 'bazelFlags', value: flags } });
      });
    </script>
  </body>
</html>`;

		panel.webview.onDidReceiveMessage(async (msg) => {
			const workspaceConfig = vscode.workspace.getConfiguration('bazelTestRunner');
			switch (msg.command) {
				case 'setSetting': {
					try {
						const { key, value } = msg.payload;
						await workspaceConfig.update(key, value, vscode.ConfigurationTarget.Workspace);
						panel.webview.postMessage({ command: 'updated', payload: { key, value } });
					} catch (err) {
						panel.webview.postMessage({ command: 'error', payload: String(err) });
					}
					break;
				}
			}
		});
	}));

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
