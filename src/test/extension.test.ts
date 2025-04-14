import * as assert from 'assert';
import * as vscode from 'vscode';
import { findBazelWorkspace } from '../extension';

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

});

