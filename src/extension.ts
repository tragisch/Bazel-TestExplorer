import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { glob } from 'glob';
import * as fs from 'fs';
import * as util from 'util';

const readFile = util.promisify(fs.readFile);
let extensionActivated = false;
let testDiscoveryCompleted = false; // 🔹 Ensure it exists globally
let bazelTestController: vscode.TestController; // 🔹 Declare bazelTestController globally

// 🛠 Logger for debugging
const logger = vscode.window.createOutputChannel("Bazel-Test-Logs");

const RELOAD_INTERVAL_MS = vscode.workspace.getConfiguration("bazelTestRunner").get<number>("reloadIntervalMinutes", 0.5) * 60 * 1000;
let lastReloadTimestamp = 0;

// ─── Workspace and Bazel Utilities ─────────────────────────────────────
export const findBazelWorkspace = async (): Promise<string | null> => {
	// Read setting from user config (Default: "MODULE.bazel")
	const config = vscode.workspace.getConfiguration("bazelTestRunner");
	const workspaceRootFile = config.get<string>("workspaceRootFile", "MODULE.bazel");
	const workspaceFiles = await glob(`**/${workspaceRootFile}*`, { nodir: true, absolute: true, cwd: vscode.workspace.rootPath || "." });
	return workspaceFiles.length > 0 ? path.dirname(workspaceFiles[0]) : null;
};

// 📌 Run Bazel commands asynchronously
const execShellCommand = async (command: string, cwd: string): Promise<string> => {
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
export const queryBazelTestTargets = async (workspacePath: string): Promise<{ target: string, type: string }[]> => {
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
			result = await execShellCommand(command, workspacePath);
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

// ─── Test Discovery Logic ──────────────────────────────────────────────
const getWorkspaceOrShowError = async (): Promise<string | null> => {
	const workspacePath = await findBazelWorkspace();
	if (!workspacePath) {
		vscode.window.showErrorMessage("No Bazel workspace detected.");
		return null;
	}
	logger.appendLine(`Bazel workspace found at: ${workspacePath}`);
	return workspacePath;
};

// 📌 Helper function to register discovered test
const addTestItemToController = (target: string, type: string) => {
	const [packageName, testName] = target.includes(":") ? target.split(":") : [target, target];

	let packageItem = bazelTestController.items.get(packageName);
	if (!packageItem) {
		packageItem = bazelTestController.createTestItem(packageName, packageName);
		bazelTestController.items.add(packageItem);
	}

	const testTypeLabel = `[${type}]`;

	let testItem = packageItem.children.get(testName);
	if (!testItem) {
		testItem = bazelTestController.createTestItem(target, `${testTypeLabel} ${testName}`);
		packageItem.children.add(testItem);
	}

	testItem.canResolveChildren = false;
};

// 📌 Show discovered tests in the Test Explorer
const discoverAndDisplayTests = async () => {
	try {
		const workspacePath = await getWorkspaceOrShowError();
		if (!workspacePath) return;

		const testEntries = await queryBazelTestTargets(workspacePath);

		testEntries.forEach(({ target, type }) => {
			addTestItemToController(target, type);
		});

		logger.appendLine(`Registered test targets:\n${Array.from(bazelTestController.items).map(([id, item]) => id).join("\n")}`);
		testDiscoveryCompleted = true;

	} catch (error) {
		vscode.window.showErrorMessage(`Failed to discover tests: ${(error as any).message}`);
		logger.appendLine(`Error in discoverAndDisplayTests: ${error}`);
	}
};

// ─── Test Execution Logic ──────────────────────────────────────────────
const spawnBazelTestProcess = (testId: string, cwd: string): Promise<{ code: number, stdout: string, stderr: string }> => {
	return new Promise((resolve, reject) => {
		const bazelProcess = cp.spawn('bazel', ['test', testId, '--test_output=all'], {
			cwd,
			shell: true
		});

		let stdout = '';
		let stderr = '';

		bazelProcess.stdout.on('data', data => {
			stdout += data.toString();
		});

		bazelProcess.stderr.on('data', data => {
			stderr += data.toString();
		});

		bazelProcess.on('close', code => {
			resolve({ code: code ?? 1, stdout, stderr });
		});

		bazelProcess.on('error', reject);
	});
};

// 📌 Split Bazel output
const parseBazelStdoutOutput = (stdout: string): { bazelLog: string[], testLog: string[] } => {
	const bazelLog: string[] = [];
	const testLog: string[] = [];

	stdout.split("\n").forEach(line => {
		if (line.startsWith("INFO:") || line.startsWith("WARNING:") || line.includes("Test execution time")) {
			bazelLog.push(line);
		} else {
			testLog.push(line);
		}
	});

	return { bazelLog, testLog };
};

// 📌 Format test output
const generateTestResultMessage = (testId: string, code: number, testLog: string[], bazelLog: string[]): string => {
	const status = code === 0 ? "✅ **Test Passed**" : "❌ **Test Failed**";
	const header = `${status}: ${testId}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

	let output = header;
	if (code === 0) {
		output += "📄 **Test Log:**\n" + testLog.join("\n") + "\n";
	} else {
		output += "📌 **Bazel Output:**\n" + bazelLog.join("\n") + "\n";
		output += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📄 **Test Log:**\n" + testLog.join("\n") + "\n";
	}
	output += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";

	return output;
};

// 📌 Execute Bazel test
export const executeBazelTest = async (testItem: vscode.TestItem, workspacePath: string, run: vscode.TestRun) => {
	try {
		logger.appendLine(`Running test: ${testItem.id}`);
		const { code, stdout } = await spawnBazelTestProcess(testItem.id, workspacePath);
		const { bazelLog, testLog } = parseBazelStdoutOutput(stdout);
		const output = generateTestResultMessage(testItem.id, code, testLog, bazelLog);

		run.appendOutput(output.replace(/\r?\n/g, '\r\n') + "\r\n");

		if (code === 0) {
			run.passed(testItem);
		} else {
			run.failed(testItem, new vscode.TestMessage(output));
		}
	} catch (error) {
		const message = `❌ Error executing test: ${(error as Error).message}`;
		run.appendOutput(message.replace(/\r?\n/g, '\r\n') + "\r\n");
		run.failed(testItem, new vscode.TestMessage(message));
	}
};

// 📌 Reload Bazel Tests Command
const reloadBazelTests = async () => {
	// Reset discovery flag to force re-querying Bazel
	testDiscoveryCompleted = false;

	const now = Date.now();
	if (now - lastReloadTimestamp < RELOAD_INTERVAL_MS) {
		logger.appendLine(`Skipping test reload: Last update was too recent.`);
		return;
	}

	lastReloadTimestamp = now;
	logger.appendLine("🔄 Reloading Bazel tests...");
	await discoverAndDisplayTests();

};

vscode.commands.registerCommand("extension.reloadBazelTests", reloadBazelTests);

const getRunnerConfig = () => {
	const config = vscode.workspace.getConfiguration("bazelTestRunner");
	return {
		sequentialTestTypes: config.get("sequentialTestTypes", ["java_test"])
	};
};

const executeAllTestsInPackage = async (
	testItem: vscode.TestItem,
	config: { sequentialTestTypes: string[] },
	run: vscode.TestRun,
	workspacePath: string,
	packageResults: Map<string, { passed: number, total: number }>
) => {
	const testTargets = await queryBazelTestTargets(workspacePath);
	const filteredTestTargets = testTargets.filter(({ target }) => {
		const targetPackage = target.split(":")[0];
		return targetPackage === testItem.id;
	});

	logger.appendLine(`📦 Package detected: ${testItem.id}, Found tests: ${filteredTestTargets.length}`);

	if (filteredTestTargets.length === 0) {
		vscode.window.showErrorMessage(`No tests found in ${testItem.id}`);
		logger.appendLine(`⚠️ No tests found in package: ${testItem.id}`);
		return;
	}

	packageResults.set(testItem.id, { passed: 0, total: filteredTestTargets.length });

	const isSequential = filteredTestTargets.some(({ target }) =>
		config.sequentialTestTypes.some(type => target.includes(type))
	);

	for (const { target } of filteredTestTargets) {
		const packageName = target.split(":")[0];
		const packageItem = bazelTestController.items.get(packageName);
		const childTestItem = packageItem?.children.get(target);

		if (!childTestItem) {
			logger.appendLine(`⚠️ Warning: Test item not found for ${target}`);
			continue;
		}

		logger.appendLine(`▶️ Running test: ${target}`);
		const testPromise = executeBazelTest(childTestItem, workspacePath, run).then(() => {
			const packageEntry = packageResults.get(packageName);
			if (packageEntry) packageEntry.passed++;
		});

		if (isSequential) {
			await testPromise;
		} else {
			await testPromise;
		}
	}
};

const queueIndividualTestExecution = async (
	testItem: vscode.TestItem,
	run: vscode.TestRun,
	workspacePath: string,
	testPromises: Promise<void>[]
) => {
	logger.appendLine(`▶️ Running single test: ${testItem.id}`);
	testPromises.push(executeBazelTest(testItem, workspacePath, run));
};

const summarizePackageResults = (
	packageResults: Map<string, { passed: number, total: number }>
) => {
	for (const [packageId, { passed, total }] of packageResults) {
		const packageItem = bazelTestController.items.get(packageId);
		if (packageItem) packageItem.label = `${packageId} (${passed}/${total})`;
	}
};

// ─── Test Controller Activation ────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
	if (extensionActivated) {
		logger.appendLine("Skipping duplicate activation.");
		return;
	}
	extensionActivated = true;

	bazelTestController = vscode.tests.createTestController('bazelUnityTestController', 'Bazel Unity Tests');
	context.subscriptions.push(bazelTestController);

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
	vscode.commands.registerCommand("extension.showBazelTests", discoverAndDisplayTests);

	// 📌 Automatically Reload When Switching to Test Explorer
	vscode.window.onDidChangeVisibleTextEditors(() => {
		const isTestExplorerActive = vscode.window.activeTextEditor?.document.uri.scheme === "vscode-test-explorer";
		if (isTestExplorerActive) {
			reloadBazelTests();
		}
	});

	// 📌 Run tests
	const runTests = async (request: vscode.TestRunRequest, token: vscode.CancellationToken) => {
		const run = bazelTestController.createTestRun(request);
		const workspacePath = await findBazelWorkspace();
		if (!workspacePath) {
			vscode.window.showErrorMessage("No Bazel workspace detected.");
			logger.appendLine("❌ No Bazel workspace detected.");
			return;
		}

		logger.appendLine(`🔹 Starting test execution...`);
		const testPromises: Promise<void>[] = [];
		const packageResults: Map<string, { passed: number, total: number }> = new Map();
		const config = getRunnerConfig();

		for (const testItem of request.include ?? []) {
			run.started(testItem);
			logger.appendLine(`🔹 Processing test item: ${testItem.id}`);

			if (!testItem.id.includes(":")) {
				await executeAllTestsInPackage(testItem, config, run, workspacePath, packageResults);
			} else {
				await queueIndividualTestExecution(testItem, run, workspacePath, testPromises);
			}
		}

		await Promise.allSettled(testPromises);
		run.end();

		summarizePackageResults(packageResults);
		logger.appendLine(`✅ Test execution completed.`);
	};

	bazelTestController.createRunProfile('Run Tests', vscode.TestRunProfileKind.Run, runTests, true);
	discoverAndDisplayTests();
}

// ─── Extension Lifecycle ───────────────────────────────────────────────
export function deactivate() { }