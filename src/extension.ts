import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { glob } from 'glob';
import * as fs from 'fs';
import * as util from 'util';

const readFile = util.promisify(fs.readFile);
let cachedTestTargets: string[] = [];
let hasActivated = false;

// 🛠 Logger for debugging
const logger = vscode.window.createOutputChannel("Bazel Unity Tests");

// 📌 Utility function to find the Bazel workspace dynamically
const findBazelWorkspace = async (): Promise<string | null> => {
	const workspaceFiles = await glob("**/MODULE.bazel*", { nodir: true, absolute: true, cwd: vscode.workspace.rootPath || "." });
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

// 📌 Fetch test targets from Bazel
const fetchTestTargets = async (workspacePath: string): Promise<string[]> => {
	try {
		const result = await runCommand('bazel query "kind(cc_test, //...)"', workspacePath);
		return result.split('\n')
			.map(line => line.trim())
			.filter(line => line.startsWith("cc_test rule"))
			.map(line => line.replace(/^cc_test rule /, "").trim());
	} catch (error) {
		logger.appendLine(`Bazel query failed: ${error}`);
		return [];
	}
};

export function activate(context: vscode.ExtensionContext) {
	if (hasActivated) {
		logger.appendLine("Skipping duplicate activation.");
		return;
	}
	hasActivated = true;
	const testController = vscode.tests.createTestController('bazelUnityTestController', 'Bazel Unity Tests');
	context.subscriptions.push(testController);

	// 🔹 Load cached test results at startup
	cachedTestTargets = context.globalState.get<string[]>("cachedTestTargets", []);

	let hasRunTestDiscovery = false;

	const showDiscoveredTests = async () => {
		if (hasRunTestDiscovery) {
			logger.appendLine("Skipping duplicate test discovery.");
			return;
		}
		hasRunTestDiscovery = true;

		try {
			const workspacePath = await findBazelWorkspace();
			if (!workspacePath) {
				vscode.window.showErrorMessage("No Bazel workspace detected.");
				return;
			}

			logger.appendLine(`Bazel workspace found at: ${workspacePath}`);
			let testTargets = await fetchTestTargets(workspacePath);

			if (testController.items.size === 0) {
				logger.appendLine("Test Explorer is empty. Forcing test discovery.");
				cachedTestTargets = [];
			} else {
				cachedTestTargets = context.globalState.get<string[]>("cachedTestTargets", []);
			}

			if (JSON.stringify(testTargets) === JSON.stringify(cachedTestTargets)) {
				logger.appendLine("No test changes detected. Using cached results.");
				return;
			}

			cachedTestTargets = [...testTargets];
			context.globalState.update("cachedTestTargets", cachedTestTargets);

			testController.items.replace([]);
			testTargets.forEach(target => {
				const [packageName, testName] = target.includes(":") ? target.split(":") : [target, target]; // Ensure testName is never undefined

				let packageItem = testController.items.get(packageName);
				if (!packageItem) {
					packageItem = testController.createTestItem(packageName, packageName);
					testController.items.add(packageItem);
				}

				// 🔹 Ensure test items are stored with their full name
				let testItem = packageItem.children.get(target);
				if (!testItem) {
					testItem = testController.createTestItem(target, testName);
					packageItem.children.add(testItem);
				}

				testItem.canResolveChildren = false;
			});

			logger.appendLine(`Registered test targets:\n${testTargets.join("\n")}`);
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to discover tests: ${(error as any).message}`);
			logger.appendLine(`Error in showDiscoveredTests: ${error}`);
		}
	};

	const executeBazelTest = async (testItem: vscode.TestItem, workspacePath: string, run: vscode.TestRun) => {
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
				outputBuffer += output + "\n";
				run.appendOutput(output.replace(/\r?\n/g, '\r\n'));
			});

			bazelProcess.stderr.on('data', (data) => {
				const errorOutput = data.toString();
				errorBuffer += errorOutput + "\n";
				run.appendOutput(errorOutput.replace(/\r?\n/g, '\r\n'));
			});

			bazelProcess.on('close', (code) => {
				if (code === 0) {
					run.passed(testItem);
					resolve();
				} else {
					const errorMessage = `Test failed: ${testItem.id}\n${errorBuffer.trim()}`;
					run.failed(testItem, new vscode.TestMessage(errorMessage));
					reject(new Error(errorMessage));
				}
			});

			bazelProcess.on('error', (error) => {
				const errorMessage = `Error executing test: ${error.message}`;
				run.failed(testItem, new vscode.TestMessage(errorMessage));
				reject(error);
			});
		});
	};

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

		for (const testItem of request.include ?? []) {
			run.started(testItem);
			logger.appendLine(`🔹 Processing test item: ${testItem.id}`);

			if (!testItem.id.includes(":")) {
				// 🔹 It's a package, retrieve all tests inside
				const testTargets = cachedTestTargets.filter(target => target.startsWith(testItem.id));
				logger.appendLine(`📦 Package detected: ${testItem.id}, Found tests: ${testTargets.length}`);

				if (testTargets.length === 0) {
					vscode.window.showErrorMessage(`No tests found in ${testItem.id}`);
					logger.appendLine(`⚠️ No tests found in package: ${testItem.id}`);
					continue;
				}

				// 🔹 Run all package tests in parallel
				testPromises.push(...testTargets.map(target => {
					const packageName = target.split(":")[0]; // Extract package part
					const packageItem = testController.items.get(packageName);

					const testItem = packageItem?.children.get(target); // 🔹 Retrieve test from `children`
					if (!testItem) {
						logger.appendLine(`⚠️ Warning: Test item not found for ${target}`);
						return Promise.resolve();
					}
					logger.appendLine(`▶️ Running test: ${target}`);
					return executeBazelTest(testItem, workspacePath, run);
				}));

			} else {
				// 🔹 It's a single test, execute it
				logger.appendLine(`▶️ Running single test: ${testItem.id}`);
				testPromises.push(executeBazelTest(testItem, workspacePath, run));
			}
		}

		await Promise.allSettled(testPromises);
		run.end();
		logger.appendLine(`✅ Test execution completed.`);
	};

	testController.createRunProfile('Run Tests', vscode.TestRunProfileKind.Run, runTests, true);

	showDiscoveredTests();
	vscode.commands.registerCommand("extension.showBazelTests", showDiscoveredTests);
}

export function deactivate() { }