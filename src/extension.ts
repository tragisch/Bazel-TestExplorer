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
import * as cp from 'child_process';
import { initializeLogger, logWithTimestamp, measure, formatError, disposeLogger } from './logging';
import { findBazelWorkspace, getCachedWorkspace } from './bazel/workspace';
import { BazelClient } from './bazel/client';
import { ConfigurationService } from './configuration';
import { TestControllerManager } from './explorer/controller';
import { TestObserver } from './explorer/tree';
import TestHistoryProvider from './explorer/testHistoryProvider';
import TestSettingsView from './explorer/testSettingsView';
import { onDidTestEvent, disposeEventBus } from './explorer/events';
import { TestCaseAnnotations, TestCaseCodeLensProvider, TestCaseHoverProvider } from './explorer/annotations';
import { TestCaseInsights } from './explorer/panel';
import { showCombinedTestPanel } from './explorer/panel';
import { initializeCoverageState, disposeCoverageState } from './coverage/state';
import { createCoverageCommandHandler } from './coverage/commands';
import { cancelAllBazelProcesses } from './infrastructure/process';

export async function activate(context: vscode.ExtensionContext) {
	initializeLogger();
	initializeCoverageState(context.workspaceState);

	const extensionVersion = vscode.extensions.getExtension("tragisch.bazel-testexplorer")?.packageJSON?.version as string | undefined;
	logWithTimestamp(`Bazel Test Explorer v${extensionVersion ?? 'unknown'} aktiviert.`);

	// Verbose activation diagnostics to help track view registration issues (opt-in)
	const enableActivationDiagnostics = vscode.workspace.getConfiguration('bazelTestExplorer').get('verboseViewRegistrationLogging') === true || process.env['VSCODE_DEV'] === 'true';
	if (enableActivationDiagnostics) {
		try {
		// Log host VS Code and UI kind to help debug when views/containers
		logWithTimestamp(`Host VS Code version: ${vscode.version}, uiKind: ${vscode.env.uiKind}`);

		const pkg = (context.extension?.packageJSON ?? vscode.extensions.getExtension('tragisch.bazel-testexplorer')?.packageJSON) as
			{ contributes?: { viewsContainers?: unknown; views?: unknown; commands?: Array<{ command: string }> } } | undefined;

		// Log which extension path is actually used in the Extension Dev Host
		try {
			const extPath = context.extension?.extensionPath ?? vscode.extensions.getExtension('tragisch.bazel-testexplorer')?.extensionPath;
			logWithTimestamp(`Extension path: ${extPath}`);
			if (extPath) {
				const packageJsonPath = path.join(extPath, 'package.json');
				if (fs.existsSync(packageJsonPath)) {
					const raw = fs.readFileSync(packageJsonPath, 'utf8');
					try {
						const parsed = JSON.parse(raw) as { contributes?: { views?: unknown; viewsContainers?: unknown } };
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
			logWithTimestamp(`Contributes.commands: ${JSON.stringify(Array.isArray(pkg.contributes.commands) ? pkg.contributes.commands.map((c) => c.command) : pkg.contributes.commands ?? {})}`);
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
		vscode.commands.executeCommand('setContext', 'bazelTestExplorer.workspaceAvailable', false);
		return;
	}

	// Signal to VS Code that a Bazel workspace is available (used for view visibility)
	vscode.commands.executeCommand('setContext', 'bazelTestExplorer.workspaceAvailable', true);

	// Log current verbose/debug settings once workspace detected
	try {
		const cfg = vscode.workspace.getConfiguration('bazelTestExplorer');
		const verboseViewLogging = cfg.get('verboseViewRegistrationLogging') === true;
		const discoveryLogging = cfg.get('enableTestCaseDiscovery') === true;
		const envDebug = process.env.BAZEL_TESTEXPLORER_DEBUG === '1';
		logWithTimestamp(`Logging status: verboseViewRegistrationLogging=${verboseViewLogging}, enableTestCaseDiscovery=${discoveryLogging}, BAZEL_TESTEXPLORER_DEBUG=${envDebug}`);
	} catch (e) {
		// ignore config read errors
	}

	const configurationService = new ConfigurationService();
	const bazelClient = new BazelClient(workspaceRoot, configurationService);
	
	// Register BazelClient for disposal to cleanup cache resources
	context.subscriptions.push({ dispose: () => bazelClient.dispose() });

	const validation = await bazelClient.validate();
	if (!validation.valid) {
		vscode.window.showErrorMessage(`Bazel not available: ${validation.error}`);
		return;
	}
	logWithTimestamp(`Bazel validated: ${validation.version || 'OK'}`);

	// TestControllerManager orchestrates all test-related operations
	const testCaseAnnotations = new TestCaseAnnotations();
	const testCaseInsights = new TestCaseInsights();
	context.subscriptions.push(testCaseAnnotations);

	const testManager = new TestControllerManager(bazelClient, configurationService, context, testCaseAnnotations, testCaseInsights);
	testManager.initialize();

	const coverageOutput = vscode.window.createOutputChannel('Coverage');
	context.subscriptions.push(coverageOutput);

	// Observer for collecting runtimes and small in-memory history
	const testObserver = new TestObserver(context);
	context.subscriptions.push(testObserver);

	// Tree view for history (Testing + Explorer fallback)
	const historyProvider = new TestHistoryProvider(testObserver);
	try {
		const tree = vscode.window.createTreeView('bazelTestExplorer.history', { treeDataProvider: historyProvider });
		context.subscriptions.push(tree);
		logWithTimestamp('Registered tree view: bazelTestExplorer.history');
	} catch (err) {
		logWithTimestamp(`Failed to create tree view 'bazelTestExplorer.history': ${formatError(err)}`, 'error');
		vscode.window.showErrorMessage("Failed to initialize Bazel Test History view. See 'Bazel-Test-Logs' output for details.");
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
	statusBar.command = 'bazelTestExplorer.history.focus';
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
		if (e?.type === 'output') {return;} // skip per-line output events to avoid UI churn
		historyProvider.refresh();
		updateStatus();
	});
	context.subscriptions.push(testEventDisposable);

	// Commands for history items
	const codeLensProvider = new TestCaseCodeLensProvider(testCaseAnnotations);
	const hoverProvider = new TestCaseHoverProvider(testCaseAnnotations);
	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider),
		vscode.languages.registerHoverProvider({ scheme: 'file' }, hoverProvider),
		codeLensProvider
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('bazelTestExplorer.openHistoryItem', async (entry: { testId?: string; type?: string; durationMs?: number; message?: string | vscode.MarkdownString }) => {
			if (!entry) {return;}
			const body = typeof entry.message === 'string' ? entry.message : (entry.message?.value ?? '');
			const contentLines: string[] = [];
			contentLines.push(`--- Test: ${entry.testId} ---`);
			contentLines.push(`Status: ${entry.type}`);
			contentLines.push(`Duration: ${entry.durationMs ?? '-'} ms`);
			contentLines.push('');
			if (body) {contentLines.push(body);}
			const content = contentLines.join('\n');
			const doc = await vscode.workspace.openTextDocument({ content, language: 'text' });
			await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
			const pick = await vscode.window.showInformationMessage('Opened test log in editor', 'Rerun');
			if (pick === 'Rerun') {
				void vscode.commands.executeCommand('bazelTestExplorer.rerunTestFromHistory', entry.testId);
			}
		}),

		vscode.commands.registerCommand('bazelTestExplorer.rerunTestFromHistory', async (testId: string) => {
			if (!testId) {return;}
			try {
				await testManager.runTestsByIds([testId]);
			} catch (err) {
				void vscode.window.showErrorMessage('Failed to rerun test from history');
			}
		}),

		vscode.commands.registerCommand('bazelTestExplorer.runTestCase', async (testId: string) => {
			if (!testId) {
				return;
			}
			await testManager.runTestsByIds([testId]);
		}),

		vscode.commands.registerCommand('bazelTestExplorer.showTestDetails', async (testItem: vscode.TestItem) => {
			if (!testItem) {
				void vscode.window.showInformationMessage('Please select a test item in the Testing view.');
				return;
			}
			await showCombinedTestPanel(testItem.id, bazelClient, testCaseInsights, context);
		}),

		vscode.commands.registerCommand('bazelTestExplorer.showCoverageDetails', createCoverageCommandHandler({
			workspaceRoot,
			configurationService,
			testManager,
			coverageOutput,
			extensionPath: context.extensionPath
		}))
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('bazelTestExplorer.cancelAllRuns', async () => {
			try {
				logWithTimestamp('User requested to cancel all Bazel runs...');
				
				// First, kill all tracked Bazel processes
				const { killed, failed } = await cancelAllBazelProcesses();
				
				// Then, shut down the Bazel server to ensure no background activities remain
				if (killed > 0 || failed > 0) {
					logWithTimestamp('Shutting down Bazel server...');
					try {
						const shutdownProc = cp.spawn(configurationService.bazelPath, ['shutdown'], {
							cwd: workspaceRoot,
							stdio: 'ignore'
							// Note: No timeout option here - we handle it manually below
						});
						
						await new Promise<void>((resolve) => {
							let settled = false;
							let timer: NodeJS.Timeout | undefined;
							
							const cleanup = () => {
								if (timer) {
									clearTimeout(timer);
									timer = undefined;
								}
								shutdownProc.removeAllListeners('close');
								shutdownProc.removeAllListeners('error');
							};
							
							const finish = () => {
								if (settled) {
									return;
								}
								settled = true;
								cleanup();
								resolve();
							};
							
							timer = setTimeout(() => {
								if (shutdownProc.exitCode === null && shutdownProc.signalCode === null) {
									shutdownProc.kill('SIGKILL');
								}
								finish();
							}, 10_000);
							
							shutdownProc.on('close', finish);
							shutdownProc.on('error', finish);
						});
						
						logWithTimestamp('Bazel server shutdown completed.');
					} catch (err) {
						logWithTimestamp(`Failed to shutdown Bazel server: ${err}`, 'warn');
					}
				}
				
				// Provide user feedback
				if (killed > 0) {
					const message = failed > 0 
						? `Stopped ${killed} Bazel process(es). ${failed} failed to terminate.`
						: `Successfully stopped ${killed} Bazel process(es).`;
					void vscode.window.showInformationMessage(message);
				} else if (failed > 0) {
					void vscode.window.showWarningMessage(`Failed to stop ${failed} Bazel process(es).`);
				} else {
					void vscode.window.showInformationMessage('No running Bazel processes to stop.');
				}
			} catch (err) {
				logWithTimestamp(`Error during cancelAllRuns: ${err}`, 'error');
				void vscode.window.showErrorMessage(`Failed to cancel Bazel runs: ${err}`);
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

export function deactivate() {
	disposeEventBus();
	disposeCoverageState();
	disposeLogger();
	vscode.commands.executeCommand('setContext', 'bazelTestExplorer.workspaceAvailable', false);
}

export { findBazelWorkspace, getCachedWorkspace };
