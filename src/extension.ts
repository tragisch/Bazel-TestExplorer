import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { glob } from 'glob';
import * as fs from 'fs';
import * as util from 'util';

const readFile = util.promisify(fs.readFile);

const getTestLogPath = (testTarget: string, workspacePath: string): string => {
	// Entferne das führende "//" aus dem Test-Target
	const normalizedTarget = testTarget.replace(/^\/\//, '');
	// Ersetze ":" durch "/" für den Verzeichnisnamen
	const logPath = path.join(workspacePath, 'bazel-testlogs', normalizedTarget.replace(':', '/'), 'test.log');
	return logPath;
};

const waitForFile = async (filePath: string, timeout = 5000) => {
	const startTime = Date.now();
	while (!fs.existsSync(filePath)) {
		if (Date.now() - startTime > timeout) {
			throw new Error(`Timeout: ${filePath} wurde nicht gefunden.`);
		}
		await new Promise(resolve => setTimeout(resolve, 200)); // Warte 200ms
	}
};

const readTestLog = async (logPath: string): Promise<string> => {
	try {
		await waitForFile(logPath, 5000); // Warte auf test.log, falls noch nicht geschrieben
		return await readFile(logPath, 'utf-8');
	} catch (error) {
		logger.appendLine(`Error reading test log ${logPath}: ${error}`);
		return `Fehler beim Lesen von ${logPath}: ${error}`;
	}
};

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

			// 🔎 Run Bazel query to find tests
			let testTargets: string[] = [];

			try {
				const result = await runCommand('bazel query "kind(cc_test, //...)"', workspacePath);
				testTargets = result.split('\n')
					.map(line => line.trim()) // Leerzeichen entfernen
					.filter(line => line.startsWith("cc_test rule")) // Nur gültige Zeilen behalten
					.map(line => line.replace(/^cc_test rule /, "").trim()); // "cc_test rule" entfernen

				logger.appendLine(`Extracted test targets:\n${testTargets.join("\n")}`);
			} catch (error) {
				logger.appendLine(`Bazel query failed: ${error}`);
			}

			// 🔎 If Bazel query fails, fallback to scanning C++ test files
			// if (testTargets.length === 0) {
			// 	logger.appendLine("Bazel query returned no tests. Scanning for C test files...");
			// 	const cppFiles = await glob("tests/**/*.c", { nodir: true, absolute: true, cwd: workspacePath });
			// 	testTargets = cppFiles.map(file => `//${path.relative(workspacePath, file)}`);
			// }

			if (testTargets.length === 0) {
				vscode.window.showErrorMessage("No Bazel tests found with query.");
				return;
			}

			// 📌 Log test discovery results
			logger.appendLine(`Discovered tests:\n${testTargets.join("\n")}`);

			if (testTargets.length === 0) {
				vscode.window.showInformationMessage("No Bazel tests found.");
				return;
			}

			// 📌 Keep the new tab with discovered tests
			const doc = await vscode.workspace.openTextDocument({
				content: testTargets.join("\n"),
				language: "plaintext"
			});
			vscode.window.showTextDocument(doc);

			// 📌 Register tests in the VS Code Test Explorer
			testController.items.replace([]);
			const root = testController.createTestItem('bazel_tests', 'Bazel Tests');
			testController.items.add(root);

			testTargets.forEach(target => {
				logger.appendLine(`Adding test target: ${target}`);
				const testItem = testController.createTestItem(target, target);
				root.children.add(testItem);
				testItem.canResolveChildren = false;
			});

		} catch (error) {
			vscode.window.showErrorMessage(`Failed to discover tests: ${(error as any).message}`);
			logger.appendLine(`Error in showDiscoveredTests: ${error}`);
		}
	};

	const deleteOldTestLog = (testItem: vscode.TestItem, workspacePath: string) => {
		const logPath = getTestLogPath(testItem.id, workspacePath);
		if (fs.existsSync(logPath)) {
			try {
				fs.unlinkSync(logPath); // Delete old test.log
				logger.appendLine(`Deleted old log file: ${logPath}`);
			} catch (deleteError) {
				logger.appendLine(`Error deleting log file ${logPath}: ${deleteError}`);
			}
		}
	};

	const executeBazelTest = async (testItem: vscode.TestItem, workspacePath: string): Promise<string | null> => {
		try {
			logger.appendLine(`Running test: ${testItem.id}`);
			await runCommand(`bazel test ${testItem.id}`, workspacePath);
			return null; // No error, test ran successfully
		} catch (error) {
			logger.appendLine(`Test ${testItem.id} failed:\n${error}`);
			return `ERROR: ${error}`; // Return the error message
		}
	};

	const handleTestResult = async (testItem: vscode.TestItem, workspacePath: string, errorMessage: string | null, run: vscode.TestRun) => {
		const logPath = getTestLogPath(testItem.id, workspacePath);

		if (!errorMessage && fs.existsSync(logPath)) {
			try {
				let logContent = await readTestLog(logPath);

				logContent = logContent
					.split(/\r?\n/)
					.map(line => line.trimStart())
					.join("\r\n");

				run.appendOutput(`\r\n--- Test Output (${testItem.id}) ---\r\n${logContent}\r\n--- End of Log ---\r\n`);

				if (!logContent.includes(':FAIL')) {
					run.passed(testItem);
				} else {
					run.failed(testItem, new vscode.TestMessage("Failed tests detected!"));
				}
				return;
			} catch (logError) {
				logger.appendLine(`Error reading log for ${testItem.id}: ${logError}`);
				errorMessage = `Error loading test log: ${logError}`;
			}
		}

		// If no log exists, show the error message
		let formattedError = errorMessage ?? "Unknown error";
		formattedError = formattedError
			.split(/\r?\n/)
			.map(line => line.trimStart())
			.join("\r\n");

		run.appendOutput(`\r\n--- Compilation Error for ${testItem.id} ---\r\n${formattedError}\r\n--- End of Error ---\r\n`);
		run.failed(testItem, new vscode.TestMessage(formattedError));
	};

	const runTests = async (request: vscode.TestRunRequest, token: vscode.CancellationToken) => {
		const run = testController.createTestRun(request);

		const workspacePath = await findBazelWorkspace();
		if (!workspacePath) {
			vscode.window.showErrorMessage("No Bazel workspace detected.");
			return;
		}

		for (const testItem of request.include ?? []) {
			run.started(testItem);
			deleteOldTestLog(testItem, workspacePath);
			const errorMessage = await executeBazelTest(testItem, workspacePath);
			await handleTestResult(testItem, workspacePath, errorMessage, run);
		}

		run.end();
	};


	testController.createRunProfile('Run Tests', vscode.TestRunProfileKind.Run, runTests, true);

	showDiscoveredTests();
	vscode.commands.registerCommand("extension.showBazelTests", showDiscoveredTests);
}

export function deactivate() { }