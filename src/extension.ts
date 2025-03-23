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
const outputChannel = vscode.window.createOutputChannel('Log', 'log');
let logger: vscode.OutputChannel;
const formatError = (error: unknown): string =>
	error instanceof Error ? error.stack || error.message : JSON.stringify(error, null, 2);

let reloadTimeout: NodeJS.Timeout | undefined;

const logWithTimestamp = (message: string, level: "info" | "warn" | "error" = "info") => {
	const now = new Date().toISOString().replace("T", " ").replace("Z", "");
	const timestamp = `${now} `;

	let tag = `[Info] `;
	if (level === "warn") tag = `[Warn] `;
	if (level === "error") tag = `[Error] `;

	const indentedMessage = message.split("\n").map(line => `  ${line}`).join("\n");
	logger.appendLine(`${timestamp} ${tag} ${indentedMessage}`);
};

const scheduleReload = (delay = 1000) => {
	if (reloadTimeout) {
		clearTimeout(reloadTimeout);
	}
	reloadTimeout = setTimeout(() => {
		reloadBazelTests();
	}, delay);
};

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
		logWithTimestamp(`Executing Bazel query: ${command}`);

		let result: string;
		try {
			result = await execShellCommand(command, workspacePath);
		} catch (error) {
			logWithTimestamp(`No test targets found in path "${path}". Skipping.`);
			continue; // Skip this path, but keep processing others
		}

		if (!result.trim()) {
			logWithTimestamp(`No test targets found in path: ${path}`); // Log info, but NOT an error
			continue; // Skip this path but keep results from others
		}

		const lines = result.split("\n").map(line => line.trim());

		const tests = lines.map(line => {
			const match = line.match(/^(\S+) rule (\/\/.+)$/);
			return match ? { type: match[1], target: match[2] } : null;
		}).filter((entry): entry is { type: string; target: string } => entry !== null);

		extractedTests.push(...tests);
	}

	logWithTimestamp(`Found ${extractedTests.length} test targets in Bazel workspace.`);
	return extractedTests;
};

// ─── Test Discovery Logic ──────────────────────────────────────────────
const getWorkspaceOrShowError = async (): Promise<string | null> => {
	const workspacePath = await findBazelWorkspace();
	if (!workspacePath) {
		vscode.window.showErrorMessage("No Bazel workspace detected.");
		return null;
	}
	logWithTimestamp(`Bazel workspace found at: ${workspacePath}`);
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

	let testItem;
	const guessedFilePath = path.join(vscode.workspace.workspaceFolders?.[0].uri.fsPath || '', packageName, `${testName}.c`);
	const uri = fs.existsSync(guessedFilePath) ? vscode.Uri.file(guessedFilePath) : undefined;
	testItem = bazelTestController.createTestItem(target, `${testTypeLabel} ${testName}`, uri);
	packageItem.children.add(testItem);

	testItem.canResolveChildren = false;
};

// 📌 Show discovered tests in the Test Explorer
const discoverAndDisplayTests = async () => {
	try {
		const workspacePath = await getWorkspaceOrShowError();
		if (!workspacePath) return;

		const testEntries = await queryBazelTestTargets(workspacePath);

		const currentTestIds = new Set(testEntries.map(entry => entry.target));
		bazelTestController.items.forEach((item) => {
			const id = item.id;
			if (!currentTestIds.has(id)) {
				logWithTimestamp(`Removing stale test item: ${id}`);
				bazelTestController.items.delete(id);
			}
		});

		testEntries.forEach(({ target, type }) => {
			addTestItemToController(target, type);
		});

		const testIds: string[] = [];
		bazelTestController.items.forEach((item) => {
			testIds.push(item.id);
		});
		logWithTimestamp(`Registered test targets:\n${testIds.join("\n")}`);
		testDiscoveryCompleted = true;

	} catch (error) {
		const message = formatError(error);
		vscode.window.showErrorMessage(`❌ Failed to discover tests:\n${message}`);
		logWithTimestamp(`❌ Error in discoverAndDisplayTests:\n${message}`);
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
const generateTestResultMessage = (
	testId: string,
	code: number,
	testLog: string[],
	bazelLog: string[],
	fullBazelOut?: string,
	fullStderr?: string
): string => {
	let status = "";
	switch (code) {
		case 0:
			status = "✅ **Test Passed (Code 0)**";
			break;
		case 3:
			status = "❌ **Some Tests Failed (Code 3)**";
			break;
		case 4:
			status = "⚠️ **Flaky Test Passed (Code 4)**";
			break;
		case 1:
		default:
			status = `🧨 **Build or Config Error (code ${code})**`;
			break;
	}
	const header = `${status}: ${testId}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
	let output = header;
	switch (code) {
		case 0:
			output += "📄 **Test Log:**\n" + testLog.join("\n") + "\n";
			break;
		case 3:
			output += "📄 **Test Log:**\n" + testLog.join("\n") + "\n";
			output += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📌 **Bazel Output:**\n" + bazelLog.join("\n") + "\n";
			break;
		case 4:
			output += "📄 **Test Log (with flakes):**\n" + testLog.join("\n") + "\n";
			output += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📌 **Bazel Output:**\n" + bazelLog.join("\n") + "\n";
			break;
		case 1:
		case 1:
		default:
			output += "📌 **Bazel Output:**\n" + (fullBazelOut?.trim() ?? bazelLog.join("\n")) + "\n";
			if (fullStderr && fullStderr.trim()) {
				output += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📕 **Bazel stderr:**\n" + fullStderr.trim() + "\n";
			}
			if (testLog.length > 0) {
				output += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📄 **Test Log:**\n" + testLog.join("\n") + "\n";
			}
			break;
	}
	output += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";
	return output;
};

// 📌 Execute Bazel test
export const executeBazelTest = async (testItem: vscode.TestItem, workspacePath: string, run: vscode.TestRun) => {
	try {
		logWithTimestamp(`Running test: ${testItem.id}`);
		const { code, stdout, stderr } = await spawnBazelTestProcess(testItem.id, workspacePath);
		const { bazelLog, testLog } = parseBazelStdoutOutput(stdout);
		const output = generateTestResultMessage(testItem.id, code, testLog, bazelLog, stdout, stderr);

		run.appendOutput(output.replace(/\r?\n/g, '\r\n') + "\r\n");

		if (code === 0) {
			run.passed(testItem);
		} else {
			const message = new vscode.TestMessage(output);

			const failLine = testLog.find(line => line.match(/^.+?:\d+:.*FAIL/));
			if (failLine) {
				const match = failLine.match(/^(.+?):(\d+):/);
				logWithTimestamp(`Trying to extract from: ${failLine}`);
				if (match) {
					const [, file, line] = match;
					const fullPath = path.isAbsolute(file)
						? file
						: path.join(workspacePath, file);
					if (fs.existsSync(fullPath)) {
						const uri = vscode.Uri.file(fullPath);
						const location = new vscode.Location(uri, new vscode.Position(Number(line) - 1, 0));
						message.location = location;
					} else {
						logWithTimestamp(`File not found: ${fullPath}`);
					}
				} else {
					logWithTimestamp(`Regex did not match: ${failLine}`);
				}
			}

			run.failed(testItem, message);
			//open open the raw test log
			// const logPathLine = testLog.find(line => line.includes("/testlogs/") && line.trim().endsWith(".log"));
			// const logPathLineClean = logPathLine ? logPathLine.trim() : '';
			// if (logPathLineClean && fs.existsSync(logPathLineClean)) {
			// 	vscode.window.showInformationMessage("Test failed. View full test log?", "📄 Open Full Log").then(selection => {
			// 		if (selection === "📄 Open Full Log") {
			// 			vscode.workspace.openTextDocument(logPathLineClean).then(doc =>
			// 				vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside })
			// 			);
			// 		}
			// 	});
			// }
		}
	} catch (error) {
		const message = formatError(error);
		run.appendOutput(`Error executing test:\n${message}`.replace(/\r?\n/g, '\r\n') + "\r\n");
		run.failed(testItem, new vscode.TestMessage(message));
	}
};

// 📌 Reload Bazel Tests Command
const reloadBazelTests = async () => {
	// Reset discovery flag to force re-querying Bazel
	testDiscoveryCompleted = false;

	logWithTimestamp("Reloading Bazel tests...");
	try {
		await discoverAndDisplayTests();
	} catch (error) {
		const message = formatError(error);
		vscode.window.showErrorMessage(`❌ Reload failed:\n${message}`);
		logWithTimestamp(`❌ Error in reloadBazelTests:\n${message}`);
	}
};

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

	logWithTimestamp(`Package detected: ${testItem.id}, Found tests: ${filteredTestTargets.length}`);

	if (filteredTestTargets.length === 0) {
		vscode.window.showErrorMessage(`No tests found in ${testItem.id}`);
		logWithTimestamp(`No tests found in package: ${testItem.id}`);
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
			logWithTimestamp(`Warning: Test item not found for ${target}`);
			continue;
		}

		logWithTimestamp(`Running test: ${target}`);
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
	logWithTimestamp(`Running single test: ${testItem.id}`);
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
	logger = vscode.window.createOutputChannel("Bazel-Test-Logs");
	context.subscriptions.push(logger);
	if (extensionActivated) {
		logWithTimestamp("Skipping duplicate activation.");
		return;
	}
	extensionActivated = true;

	bazelTestController = vscode.tests.createTestController('bazelUnityTestController', 'Bazel Unity Tests');
	context.subscriptions.push(bazelTestController);

	// Listen for VS Code testing settings changes and update accordingly
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration('testing.countBadge') ||
				e.affectsConfiguration('testing.gutterEnabled') ||
				e.affectsConfiguration('testing.defaultGutterClickAction')
			) {
				logWithTimestamp("VS Code testing settings updated.");
				// Automatically update test UI if needed
			}
		})
	);

	// 📌 Register the command properly
	context.subscriptions.push(
		vscode.commands.registerCommand("extension.reloadBazelTests", reloadBazelTests)
	);

	// 📌 Automatically Reload When Switching to Test Explorer
	context.subscriptions.push(
		vscode.window.onDidChangeVisibleTextEditors(() => {
			scheduleReload();
		})
	);

	// 📌 Run tests
	const runTests = async (request: vscode.TestRunRequest, token: vscode.CancellationToken) => {
		try {
			const run = bazelTestController.createTestRun(request);
			const workspacePath = await findBazelWorkspace();
			if (!workspacePath) {
				vscode.window.showErrorMessage("No Bazel workspace detected.");
				logWithTimestamp("No Bazel workspace detected.");
				return;
			}

			logWithTimestamp(`Starting test execution...`);
			const testPromises: Promise<void>[] = [];
			const packageResults: Map<string, { passed: number, total: number }> = new Map();
			const config = getRunnerConfig();

			for (const testItem of request.include ?? []) {
				run.started(testItem);
				logWithTimestamp(`Processing test item: ${testItem.id}`);

				if (!testItem.id.includes(":")) {
					await executeAllTestsInPackage(testItem, config, run, workspacePath, packageResults);
				} else {
					await queueIndividualTestExecution(testItem, run, workspacePath, testPromises);
				}
			}

			await Promise.allSettled(testPromises);
			run.end();

			summarizePackageResults(packageResults);
			logWithTimestamp(`Test execution completed.`);
		} catch (error) {
			const message = formatError(error);
			vscode.window.showErrorMessage(`❌ Test run failed:\n${message}`);
			logWithTimestamp(`Error in runTests:\n${message}`);
		}
	};

	bazelTestController.createRunProfile('Run Tests', vscode.TestRunProfileKind.Run, runTests, true);
	discoverAndDisplayTests();
}

// ─── Extension Lifecycle ───────────────────────────────────────────────
export function deactivate() { }