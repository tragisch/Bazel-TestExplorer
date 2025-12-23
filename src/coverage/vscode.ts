/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { demangleSymbols } from './demangler';
import { resolveCoverageFilePath } from './parser';

const coverageDetailsByUri = new Map<string, vscode.FileCoverageDetail[]>();

export const parseLcovToFileCoverage = (
	lcov: string,
	baseFolder: string,
	fallbackRoot?: string,
	execRoot?: string
): vscode.FileCoverage[] => {
	const coverageByFile = new Map<string, Map<number, number>>();
	let currentFile: string | undefined;

	for (const rawLine of lcov.replace(/\r\n/g, '\n').split('\n')) {
		const line = rawLine.trim();
		if (!line) continue;

		if (line.startsWith('SF:')) {
			const sfPath = line.slice(3);
			const normalized = normalizeCoveragePath(sfPath, execRoot);
			const resolved = resolveCoverageFilePath(normalized, baseFolder, fallbackRoot);
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

		if (line.startsWith('LF:') && currentFile) {
			const total = Number(line.slice(3));
			if (!Number.isFinite(total) || total <= 0) continue;
			const fileMap = coverageByFile.get(currentFile);
			if (!fileMap || fileMap.size > 0) continue;
			for (let i = 1; i <= total; i += 1) {
				fileMap.set(i - 1, 0);
			}
			continue;
		}

		if (line.startsWith('LH:') && currentFile) {
			const covered = Number(line.slice(3));
			if (!Number.isFinite(covered) || covered <= 0) continue;
			const fileMap = coverageByFile.get(currentFile);
			if (!fileMap || fileMap.size === 0) continue;
			let count = 0;
			for (const key of fileMap.keys()) {
				if (count >= covered) break;
				fileMap.set(key, 1);
				count += 1;
			}
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

const normalizeCoveragePath = (filePath: string, execRoot?: string): string => {
	if (!execRoot) return filePath;
	if (filePath.startsWith(execRoot)) {
		return filePath;
	}
	const execMarker = '/execroot/';
	if (filePath.includes(execMarker)) {
		const execMainMarker = '/execroot/_main/';
		if (filePath.includes(execMainMarker)) {
			const suffix = filePath.slice(filePath.indexOf(execMainMarker) + execMainMarker.length);
			return path.join(execRoot, suffix);
		}
		const suffix = filePath.slice(filePath.indexOf(execMarker) + execMarker.length);
		return path.join(execRoot, suffix);
	}
	return filePath;
};

export const demangleCoverageDetails = async (
	cppToolPath?: string,
	rustToolPath?: string
): Promise<void> => {
	const entries: vscode.DeclarationCoverage[] = [];
	const names: string[] = [];

	for (const details of coverageDetailsByUri.values()) {
		for (const detail of details) {
			if (detail instanceof vscode.DeclarationCoverage) {
				entries.push(detail);
				names.push(detail.name);
			}
		}
	}

	if (names.length === 0) return;

	const rustResults = await demangleSymbols(names, 'rust', rustToolPath);
	const cppResults = await demangleSymbols(names, 'cpp', cppToolPath);

	for (let i = 0; i < entries.length; i += 1) {
		const original = names[i];
		const rust = rustResults[i] ?? original;
		const cpp = cppResults[i] ?? original;
		if (rust !== original) {
			entries[i].name = rust;
		} else if (cpp !== original) {
			entries[i].name = cpp;
		}
	}
};
