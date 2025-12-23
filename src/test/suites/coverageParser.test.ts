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
import { parseLcovToFileCoverage } from '../../coverage';

suite('Coverage Parser', () => {
	test('parses LCOV into coverage model', () => {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
		const fixturePath = path.join(workspaceRoot, 'test', 'fixtures', 'coverage', 'sample.lcov');
		const content = fs.readFileSync(fixturePath, 'utf8');
		const coverages = parseLcovToFileCoverage(content, workspaceRoot);

		assert.strictEqual(coverages.length >= 3, true);
		const fileNames = coverages.map(c => c.uri.fsPath);
		assert.strictEqual(fileNames.some(name => name.endsWith('fixture.ts')), true);
	});
});
