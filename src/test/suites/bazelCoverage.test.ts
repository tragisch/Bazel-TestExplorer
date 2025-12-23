/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/// <reference types="mocha" />
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { pickLatestArtifact } from '../../bazelCoverage';

suite('Bazel Coverage Utilities', () => {
	test('pickLatestArtifact returns newest file', async () => {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
		const root = path.join(workspaceRoot, 'test_temp', 'coverage_pick');
		fs.mkdirSync(root, { recursive: true });

		const older = path.join(root, 'old.lcov');
		const newer = path.join(root, 'new.lcov');
		fs.writeFileSync(older, 'old');
		fs.writeFileSync(newer, 'new');

		const now = Date.now() / 1000;
		fs.utimesSync(older, now - 1000, now - 1000);
		fs.utimesSync(newer, now, now);

		const result = await pickLatestArtifact([older, newer]);
		assert.strictEqual(result, newer);

		fs.rmSync(root, { recursive: true, force: true });
	});
});
