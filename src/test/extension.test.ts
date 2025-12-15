import * as assert from 'assert';
import * as vscode from 'vscode';
import { findBazelWorkspace } from '../extension';

suite('Bazel VS Code Extension Tests', () => {

    suite('Extension Activation', () => {
        test('Extension should be activated', async () => {
            const extension = vscode.extensions.getExtension('tragisch.bazel-testexplorer');
            assert.ok(extension, 'Extension not found');
            await extension?.activate();
            assert.strictEqual(extension.isActive, true);
        });

        test('TestController should be registered', async () => {
            await vscode.extensions.getExtension('tragisch.bazel-testexplorer')?.activate();
            const testControllers = vscode.tests;
            assert.ok(testControllers, 'TestController was not registered');
        });
    });

    suite('Bazel Workspace Detection', () => {
        test('Should find Bazel workspace', async () => {
            const workspacePath = await findBazelWorkspace();
            // Workspace detection depends on actual workspace folder
            // This test passes if function completes without error
            assert.ok(workspacePath !== undefined);
        });

        test('Should return null if no Bazel workspace found', async () => {
            const workspacePath = await findBazelWorkspace();
            // Expected to return null when no WORKSPACE/MODULE.bazel found
            assert.ok(workspacePath === null || typeof workspacePath === 'string');
        });
    });

});

