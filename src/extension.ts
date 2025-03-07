import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { glob } from 'glob';
import * as fs from 'fs';
import * as util from 'util';

const readFile = util.promisify(fs.readFile);
let cachedTestTargets: string[] = [];


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

export function activate(context: vscode.ExtensionContext) {
	const testController = vscode.tests.createTestController('bazelUnityTestController', 'Bazel Unity Tests');
	context.subscriptions.push(testController);

	const showDiscoveredTests = async () => {
		try {
			const workspacePath = await findBazelWorkspace();
			if (!workspacePath) {
				vscode.window.showErrorMessage("No Bazel workspace detected.");
				return;
			}
			logger.appendLine(`Bazel workspace found at: ${workspacePath}`);

			let testTargets: string[] = [];

			try {
				const result = await runCommand('bazel query "kind(cc_test, //...)"', workspacePath);
				testTargets = result.split('\n')
					.map(line => line.trim())
					.filter(line => line.startsWith("cc_test rule"))
					.map(line => line.replace(/^cc_test rule /, "").trim());

				// 🔹 **Check if tests have changed before updating**
				if (JSON.stringify(testTargets) === JSON.stringify(cachedTestTargets)) {
					logger.appendLine("No test changes detected. Using cached results.");
					return; // Exit early if no changes
				}

				// 🔹 Update cache if test targets have changed
				cachedTestTargets = [...testTargets];

				logger.appendLine(`Extracted test targets:\n${testTargets.join("\n")}`);
			} catch (error) {
				logger.appendLine(`Bazel query failed: ${error}`);
			}

			if (testTargets.length === 0) {
				vscode.window.showErrorMessage("No Bazel tests found with query.");
				return;
			}

			// 📌 Register tests in VS Code Test Explorer
			testController.items.replace([]);

			testTargets.forEach(target => {
				const parts = target.split(":"); // Extract package and test name
				const packageName = parts[0]; // e.g., "//tests"
				const testName = parts[1]; // e.g., "dm"

				let packageItem = testController.items.get(packageName);
				if (!packageItem) {
					packageItem = testController.createTestItem(packageName, packageName);
					testController.items.add(packageItem);
				}

				const testItem = testController.createTestItem(target, testName);
				packageItem.children.add(testItem);
				testItem.canResolveChildren = false;
			});

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

			// 📌 Erfasse Standardausgabe (wird in Test Output Fenster angezeigt)
			bazelProcess.stdout.on('data', (data) => {
				const output = data.toString();
				outputBuffer += output + "\n";
				run.appendOutput(output.replace(/\r?\n/g, '\r\n'));
				logger.append(output);
			});

			// 📌 Erfasse Fehlerausgabe
			bazelProcess.stderr.on('data', (data) => {
				const errorOutput = data.toString();
				errorBuffer += errorOutput + "\n";
				run.appendOutput(errorOutput.replace(/\r?\n/g, '\r\n'));
				logger.append(errorOutput);
			});

			// 📌 Wenn der Test beendet wurde, prüfe den Exit-Code
			bazelProcess.on('close', (code) => {
				if (code === 0) {
					run.passed(testItem);
					resolve();
				} else {
					// Set a minimal error message for the hover tooltip
					const errorMessage = `Test failed: ${testItem.id}`;
					const message = new vscode.TestMessage(errorMessage);
					run.failed(testItem, message);
					reject(new Error(`Bazel test failed with exit code ${code}`));
				}
			});

			// 📌 Falls der Prozess fehlschlägt, Fehlermeldung im Test-Explorer anzeigen
			bazelProcess.on('error', (error) => {
				const errorMessage = `Error executing test: ${error.message}`;
				const message = new vscode.TestMessage(errorMessage);
				run.failed(testItem, message);
				reject(error);
			});
		});
	};


	const runTests = async (request: vscode.TestRunRequest, token: vscode.CancellationToken) => {
		const run = testController.createTestRun(request);
		const workspacePath = await findBazelWorkspace();

		if (!workspacePath) {
			vscode.window.showErrorMessage("No Bazel workspace detected.");
			return;
		}

		const testPromises: Promise<void>[] = [];

		for (const testItem of request.include ?? []) {
			run.started(testItem);

			if (!testItem.id.includes(":")) {
				// 🔹 It's a package, find all tests inside
				try {
					const result = await runCommand(`bazel query "kind(cc_test, ${testItem.id}/...)"`, workspacePath);
					const testTargets = result.split("\n")
						.map(line => line.trim())
						.filter(line => line.startsWith("cc_test rule")) // Ensure we filter only valid lines
						.map(line => line.replace(/^cc_test rule /, "").trim()); // Remove "cc_test rule " to get the actual target

					if (testTargets.length === 0) {
						vscode.window.showErrorMessage(`No tests found in ${testItem.id}`);
						continue;
					}

					// 🔹 Start all tests inside the package in parallel (each as its own Bazel command)
					testPromises.push(...testTargets.map(target => {
						const parts = target.split(":");
						const packageName = parts[0]; // e.g., "//tests"
						const testName = parts[1]; // e.g., "dm"

						const packageItem = testController.items.get(packageName);
						if (!packageItem) {
							logger.appendLine(`Warning: No package item found for ${packageName}`);
							return Promise.resolve(); // Skip if package item is missing
						}

						const testItem = packageItem.children.get(target);
						if (!testItem) {
							logger.appendLine(`Warning: No test item found for ${target}`);
							return Promise.resolve(); // Skip if test item is missing
						}

						return executeBazelTest(testItem, workspacePath, run);
					}));

				} catch (error) {
					logger.appendLine(`Failed to discover tests in ${testItem.id}: ${error}`);
				}

			} else {
				// 🔹 It's a single test, just run it
				testPromises.push(executeBazelTest(testItem, workspacePath, run));
			}
		}

		// 🔹 Run all tests in parallel, ensuring independent execution
		await Promise.allSettled(testPromises);
		run.end();
	};

	testController.createRunProfile('Run Tests', vscode.TestRunProfileKind.Run, runTests, true);

	showDiscoveredTests();
	vscode.commands.registerCommand("extension.showBazelTests", showDiscoveredTests);
}

export function deactivate() { }