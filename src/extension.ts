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
import TestSettingsView from './explorer/testSettingsView';
import { onDidTestEvent } from './explorer/testEventBus';
import { TestCaseAnnotations, TestCaseCodeLensProvider, TestCaseHoverProvider } from './explorer/testCaseAnnotations';
import { TestCaseInsights } from './explorer/testCaseInsights';
import { showCombinedTestPanel } from './explorer/combinedTestPanel';
import { parseLcovToFileCoverage, getCoverageDetailsForFile, demangleCoverageDetails } from './coverageVscode';
import { initializeCoverageState, setCoverageSummary } from './coverageState';
import { BazelCoverageRunner, resolveBazelInfo, findCoverageArtifacts, loadFirstValidLcov, extractLcovPathFromOutput, extractBazelBinExecPath, convertProfrawToLcov } from './bazelCoverage';
import { cancelAllBazelProcesses } from './bazel/process';

export async function activate(context: vscode.ExtensionContext) {
	initializeLogger();
	initializeCoverageState(context.workspaceState);

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
	const testCaseAnnotations = new TestCaseAnnotations();
	const testCaseInsights = new TestCaseInsights();
	context.subscriptions.push(testCaseAnnotations);

	const testManager = new TestControllerManager(bazelClient, configurationService, context, testCaseAnnotations, testCaseInsights);
	testManager.initialize();

	const coverageOutput = vscode.window.createOutputChannel('Coverage');
	context.subscriptions.push(coverageOutput);
	const applyCoverageSummary = (item: vscode.TestItem, coverages: vscode.FileCoverage[]) => {
		let covered = 0;
		let total = 0;
		for (const coverage of coverages) {
			covered += coverage.statementCoverage.covered;
			total += coverage.statementCoverage.total;
		}
		const percent = total === 0 ? 0 : (covered / total) * 100;
		item.description = `Coverage: ${percent.toFixed(2)}% (${covered}/${total} lines)`;
	};

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
		if (e?.type === 'output') return; // skip per-line output events to avoid UI churn
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

		vscode.commands.registerCommand('bazelTestExplorer.showCoverageDetails', async (items?: vscode.TestItem | vscode.TestItem[]) => {
			const selectedItems = Array.isArray(items)
				? items
				: items
					? [items]
					: [];
			const targetLabels = selectedItems.length > 0
				? selectedItems.map(item => item.id ?? item.label)
				: ['//demo:target'];

			coverageOutput.show(true);
			coverageOutput.appendLine(`[coverage] targets=${targetLabels.length}`);
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? workspaceRoot;
			const runner = new BazelCoverageRunner(coverageOutput);

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Bazel Coverage',
					cancellable: true
				},
				async (progress, token) => {
					const tryConvertLlvm = async (stdout: string, stderr: string, artifacts: { profraw: string[]; profdata: string[]; lcov: string[]; testlogs: string[] }, execrootPath?: string) => {
						if (artifacts.profraw.length === 0 && artifacts.profdata.length === 0) {
							return undefined;
						}
						const execPath = extractBazelBinExecPath(stdout + stderr);
						const bazelBin = await resolveBazelInfo(configurationService.bazelPath, workspaceRoot, 'bazel-bin', token);
						const binaryPath = execPath && bazelBin ? path.join(bazelBin, execPath.replace(/^bazel-bin\//, '')) : undefined;
						if (binaryPath && fs.existsSync(binaryPath)) {
							coverageOutput.appendLine(`[coverage] converting LLVM profile using ${binaryPath}`);
							const converted = await convertProfrawToLcov(artifacts.profraw, binaryPath, token);
							if (converted) {
								coverageOutput.appendLine(`[coverage] using llvm lcov=${converted.path}`);
								const convertedCoverages = parseLcovToFileCoverage(converted.content, workspaceFolder, context.extensionPath, execrootPath);
								if (convertedCoverages.length === 0) {
									coverageOutput.appendLine('[coverage] llvm lcov contained no files');
									return undefined;
								}
								await demangleCoverageDetails(configurationService.cppDemanglerPath, configurationService.rustDemanglerPath);
								return {
									coverages: convertedCoverages,
									artifacts: { ...artifacts, lcov: [...artifacts.lcov, converted.path] }
								};
							}
						} else {
							coverageOutput.appendLine('[coverage] LLVM profiles detected; llvm-cov/llvm-profdata may be missing or binary not found.');
						}
						return undefined;
					};
					for (const targetLabel of targetLabels) {
						if (token.isCancellationRequested) {
							coverageOutput.appendLine('[coverage] cancelled');
							break;
						}
						progress.report({ message: `Running coverage for ${targetLabel}` });
						coverageOutput.appendLine(`[coverage] run target=${targetLabel}`);
						const args = ['coverage', ...configurationService.coverageArgs, targetLabel];
						const result = await runner.runCoverage(
							{ bazelBinary: configurationService.bazelPath, args, workspaceRoot },
							token
						);
						if (result.code !== 0) {
							coverageOutput.appendLine(`[coverage] bazel coverage failed (code=${result.code}) for ${targetLabel}`);
							continue;
						}

						coverageOutput.appendLine('[coverage] locating artifacts');
						const execroot = await resolveBazelInfo(configurationService.bazelPath, workspaceRoot, 'execution_root', token);
						const testlogs = await resolveBazelInfo(configurationService.bazelPath, workspaceRoot, 'bazel-testlogs', token);
						const artifacts = await findCoverageArtifacts(
							[execroot, testlogs, workspaceRoot].filter(Boolean) as string[],
							token
						);
						coverageOutput.appendLine(
							`[coverage] artifacts lcov=${artifacts.lcov.length} profraw=${artifacts.profraw.length} profdata=${artifacts.profdata.length}`
						);

						const reportedLcov = extractLcovPathFromOutput(result.stdout + result.stderr);
						if (reportedLcov) {
							coverageOutput.appendLine(`[coverage] reported lcov=${reportedLcov}`);
						}
						const targetPath = targetLabel.replace(/^\/\//, '').replace(':', path.sep);
						const preferredRoot = testlogs ? path.join(testlogs, targetPath) : undefined;
						const preferredLcov = preferredRoot
							? artifacts.lcov.filter(file => file.startsWith(preferredRoot))
							: [];
						const lcovCandidates = reportedLcov
							? [reportedLcov, ...preferredLcov, ...artifacts.lcov]
							: (preferredLcov.length > 0 ? preferredLcov : artifacts.lcov);
						if (preferredLcov.length === 0) {
							coverageOutput.appendLine('[coverage] no target-specific LCOV found; falling back to latest valid LCOV.');
						}
						const lcovResult = await loadFirstValidLcov(lcovCandidates, token);
						if (!lcovResult) {
							const converted = await tryConvertLlvm(result.stdout, result.stderr, artifacts, execroot);
							if (converted) {
								const summary = testManager.publishCoverage(
									targetLabel,
									converted.coverages,
									getCoverageDetailsForFile,
									'line',
									{
										lcov: converted.artifacts.lcov,
										profraw: converted.artifacts.profraw,
										profdata: converted.artifacts.profdata,
										testlogs: converted.artifacts.testlogs
									},
									configurationService.coverageArgs,
									true
								);
								if (summary) {
									setCoverageSummary(targetLabel, summary);
									coverageOutput.appendLine(
										`[coverage] published ${targetLabel} ${summary.covered}/${summary.total} (${summary.percent.toFixed(2)}%)`
									);
									continue;
								}
							}
							coverageOutput.appendLine(`[coverage] no usable LCOV found for ${targetLabel}`);
							if (lcovCandidates.length > 0) {
								coverageOutput.appendLine(`[coverage] lcov candidates: ${lcovCandidates.slice(0, 5).join(', ')}`);
							}
							continue;
						}
						coverageOutput.appendLine(`[coverage] using lcov=${lcovResult.path}`);

						let coverages = parseLcovToFileCoverage(lcovResult.content, workspaceFolder, context.extensionPath, execroot);
						await demangleCoverageDetails(configurationService.cppDemanglerPath, configurationService.rustDemanglerPath);
						coverageOutput.appendLine(`[coverage] parsed files=${coverages.length}`);
						const totalLines = coverages.reduce((sum, entry) => sum + entry.statementCoverage.total, 0);
						if (coverages.length === 0 || totalLines === 0) {
							coverageOutput.appendLine('[coverage] LCOV has no line data; trying LLVM profiles');
							const converted = await tryConvertLlvm(result.stdout, result.stderr, artifacts, execroot);
							if (converted) {
								coverages = converted.coverages;
								await demangleCoverageDetails(configurationService.cppDemanglerPath, configurationService.rustDemanglerPath);
							} else {
								continue;
							}
						}

						const summary = testManager.publishCoverage(
							targetLabel,
							coverages,
							getCoverageDetailsForFile,
							'line',
							{
								lcov: artifacts.lcov,
								profraw: artifacts.profraw,
								profdata: artifacts.profdata,
								testlogs: artifacts.testlogs
							},
							configurationService.coverageArgs,
							false
						);
						if (!summary) {
							void vscode.window.showWarningMessage(`No matching test item found for ${targetLabel}.`);
							coverageOutput.appendLine(`No matching test item found for ${targetLabel}.`);
							continue;
						}
						setCoverageSummary(targetLabel, summary);
						coverageOutput.appendLine(
							`[coverage] published ${targetLabel} ${summary.covered}/${summary.total} (${summary.percent.toFixed(2)}%)`
						);
						const action = await vscode.window.showInformationMessage('Coverage updated.', 'Open Coverage');
						if (action === 'Open Coverage') {
							try {
								await vscode.commands.executeCommand('workbench.view.testing');
								await vscode.commands.executeCommand('testing.coverage.open');
							} catch (err) {
								coverageOutput.appendLine(`[coverage] failed to open coverage view: ${formatError(err)}`);
							}
						}
					}
				}
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('bazelTestExplorer.cancelAllRuns', async () => {
			const killed = cancelAllBazelProcesses();
			if (killed > 0) {
				logWithTimestamp(`Cancelled ${killed} Bazel process(es) by user request.`);
				void vscode.window.showInformationMessage(`Stopped ${killed} Bazel process(es).`);
			} else {
				void vscode.window.showInformationMessage('No running Bazel processes to stop.');
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
