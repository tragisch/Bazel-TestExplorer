/**
 * Copyright (c) 2024–2025 @tragisch
 * https://github.com/tragisch/Bazel-TestExplorer
 * 
 * This file is part of the Bazel Test Explorer extension for Visual Studio Code.
 * 
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 * 
 * Description:
 * This file contains the main activation logic for the VS Code extension, handling
 * test discovery, execution, and integration with Bazel.
 * 
 */


import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { glob } from 'glob';
import * as fs from 'fs';
import * as util from 'util';

const readFile = util.promisify(fs.readFile);
let hasActivated = false;
let hasRunTestDiscovery = false; // 🔹 Ensure it exists globally
let testController: vscode.TestController; // 🔹 Declare testController globally

// 🛠 Logger for debugging
const logger = vscode.window.createOutputChannel("Bazel-Test-Logs");

const RELOAD_INTERVAL_MS = vscode.workspace.getConfiguration("bazelTestRunner").get<number>("reloadIntervalMinutes", 0.5) * 60 * 1000;
let lastReloadTimestamp = 0;

// 📌 Utility function to find the Bazel workspace dynamically
export const findBazelWorkspace = async (): Promise<string | null> => {
	// Read setting from user config (Default: "MODULE.bazel")
	const config = vscode.workspace.getConfiguration("bazelTestRunner");
	const workspaceRootFile = config.get<string>("workspaceRootFile", "MODULE.bazel");
	const workspaceFiles = await glob(`**/${workspaceRootFile}*`, { nodir: true, absolute: true, cwd: vscode.workspace.rootPath || "." });
	return workspaceFiles.length > 0 ? path.dirname(workspaceFiles[0]) : null;
};

// 📌 Run Bazel commands asynchronously
const runCommand = async (command: string, cwd: string): Promise<string> => {
	return new Promise((resolve, reject) => {
		cp.exec(command, { cwd, encoding: 'utf-8' }, (error, stdout, stderr) => {
			if (error) {
				reject(stderr || stdout);
			} else {
				resolve(stdout);
			}
		});
	});
};

// 📌 Fetch test targets from Bazel, now returning both target and test type
export const fetchTestTargets = async (workspacePath: string): Promise<{ target: string, type: string }[]> => {
	const config = vscode.workspace.getConfiguration("bazelTestRunner");
	const testTypes: string[] = config.get("testTypes", ["cc_test"]);
	const useKeepGoing = config.get<boolean>("useKeepGoing", false);
	const queryPaths: string[] = config.get("queryPaths", []);
	const sanitizedPaths = queryPaths.length > 0 ? queryPaths.filter(p => p.trim() !== "") : ["/"];

	let extractedTests: { target: string; type: string }[] = [];

	for (const path of sanitizedPaths) {
		const query = testTypes.map(type => `kind(${type}, ${path}/...)`).join(" union ");
		const command = `bazel query "${query}" --output=label_kind ${useKeepGoing ? "--keep_going" : ""}`;
		logger.appendLine(`Executing Bazel query: ${command}`);

		let result: string;
		try {
			result = await runCommand(command, workspacePath);
		} catch (error) {
			logger.appendLine(`⚠️ No test targets found in path "${path}". Skipping.`);
			continue; // Skip this path, but keep processing others
		}

		if (!result.trim()) {
			logger.appendLine(`ℹ️ No test targets found in path: ${path}`); // Log info, but NOT an error
			continue; // Skip this path but keep results from others
		}

		const lines = result.split("\n").map(line => line.trim());

		const tests = lines.map(line => {
			const match = line.match(/^(\S+) rule (\/\/.+)$/);
			return match ? { type: match[1], target: match[2] } : null;
		}).filter((entry): entry is { type: string; target: string } => entry !== null);

		extractedTests.push(...tests);
	}

	logger.appendLine(`✅ Found ${extractedTests.length} test targets in Bazel workspace.`);
	return extractedTests;
};

// 📌 Show discovered tests in the Test Explorer
const showDiscoveredTests = async () => {

	try {
		const workspacePath = await findBazelWorkspace();
		if (!workspacePath) {
			vscode.window.showErrorMessage("No Bazel workspace detected.");
			return;
		}

		logger.appendLine(`Bazel workspace found at: ${workspacePath}`);
		let testEntries = await fetchTestTargets(workspacePath);

		// 🔹 Do NOT clear previous results here! Instead, merge new results
		testEntries.forEach(({ target, type }) => {
			const [packageName, testName] = target.includes(":") ? target.split(":") : [target, target];

			let packageItem = testController.items.get(packageName);
			if (!packageItem) {
				packageItem = testController.createTestItem(packageName, packageName);
				testController.items.add(packageItem);
			}

			// Use detected test type
			const testTypeLabel = `[${type}]`;

			let testItem = packageItem.children.get(testName);
			if (!testItem) {
				testItem = testController.createTestItem(target, `${testTypeLabel} ${testName}`);
				packageItem.children.add(testItem);
			}

			testItem.canResolveChildren = false;
		});

		// 🔹 Log all accumulated tests at the end
		logger.appendLine(`Registered test targets:\n${Array.from(testController.items).map(([id, item]) => id).join("\n")}`);
		hasRunTestDiscovery = true;

	} catch (error) {
		vscode.window.showErrorMessage(`Failed to discover tests: ${(error as any).message}`);
		logger.appendLine(`Error in showDiscoveredTests: ${error}`);
	}
};

// 📌 Execute Bazel test
export const executeBazelTest = async (testItem: vscode.TestItem, workspacePath: string, run: vscode.TestRun) => {
	return new Promise<void>((resolve, reject) => {
		logger.appendLine(`Running test: ${testItem.id}`);

		const bazelProcess = cp.spawn('bazel', ['test', testItem.id, '--test_output=all'], {
			cwd: workspacePath,
			shell: true
		});

		let outputBuffer = "";
		let errorBuffer = "";

		bazelProcess.stdout.on('data', (data) => {
			const output = data.toString();
			if (!output.includes("INFO: Invocation ID") &&
				!output.includes("Computing main repo mapping") &&
				!output.includes("Loading:") &&
				!output.includes("Analyzing:") &&
				!output.includes("Target //")) {
				outputBuffer += output + "\n";
			}
		});

		bazelProcess.stderr.on('data', (data) => {
			const errorOutput = data.toString();
			errorBuffer += errorOutput + "\n";
		});

		bazelProcess.on('close', (code) => {
			let testStatus = code === 0 ? "✅ **Test Passed**" : "❌ **Test Failed**";
			let formattedOutput = `${testStatus}: ${testItem.id}\n`;
			formattedOutput += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";

			// Separate Bazel's output from test log
			let bazelOutput: string[] = [];
			let testLogOutput: string[] = [];

			outputBuffer.split("\n").forEach(line => {
				if (line.startsWith("INFO:") || line.startsWith("WARNING:") || line.includes("Test execution time")) {
					bazelOutput.push(line);
				} else {
					testLogOutput.push(line);
				}
			});

			// Add Bazel output section
			if (code === 0) {
				formattedOutput += "📄 **Test Log:**\n";
				formattedOutput += testLogOutput.join("\n") + "\n";
				formattedOutput += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";
			} else {
				formattedOutput += "📌 **Bazel Output:**\n";
				formattedOutput += bazelOutput.join("\n") + "\n";
				formattedOutput += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";
				formattedOutput += "📄 **Test Log:**\n";
				formattedOutput += testLogOutput.join("\n") + "\n";
				formattedOutput += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";
			}

			run.appendOutput(formattedOutput.replace(/\r?\n/g, '\r\n') + "\r\n");

			if (code === 0) {
				run.passed(testItem);
				resolve();
			} else {
				run.failed(testItem, new vscode.TestMessage(formattedOutput));
				reject(new Error(formattedOutput));
			}
		});

		bazelProcess.on('error', (error) => {
			const errorMessage = `❌ Error executing test: ${error.message}`;
			run.appendOutput(errorMessage.replace(/\r?\n/g, '\r\n') + "\r\n");
			run.failed(testItem, new vscode.TestMessage(errorMessage));
			reject(error);
		});
	});
};

// 📌 Reload Bazel Tests Command
const reloadBazelTests = async () => {
	// Reset discovery flag to force re-querying Bazel
	hasRunTestDiscovery = false;

	const now = Date.now();
	if (now - lastReloadTimestamp < RELOAD_INTERVAL_MS) {
		logger.appendLine(`Skipping test reload: Last update was too recent.`);
		return;
	}

	lastReloadTimestamp = now;
	logger.appendLine("🔄 Reloading Bazel tests...");
	await showDiscoveredTests();

};

vscode.commands.registerCommand("extension.reloadBazelTests", reloadBazelTests);

// 📌 Activate the extension
export function activate(context: vscode.ExtensionContext) {
	if (hasActivated) {
		logger.appendLine("Skipping duplicate activation.");
		return;
	}
	hasActivated = true;

	testController = vscode.tests.createTestController('bazelUnityTestController', 'Bazel Unity Tests');
	context.subscriptions.push(testController);

	// Listen for VS Code testing settings changes and update accordingly
	vscode.workspace.onDidChangeConfiguration(e => {
		if (
			e.affectsConfiguration('testing.countBadge') ||
			e.affectsConfiguration('testing.gutterEnabled') ||
			e.affectsConfiguration('testing.defaultGutterClickAction')
		) {
			logger.appendLine("VS Code testing settings updated.");
			// Automatically update test UI if needed
		}
	});

	// 📌 Register the command properly
	vscode.commands.registerCommand("extension.showBazelTests", showDiscoveredTests);

	// 📌 Automatically Reload When Switching to Test Explorer
	vscode.window.onDidChangeVisibleTextEditors(() => {
		const isTestExplorerActive = vscode.window.activeTextEditor?.document.uri.scheme === "vscode-test-explorer";
		if (isTestExplorerActive) {
			reloadBazelTests();
		}
	});

	// 📌 Run tests
	const runTests = async (request: vscode.TestRunRequest, token: vscode.CancellationToken) => {
		const run = testController.createTestRun(request);
		const workspacePath = await findBazelWorkspace();
		if (!workspacePath) {
			vscode.window.showErrorMessage("No Bazel workspace detected.");
			logger.appendLine("❌ No Bazel workspace detected.");
			return;
		}

		logger.appendLine(`🔹 Starting test execution...`);
		const testPromises: Promise<void>[] = [];
		const packageResults: Map<string, { passed: number, total: number }> = new Map();

		// Get execution settings
		const config = vscode.workspace.getConfiguration("bazelTestRunner");
		const sequentialTestTypes: string[] = config.get("sequentialTestTypes", ["java_test"]);

		for (const testItem of request.include ?? []) {
			run.started(testItem);
			logger.appendLine(`🔹 Processing test item: ${testItem.id}`);

			if (!testItem.id.includes(":")) {
				const testTargets = await fetchTestTargets(workspacePath);
				const filteredTestTargets = testTargets.filter(({ target }) => {
					const targetPackage = target.split(":")[0];
					return targetPackage === testItem.id;
				});

				logger.appendLine(`📦 Package detected: ${testItem.id}, Found tests: ${filteredTestTargets.length}`);

				if (filteredTestTargets.length === 0) {
					vscode.window.showErrorMessage(`No tests found in ${testItem.id}`);
					logger.appendLine(`⚠️ No tests found in package: ${testItem.id}`);
					continue;
				}

				packageResults.set(testItem.id, { passed: 0, total: filteredTestTargets.length });

				const isSequential = filteredTestTargets.some(({ target }) =>
					sequentialTestTypes.some(type => target.includes(type))
				);

				for (const { target } of filteredTestTargets) {
					const packageName = target.split(":")[0];
					const packageItem = testController.items.get(packageName);
					const testItem = packageItem?.children.get(target);

					if (!testItem) {
						logger.appendLine(`⚠️ Warning: Test item not found for ${target}`);
						continue;
					}

					logger.appendLine(`▶️ Running test: ${target}`);
					testPromises.push(
						executeBazelTest(testItem, workspacePath, run)
							.then(() => {
								let packageEntry = packageResults.get(testItem.parent?.id ?? "");
								if (packageEntry) packageEntry.passed++;
							})
					);

					if (isSequential) await testPromises[testPromises.length - 1]; // Run sequentially
				}

			} else {
				// It's a single test, execute it
				logger.appendLine(`▶️ Running single test: ${testItem.id}`);
				testPromises.push(executeBazelTest(testItem, workspacePath, run));
			}
		}

		await Promise.allSettled(testPromises);
		run.end();

		// Update package labels with pass count
		for (const [packageId, { passed, total }] of packageResults) {
			let packageItem = testController.items.get(packageId);
			if (packageItem) packageItem.label = `${packageId} (${passed}/${total})`;
		}

		logger.appendLine(`✅ Test execution completed.`);
	};

	testController.createRunProfile('Run Tests', vscode.TestRunProfileKind.Run, runTests, true);
	showDiscoveredTests();
}

// 📌 Deactivate the extension
export function deactivate() { }