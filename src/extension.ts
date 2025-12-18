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
import * as fs from 'fs';
import * as path from 'path';
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

	// Verbose activation diagnostics to help track view registration issues (opt-in)
	const enableActivationDiagnostics = vscode.workspace.getConfiguration('bazelTestExplorer').get('verboseViewRegistrationLogging') === true || process.env['VSCODE_DEV'] === 'true';
	if (enableActivationDiagnostics) {
		try {
		// Log host VS Code and UI kind to help debug when views/containers
		logWithTimestamp(`Host VS Code version: ${vscode.version}, uiKind: ${vscode.env.uiKind}`);

		const pkg = (context.extension && (context.extension.packageJSON as any)) ?? vscode.extensions.getExtension('tragisch.bazel-testexplorer')?.packageJSON as any | undefined;

		// Log which extension path is actually used in the Extension Dev Host
		try {
			const extPath = context.extension?.extensionPath ?? vscode.extensions.getExtension('tragisch.bazel-testexplorer')?.extensionPath;
			logWithTimestamp(`Extension path: ${extPath}`);
			if (extPath) {
				const packageJsonPath = path.join(extPath, 'package.json');
				if (fs.existsSync(packageJsonPath)) {
					const raw = fs.readFileSync(packageJsonPath, 'utf8');
					try {
						const parsed = JSON.parse(raw) as any;
						logWithTimestamp(`On-disk package.json contributes.views: ${JSON.stringify(parsed.contributes?.views ?? {})}`);
						logWithTimestamp(`On-disk package.json viewsContainers: ${JSON.stringify(parsed.contributes?.viewsContainers ?? {})}`);
					} catch (e) {
						logWithTimestamp(`Failed parsing on-disk package.json: ${String(e)}`, 'warn');
					}
				} else {
					logWithTimestamp(`No package.json found at extension path: ${packageJsonPath}`, 'warn');
				}
			}
		} catch (e) {
			logWithTimestamp(`Failed to read extension package.json on-disk: ${String(e)}`, 'warn');
		}
		if (pkg?.contributes) {
			logWithTimestamp(`Contributes.viewsContainers: ${JSON.stringify(pkg.contributes.viewsContainers ?? {})}`);
			logWithTimestamp(`Contributes.views: ${JSON.stringify(pkg.contributes.views ?? {})}`);
			logWithTimestamp(`Contributes.commands: ${JSON.stringify(Object.keys(pkg.contributes.commands ?? {}).length ? pkg.contributes.commands.map((c:any)=>c.command) : pkg.contributes.commands ?? {})}`);
		} else {
			logWithTimestamp('No contributes section found in package.json', 'warn');
		}

		// Check for availability of key workbench commands
		vscode.commands.getCommands(true).then((cmds) => {
			const interesting = [
				'workbench.view.extension.bazelTestExplorer',
				'workbench.views.openView',
				'workbench.view.testing',
				'workbench.view.explorer'
			];
			interesting.forEach(c => logWithTimestamp(`Command available: ${c} -> ${cmds.includes(c)}`));
			// also log a short list of workbench.view.* commands present
			const workbenchViewCommands = cmds.filter(x => x.startsWith('workbench.view.')).slice(0,50);
			logWithTimestamp(`Found workbench.view.* commands (sample up to 50): ${JSON.stringify(workbenchViewCommands)}`);
		});
		} catch (err) {
			logWithTimestamp(`Activation diagnostics failed: ${err}`, 'warn');
		}
	}

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

	// Tree view for history (Testing + Explorer fallback)
	const historyProvider = new TestHistoryProvider(testObserver);
	const historyViewIds = ['bazelTestExplorer.history', 'bazelTestExplorer.history.explorer'];
	for (const viewId of historyViewIds) {
		try {
			const tree = vscode.window.createTreeView(viewId, { treeDataProvider: historyProvider });
			context.subscriptions.push(tree);
			logWithTimestamp(`Registered tree view: ${viewId}`);
		} catch (err) {
			logWithTimestamp(`Failed to create tree view '${viewId}': ${formatError(err)}`, 'error');
			vscode.window.showErrorMessage("Failed to initialize Bazel Test History view. See 'Bazel-Test-Logs' output for details.");
		}
	}

	// Settings view in the Testing sidebar (Webview) + Explorer fallback
	const settingsViewIds = [TestSettingsView.viewType, TestSettingsView.explorerViewType];
	const settingsProvider = new TestSettingsView(configurationService, context);
	for (const viewId of settingsViewIds) {
		try {
			context.subscriptions.push(vscode.window.registerWebviewViewProvider(viewId, settingsProvider));
			logWithTimestamp(`Registered webview view: ${viewId}`);
		} catch (err) {
			logWithTimestamp(`Failed to register webview view '${viewId}': ${formatError(err)}`, 'error');
		}
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
		// Try to show an appropriate container if available; avoid calling removed commands
		try {
			const cmds = await vscode.commands.getCommands(true);
			if (cmds.includes('workbench.view.extension.bazel-test-explorer')) {
				await vscode.commands.executeCommand('workbench.view.extension.bazel-test-explorer');
			} else if (cmds.includes('workbench.view.testing')) {
				await vscode.commands.executeCommand('workbench.view.testing');
			} else if (cmds.includes('workbench.view.explorer')) {
				await vscode.commands.executeCommand('workbench.view.explorer');
			}
		} catch (e) {
			// ignore failures — this is a best-effort UI hint
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
		<label>Bazel flags (comma separated):</label>
    <input id="bazelFlags" type="text" placeholder="--test_output=errors, --build_tests_only" />
    <div><button id="save">Save</button></div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
		const initial = ${JSON.stringify(settingsPayload)};
      document.getElementById('bazelFlags').value = (initial.bazelFlags || []).join(', ');

      window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.command === 'updated') {
          // simple ack
        }
      });

      document.getElementById('save').addEventListener('click', () => {
		const flags = document.getElementById('bazelFlags').value.split(',').map(s => s.trim()).filter(Boolean);
		vscode.postMessage({ command: 'setSetting', payload: { key: 'bazelFlags', value: flags } });
      });
    </script>
  </body>
</html>`;

		panel.webview.onDidReceiveMessage(async (msg) => {
			const workspaceConfig = vscode.workspace.getConfiguration('bazelTestExplorer');
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
