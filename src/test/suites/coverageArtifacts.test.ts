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
import { findCoverageArtifacts } from '../../bazel/coverage/artifacts';

suite('Coverage Artifacts', () => {
	test('finds coverage artifacts under a root', async () => {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
		const root = path.join(workspaceRoot, 'test_temp', 'coverage_artifacts');
		fs.mkdirSync(root, { recursive: true });
		const files = [
			path.join(root, 'coverage.lcov'),
			path.join(root, 'coverage.dat'),
			path.join(root, 'profile.profraw'),
			path.join(root, 'profile.profdata')
		];
		files.forEach(file => fs.writeFileSync(file, 'test'));

		const results = await findCoverageArtifacts([root]);
		assert.strictEqual(results.lcov.length, 2);
		assert.strictEqual(results.profraw.length, 1);
		assert.strictEqual(results.profdata.length, 1);

		files.forEach(file => {
			if (fs.existsSync(file)) fs.unlinkSync(file);
		});
		fs.rmSync(root, { recursive: true, force: true });
	});
});
