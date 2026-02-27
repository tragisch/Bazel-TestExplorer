/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 *
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/**
 * Coverage command handler - extracted from extension.ts to reduce the activate() function size.
 * Handles the `bazelTestExplorer.showCoverageDetails` command.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { logWithTimestamp, formatError } from '../logging';
import { ConfigurationService } from '../configuration';
import { TestControllerManager } from '../explorer/controller';
import { parseLcovToFileCoverage, getCoverageDetailsForFile, demangleCoverageDetails, normalizeLcovContent, clearCoverageDetailsCache } from './vscode';
import { setCoverageSummary } from './state';
import { BazelCoverageRunner, resolveBazelInfo, findCoverageArtifacts, loadFirstValidLcov, extractLcovPathFromOutput, extractBazelBinExecPath, convertProfrawToLcov } from '../bazel/coverage/artifacts';

interface CoverageCommandDeps {
	workspaceRoot: string;
	configurationService: ConfigurationService;
	testManager: TestControllerManager;
	coverageOutput: vscode.OutputChannel;
	extensionPath: string;
}

/**
 * Creates and returns a handler for the coverage command.
 * Encapsulates all coverage-related state (e.g. `isCoverageRunInProgress`).
 */
export function createCoverageCommandHandler(deps: CoverageCommandDeps): (...args: unknown[]) => Promise<void> {
	let isCoverageRunInProgress = false;

	return async (...args: unknown[]) => {
		const items = args[0] as vscode.TestItem | vscode.TestItem[] | undefined;
		if (isCoverageRunInProgress) {
			void vscode.window.showWarningMessage('Coverage run already in progress. Please wait for it to finish.');
			return;
		}
		isCoverageRunInProgress = true;
		clearCoverageDetailsCache();
		try {
			await runCoverage(deps, items);
		} catch (error) {
			const message = formatError(error);
			deps.coverageOutput.appendLine(`[coverage] command failed: ${message}`);
			void vscode.window.showErrorMessage(`Coverage run failed:\n${message}`);
		} finally {
			isCoverageRunInProgress = false;
		}
	};
}

function normalizeTargetLabel(value: string): string {
	const trimmed = value.trim();
	return trimmed.includes('::') ? trimmed.split('::')[0] : trimmed;
}

async function runCoverage(deps: CoverageCommandDeps, items?: vscode.TestItem | vscode.TestItem[]): Promise<void> {
	const { workspaceRoot, configurationService, testManager, coverageOutput, extensionPath } = deps;

	const selectedItems = Array.isArray(items)
		? items
		: items
			? [items]
			: [];
	const targetLabels = Array.from(
		new Set(
			selectedItems
				.map(item => normalizeTargetLabel(item.id ?? item.label))
				.filter(label => label.includes(':') && !label.includes('::'))
		)
	);
	if (targetLabels.length === 0) {
		void vscode.window.showInformationMessage('No Bazel test targets selected for coverage.');
		return;
	}

	coverageOutput.show(true);
	coverageOutput.appendLine(`[coverage] targets=${targetLabels.length}`);
	const workspaceFolder = workspaceRoot;
	const runner = new BazelCoverageRunner(coverageOutput);

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Bazel Coverage',
			cancellable: true
		},
		async (progress, token) => {
			for (const targetLabel of targetLabels) {
				if (token.isCancellationRequested) {
					coverageOutput.appendLine('[coverage] cancelled');
					break;
				}
				progress.report({ message: `Running coverage for ${targetLabel}` });
				await runCoverageForTarget(deps, runner, targetLabel, workspaceFolder, token);
			}
		}
	);

	// Fire-and-forget: prompt the user to open coverage without blocking progress
	void vscode.window.showInformationMessage('Coverage updated.', 'Open Coverage').then(async (action) => {
		if (action === 'Open Coverage') {
			try {
				await vscode.commands.executeCommand('testing.openCoverage');
			} catch {
				try {
					await vscode.commands.executeCommand('testing.openTesting');
				} catch {
					coverageOutput.appendLine('[coverage] could not open coverage view automatically');
				}
			}
		}
	});
}

async function runCoverageForTarget(
	deps: CoverageCommandDeps,
	runner: BazelCoverageRunner,
	targetLabel: string,
	workspaceFolder: string,
	token: vscode.CancellationToken
): Promise<void> {
	const { workspaceRoot, configurationService, testManager, coverageOutput, extensionPath } = deps;

	coverageOutput.appendLine(`[coverage] run target=${targetLabel}`);
	const args = buildCoverageArgs(configurationService, targetLabel, coverageOutput);
	logWithTimestamp(`Running Bazel: ${configurationService.bazelPath} ${args.join(' ')}`);
	coverageOutput.appendLine(`[coverage] ignoreRcFiles=${configurationService.ignoreRcFiles ? 'true (using --ignore_all_rc_files)' : 'false (using .bazelrc if present)'}`);
	const explicit = configurationService.bazelrcFiles ?? [];
	if (explicit.length > 0) {
		coverageOutput.appendLine(`[coverage] explicit --bazelrc files: ${explicit.join(', ')}`);
	}

	const result = await runner.runCoverage(
		{ bazelBinary: configurationService.bazelPath, args, workspaceRoot },
		token
	);
	if (result.code !== 0) {
		coverageOutput.appendLine(`[coverage] bazel coverage failed (code=${result.code}) for ${targetLabel}`);
		return;
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

	const lcovResult = await findAndLoadLcov(
		workspaceRoot, execroot, testlogs, targetLabel, artifacts, reportedLcov, coverageOutput, token
	);

	if (!lcovResult) {
		const converted = await tryConvertLlvm(result.stdout, result.stderr, artifacts, execroot, workspaceFolder, configurationService, coverageOutput, extensionPath, token);
		if (converted) {
			publishConvertedCoverage(testManager, targetLabel, converted, coverageOutput, configurationService, artifacts);
			return;
		}
		coverageOutput.appendLine(`[coverage] no usable LCOV found for ${targetLabel}`);
		await logLcovCandidatesInfo(artifacts, reportedLcov, execroot, testlogs, targetLabel, workspaceRoot, coverageOutput);
		return;
	}

	coverageOutput.appendLine(`[coverage] using lcov=${lcovResult.path}`);

	const normalized = normalizeLcovContent(lcovResult.content, {
		workspaceRoot: workspaceFolder,
		execRoot: execroot,
		filterExternal: true,
		filterBazelOut: true
	});
	if (normalized.rewritten || normalized.removedRecords > 0) {
		coverageOutput.appendLine(
			`[coverage] normalized lcov updated=${normalized.updatedRecords} removed=${normalized.removedRecords}`
		);
		await writeNormalizedLcov(normalized.content, execroot, workspaceFolder, coverageOutput);
	}

	// Debug: Show LCOV content preview
	coverageOutput.appendLine('[coverage] LCOV content preview:');
	const previewLines = normalized.content.split('\n').slice(0, 30);
	for (const line of previewLines) {coverageOutput.appendLine(`  ${line}`);}
	if (normalized.content.split('\n').length > 30) {
		coverageOutput.appendLine(`  ... (${normalized.content.split('\n').length - 30} more lines)`);
	}

	let coverages = parseLcovToFileCoverage(normalized.content, workspaceFolder, extensionPath, execroot);
	await demangleCoverageDetails(configurationService.cppDemanglerPath, configurationService.rustDemanglerPath);
	coverageOutput.appendLine(`[coverage] parsed files=${coverages.length}`);
	const totalLines = coverages.reduce((sum, entry) => sum + entry.statementCoverage.total, 0);
	coverageOutput.appendLine(`[coverage] total lines=${totalLines}`);
	if (coverages.length === 0 || totalLines === 0) {
		coverageOutput.appendLine('[coverage] ⚠️  LCOV has no line data. This means no source files were instrumented.');
		coverageOutput.appendLine('[coverage] Check: bazel-out/darwin_arm64-fastbuild/testlogs/app/matrix/test_dm/test_dm.instrumented_files');
		coverageOutput.appendLine('[coverage] Trying LLVM profiles as fallback...');
		const converted = await tryConvertLlvm(result.stdout, result.stderr, artifacts, execroot, workspaceFolder, configurationService, coverageOutput, extensionPath, token);
		if (converted) {
			coverages = converted.coverages;
			await demangleCoverageDetails(configurationService.cppDemanglerPath, configurationService.rustDemanglerPath);
		} else {
			return;
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
		return;
	}
	setCoverageSummary(targetLabel, summary);
	coverageOutput.appendLine(
		`[coverage] published ${targetLabel} ${summary.covered}/${summary.total} (${summary.percent.toFixed(2)}%)`
	);
}

function buildCoverageArgs(configurationService: ConfigurationService, targetLabel: string, coverageOutput: vscode.OutputChannel): string[] {
	if (configurationService.ignoreRcFiles) {
		const filtered = configurationService.coverageArgs.filter(a => !a.startsWith('--bazelrc') && !a.startsWith('--ignore_all_rc_files'));
		if (process.platform === 'darwin') {
			const coptFlag = '--copt=-fcoverage-compilation-dir=.';
			if (!filtered.some(a => a.includes('-fcoverage-compilation-dir'))) {
				filtered.push(coptFlag);
				coverageOutput.appendLine(`[coverage] macOS detected: added ${coptFlag}`);
			}
		}
		const explicitBazelrc = configurationService.bazelrcFiles.map(p => `--bazelrc=${p}`);
		return ['--ignore_all_rc_files', ...explicitBazelrc, 'coverage', ...filtered, targetLabel];
	}
	return ['coverage', ...configurationService.coverageArgs, targetLabel];
}

async function findAndLoadLcov(
	workspaceRoot: string,
	execroot: string | undefined,
	testlogs: string | undefined,
	targetLabel: string,
	artifacts: { lcov: string[]; profraw: string[]; profdata: string[]; testlogs: string[] },
	reportedLcov: string | undefined,
	coverageOutput: vscode.OutputChannel,
	token: vscode.CancellationToken
): Promise<{ path: string; content: string } | undefined> {
	const centralCoveragePaths = [
		execroot ? path.join(execroot, 'bazel-out', '_coverage', '_coverage_report.dat') : undefined,
		path.join(workspaceRoot, 'bazel-out', '_coverage', '_coverage_report.dat')
	].filter(Boolean) as string[];
	const centralCoverage = centralCoveragePaths.find(p => fs.existsSync(p));
	if (centralCoverage) {
		coverageOutput.appendLine(`[coverage] found central coverage report: ${centralCoverage}`);
	}
	const targetPath = targetLabel.replace(/^\/\//, '').replace(':', path.sep);
	const preferredRoot = testlogs ? path.join(testlogs, targetPath) : undefined;
	const preferredLcov = preferredRoot
		? artifacts.lcov.filter(file => file.startsWith(preferredRoot))
		: [];
	const lcovCandidates = centralCoverage
		? [centralCoverage, reportedLcov, ...preferredLcov, ...artifacts.lcov].filter(Boolean) as string[]
		: reportedLcov
			? [reportedLcov, ...preferredLcov, ...artifacts.lcov]
			: (preferredLcov.length > 0 ? preferredLcov : artifacts.lcov);
	if (preferredLcov.length === 0 && !centralCoverage) {
		coverageOutput.appendLine('[coverage] no target-specific or central LCOV found; falling back to latest valid LCOV.');
	}
	return loadFirstValidLcov(
		lcovCandidates,
		token,
		(msg) => coverageOutput.appendLine(msg)
	);
}

async function tryConvertLlvm(
	stdout: string,
	stderr: string,
	artifacts: { profraw: string[]; profdata: string[]; lcov: string[]; testlogs: string[] },
	execrootPath: string | undefined,
	workspaceFolder: string,
	configurationService: ConfigurationService,
	coverageOutput: vscode.OutputChannel,
	extensionPath: string,
	token?: vscode.CancellationToken
): Promise<{ coverages: vscode.FileCoverage[]; artifacts: typeof artifacts } | undefined> {
	if (artifacts.profraw.length === 0 && artifacts.profdata.length === 0) {
		return undefined;
	}
	const execPath = extractBazelBinExecPath(stdout + stderr);
	const bazelBin = await resolveBazelInfo(configurationService.bazelPath, workspaceFolder, 'bazel-bin', token);
	const binaryPath = execPath && bazelBin ? path.join(bazelBin, execPath.replace(/^bazel-bin\//, '')) : undefined;
	if (binaryPath && fs.existsSync(binaryPath)) {
		coverageOutput.appendLine(`[coverage] converting LLVM profile using ${binaryPath}`);
		const converted = await convertProfrawToLcov(artifacts.profraw, binaryPath, token);
		if (converted) {
			coverageOutput.appendLine(`[coverage] using llvm lcov=${converted.path}`);
			const normalized = normalizeLcovContent(converted.content, {
				workspaceRoot: workspaceFolder,
				execRoot: execrootPath,
				filterExternal: true,
				filterBazelOut: true
			});
			if (normalized.rewritten || normalized.removedRecords > 0) {
				coverageOutput.appendLine(
					`[coverage] normalized llvm lcov updated=${normalized.updatedRecords} removed=${normalized.removedRecords}`
				);
			}
			const convertedCoverages = parseLcovToFileCoverage(normalized.content, workspaceFolder, extensionPath, execrootPath);
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
}

function publishConvertedCoverage(
	testManager: TestControllerManager,
	targetLabel: string,
	converted: { coverages: vscode.FileCoverage[]; artifacts: { lcov: string[]; profraw: string[]; profdata: string[]; testlogs: string[] } },
	coverageOutput: vscode.OutputChannel,
	configurationService: ConfigurationService,
	artifacts: { lcov: string[]; profraw: string[]; profdata: string[]; testlogs: string[] }
): void {
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
	}
}

async function writeNormalizedLcov(
	content: string,
	execroot: string | undefined,
	workspaceFolder: string,
	coverageOutput: vscode.OutputChannel
): Promise<void> {
	const normalizedReportPath = execroot
		? path.join(execroot, 'bazel-out', '_coverage', '_coverage_report.dat')
		: path.join(workspaceFolder, 'bazel-out', '_coverage', '_coverage_report.dat');
	try {
		await fs.promises.mkdir(path.dirname(normalizedReportPath), { recursive: true });
		await fs.promises.writeFile(normalizedReportPath, content, 'utf8');
		coverageOutput.appendLine(`[coverage] wrote normalized lcov=${normalizedReportPath}`);
	} catch (err) {
		coverageOutput.appendLine(`[coverage] failed to write normalized lcov: ${String(err)}`);
	}
}

async function logLcovCandidatesInfo(
	artifacts: { lcov: string[] },
	reportedLcov: string | undefined,
	execroot: string | undefined,
	testlogs: string | undefined,
	targetLabel: string,
	workspaceRoot: string,
	coverageOutput: vscode.OutputChannel
): Promise<void> {
	const centralCoveragePaths = [
		execroot ? path.join(execroot, 'bazel-out', '_coverage', '_coverage_report.dat') : undefined,
		path.join(workspaceRoot, 'bazel-out', '_coverage', '_coverage_report.dat')
	].filter(Boolean) as string[];
	const targetPath = targetLabel.replace(/^\/\//, '').replace(':', path.sep);
	const preferredRoot = testlogs ? path.join(testlogs, targetPath) : undefined;
	const preferredLcov = preferredRoot
		? artifacts.lcov.filter(file => file.startsWith(preferredRoot))
		: [];
	const centralCoverage = centralCoveragePaths.find(p => fs.existsSync(p));
	const lcovCandidates = centralCoverage
		? [centralCoverage, reportedLcov, ...preferredLcov, ...artifacts.lcov].filter(Boolean) as string[]
		: reportedLcov
			? [reportedLcov, ...preferredLcov, ...artifacts.lcov]
			: (preferredLcov.length > 0 ? preferredLcov : artifacts.lcov);

	if (lcovCandidates.length > 0) {
		coverageOutput.appendLine(`[coverage] lcov candidates: ${lcovCandidates.slice(0, 5).join(', ')}`);

		const nonEmptyCandidates = await Promise.all(
			lcovCandidates.slice(0, 3).map(async (file) => {
				try {
					const stat = await fs.promises.stat(file);
					return stat.size > 0 ? file : null;
				} catch {
					return null;
				}
			})
		);
		const hasNonEmptyFiles = nonEmptyCandidates.some(f => f !== null);
		if (hasNonEmptyFiles) {
			coverageOutput.appendLine('[coverage] ⚠️  Found non-empty coverage files but they are not in LCOV format.');
			coverageOutput.appendLine('[coverage] This might happen if --combined_report=lcov is not working properly.');
			coverageOutput.appendLine('[coverage] Try adjusting --instrumentation_filter to match your source files (e.g., --instrumentation_filter="app/.*").');
		}
	}
}
