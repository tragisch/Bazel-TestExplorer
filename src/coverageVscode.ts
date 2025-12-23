/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import * as vscode from 'vscode';
import { resolveCoverageFilePath } from './coverageParser';

const coverageDetailsByUri = new Map<string, vscode.FileCoverageDetail[]>();

export const parseLcovToFileCoverage = (
	lcov: string,
	baseFolder: string,
	fallbackRoot?: string
): vscode.FileCoverage[] => {
	const coverageByFile = new Map<string, Map<number, number>>();
	let currentFile: string | undefined;

	for (const rawLine of lcov.replace(/\r\n/g, '\n').split('\n')) {
		const line = rawLine.trim();
		if (!line) continue;

		if (line.startsWith('SF:')) {
			const sfPath = line.slice(3);
			const resolved = resolveCoverageFilePath(sfPath, baseFolder, fallbackRoot);
			currentFile = resolved;
			if (!coverageByFile.has(resolved)) {
				coverageByFile.set(resolved, new Map());
			}
			continue;
		}

		if (line.startsWith('DA:') && currentFile) {
			const [lineNo, hits] = line.slice(3).split(',');
			const lineNum = Number(lineNo) - 1;
			const hitNum = Number(hits);
			if (!Number.isFinite(lineNum) || !Number.isFinite(hitNum) || lineNum < 0) {
				continue;
			}
			const fileMap = coverageByFile.get(currentFile);
			if (!fileMap) continue;
			const previous = fileMap.get(lineNum) ?? 0;
			fileMap.set(lineNum, previous + hitNum);
			continue;
		}
	}

	const results: vscode.FileCoverage[] = [];
	for (const [filePath, lineMap] of coverageByFile.entries()) {
		const details: vscode.FileCoverageDetail[] = [];
		for (const [lineNum, hitCount] of lineMap.entries()) {
			details.push(new vscode.StatementCoverage(hitCount, new vscode.Position(lineNum, 0)));
		}
		const uri = vscode.Uri.file(filePath);
		const coverage = vscode.FileCoverage.fromDetails(uri, details);
		coverageDetailsByUri.set(uri.toString(), details);
		results.push(coverage);
	}

	return results;
};

export const getCoverageDetailsForFile = (coverage: vscode.FileCoverage): vscode.FileCoverageDetail[] => {
	return coverageDetailsByUri.get(coverage.uri.toString()) ?? [];
};
