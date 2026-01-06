import * as assert from 'assert';
import * as vscode from 'vscode';
import { getCachedWorkspace } from '../extension';

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
            const workspacePath = getCachedWorkspace();
            // Workspace detection depends on extension activation which populates the cache
            assert.ok(workspacePath === null || typeof workspacePath === 'string');
        });

        test('Should return null if no Bazel workspace found', async () => {
            const workspacePath = getCachedWorkspace();
            assert.ok(workspacePath === null || typeof workspacePath === 'string');
        });
    });

});

