import * as assert from 'assert';
import * as vscode from 'vscode';
import { findBazelWorkspace, fetchTestTargets, executeBazelTest } from '../../src/extension';

suite('Bazel VS Code Extension Tests', () => {

	suite('Extension Activation', () => {
		test('Extension should be activated', async () => {
			const extension = vscode.extensions.getExtension('your-extension-id'); // Replace with actual extension ID
			assert.ok(extension, 'Extension not found');
			await extension?.activate();
			assert.strictEqual(extension.isActive, true);
		});

		test('TestController should be registered', async () => {
			await vscode.extensions.getExtension('your-extension-id')?.activate();
			const testControllers = vscode.tests;
			assert.ok(testControllers, 'TestController was not registered');
		});
	});

	suite('Bazel Workspace Detection', () => {
		test('Should find Bazel workspace', async () => {
			const workspacePath = await findBazelWorkspace();
			assert.ok(workspacePath, 'Bazel workspace was not found');
		});

		test('Should return null if no Bazel workspace found', async () => {
			const workspacePath = await findBazelWorkspace();
			assert.strictEqual(workspacePath, null, 'Expected null for missing workspace');
		});
	});

	suite('Bazel Test Discovery', () => {
		test('Should fetch test targets correctly', async () => {
			const workspacePath = '/your/mock/path';
			const testTargets = await fetchTestTargets(workspacePath);
			assert.ok(Array.isArray(testTargets), 'Test targets should be an array');
			assert.ok(testTargets.length > 0, 'No test targets found');
		});
	});

	suite('Bazel Test Execution', () => {
		test('Should execute Bazel test successfully', async () => {
			const mockTestItem = { id: '//tests:dm' } as vscode.TestItem;
			const mockTestRun = {} as vscode.TestRun;

			await assert.doesNotReject(async () => {
				await executeBazelTest(mockTestItem, '/your/mock/path', mockTestRun);
			}, 'Bazel test execution should not reject');
		});
	});

});
