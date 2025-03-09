import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { glob } from 'glob';
import * as fs from 'fs';
import * as util from 'util';

const readFile = util.promisify(fs.readFile);
let hasActivated = false;

// 🛠 Logger for debugging
const logger = vscode.window.createOutputChannel("Bazel-Test-Logs");

// 📌 Utility function to find the Bazel workspace dynamically
export const findBazelWorkspace = async (): Promise<string | null> => {
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

// 📌 Fetch test targets from Bazel, now returning both target and test type
export const fetchTestTargets = async (workspacePath: string): Promise<{ target: string, type: string }[]> => {
	try {
		// 🔹 Read user-defined test types from settings.json, fallback to defaults
		const config = vscode.workspace.getConfiguration("bazelTestRunner");
		const testTypes: string[] = config.get("testTypes", ["cc_test", "unity_test"]);

		// 🔹 Construct Bazel query with union of all test types
		const query = testTypes.map(type => `kind(${type}, //...)`).join(" union ");
		const result = await runCommand(`bazel query "${query}"`, workspacePath);

		// 🔹 Step 1: Split output into lines and trim whitespace
		let lines = result.split("\n").map(line => line.trim());

		// 🔹 Step 2: Extract test type BEFORE removing the prefix
		let extractedTests = lines
			.filter(line => line.includes(" rule //")) // Ensure it contains a test rule
			.map(line => {
				const parts = line.split(" rule "); // Example: "cc_test rule //tests:dm"
				return { type: parts[0], target: parts[1] || "unknown_target" };
			});

		// 🔹 Step 3: Filter out invalid test targets
		let validEntries = extractedTests.filter(entry => entry.target.startsWith("//"));
		logger.appendLine(`Found ${validEntries.length} test targets in Bazel workspace.`);
		return validEntries;

	} catch (error) {
		logger.appendLine(`Bazel query failed: ${error}`);
		return [];
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
				!output.includes("INFO: Found") &&
				!output.includes("Target //")) {
				outputBuffer += output + "\n";
			}
		});

		bazelProcess.stderr.on('data', (data) => {
			const errorOutput = data.toString();
			errorBuffer += errorOutput + "\n";
		});

		bazelProcess.on('close', (code) => {
			if (code === 0) {
				const successMessage = `✅ Test Passed: ${testItem.id}\n${outputBuffer.trim()}`;
				run.appendOutput(successMessage.replace(/\r?\n/g, '\r\n') + "\r\n");
				run.passed(testItem);
				resolve();
			} else {
				const errorMessage = `❌ Test Failed: ${testItem.id}\n${outputBuffer.trim()}`;
				run.appendOutput(errorMessage.replace(/\r?\n/g, '\r\n') + "\r\n");
				run.failed(testItem, new vscode.TestMessage(errorMessage));
				reject(new Error(errorMessage));
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

// 📌 Activate the extension
export function activate(context: vscode.ExtensionContext) {
	if (hasActivated) {
		logger.appendLine("Skipping duplicate activation.");
		return;
	}
	hasActivated = true;
	const testController = vscode.tests.createTestController('bazelUnityTestController', 'Bazel Unity Tests');
	context.subscriptions.push(testController);

	let hasRunTestDiscovery = false;

	// 📌 Show discovered tests in the Test Explorer
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
			let testEntries = await fetchTestTargets(workspacePath);

			testController.items.replace([]);
			testEntries.forEach(({ target, type }) => {
				const [packageName, testName] = target.includes(":") ? target.split(":") : [target, target];

				let packageItem = testController.items.get(packageName);
				if (!packageItem) {
					packageItem = testController.createTestItem(packageName, packageName);
					testController.items.add(packageItem);
				}

				// 🔹 Use detected test type
				const testTypeLabel = `[${type}]`;

				let testItem = packageItem.children.get(testName);
				if (!testItem) {
					testItem = testController.createTestItem(target, `${testTypeLabel} ${testName}`);
					packageItem.children.add(testItem);
				}

				testItem.canResolveChildren = false;
			});

			logger.appendLine(`Registered test targets:\n${testEntries.map(e => e.target).join("\n")}`);
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to discover tests: ${(error as any).message}`);
			logger.appendLine(`Error in showDiscoveredTests: ${error}`);
		}
	};

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

		// 🔹 Get execution settings
		const config = vscode.workspace.getConfiguration("bazelTestRunner");
		const sequentialTestTypes: string[] = config.get("sequentialTestTypes", ["java_test"]);

		for (const testItem of request.include ?? []) {
			run.started(testItem);
			logger.appendLine(`🔹 Processing test item: ${testItem.id}`);

			if (!testItem.id.includes(":")) {
				// 📦 It's a package, retrieve all tests inside
				const testTargets = await fetchTestTargets(workspacePath);
				const filteredTestTargets = testTargets.filter(({ target }) => {
					const targetPackage = target.split(":")[0]; // Extract package name
					return targetPackage === testItem.id; // Only allow exact package matches
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
				// 🧪 It's a single test, execute it
				logger.appendLine(`▶️ Running single test: ${testItem.id}`);
				testPromises.push(executeBazelTest(testItem, workspacePath, run));
			}
		}

		await Promise.allSettled(testPromises);
		run.end();

		// 🔹 Update package labels with pass count
		for (const [packageId, { passed, total }] of packageResults) {
			let packageItem = testController.items.get(packageId);
			if (packageItem) packageItem.label = `${packageId} (${passed}/${total})`;
		}

		logger.appendLine(`✅ Test execution completed.`);
	};

	testController.createRunProfile('Run Tests', vscode.TestRunProfileKind.Run, runTests, true);
	showDiscoveredTests();
	vscode.commands.registerCommand("extension.showBazelTests", showDiscoveredTests);
}

// 📌 Deactivate the extension
export function deactivate() { }