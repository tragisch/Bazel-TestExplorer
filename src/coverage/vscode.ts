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

export const clearCoverageDetailsCache = (): void => {
	coverageDetailsByUri.clear();
};

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
		if (!line) {continue;}

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
			if (!fileMap) {continue;}
			const previous = fileMap.get(lineNum) ?? 0;
			fileMap.set(lineNum, previous + hitNum);
			continue;
		}

		if (line.startsWith('LF:') && currentFile) {
			const total = Number(line.slice(3));
			if (!Number.isFinite(total) || total <= 0) {continue;}
			const fileMap = coverageByFile.get(currentFile);
			if (!fileMap || fileMap.size > 0) {continue;}
			for (let i = 1; i <= total; i += 1) {
				fileMap.set(i - 1, 0);
			}
			continue;
		}

		if (line.startsWith('LH:') && currentFile) {
			const covered = Number(line.slice(3));
			if (!Number.isFinite(covered) || covered <= 0) {continue;}
			const fileMap = coverageByFile.get(currentFile);
			if (!fileMap || fileMap.size === 0) {continue;}
			let count = 0;
			for (const key of fileMap.keys()) {
				if (count >= covered) {break;}
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

const toLcovPath = (filePath: string): string => filePath.replace(/\\/g, '/');

const normalizeCoveragePath = (filePath: string, execRoot?: string): string => {
	if (!execRoot) {return filePath;}
	const normalizedExecRoot = path.normalize(execRoot);
	const normalizedPath = path.normalize(filePath);
	if (normalizedPath.startsWith(normalizedExecRoot + path.sep)) {
		return toLcovPath(path.relative(normalizedExecRoot, normalizedPath));
	}
	const execMarker = '/execroot/';
	if (filePath.includes(execMarker)) {
		const execMainMarker = '/execroot/_main/';
		if (filePath.includes(execMainMarker)) {
			const suffix = filePath.slice(filePath.indexOf(execMainMarker) + execMainMarker.length);
			return toLcovPath(suffix);
		}
		const suffix = filePath.slice(filePath.indexOf(execMarker) + execMarker.length);
		return toLcovPath(suffix);
	}
	return filePath;
};

export interface LcovNormalizeOptions {
	workspaceRoot: string;
	execRoot?: string;
	filterExternal?: boolean;
	filterBazelOut?: boolean;
}

export interface LcovNormalizeResult {
	content: string;
	rewritten: boolean;
	removedRecords: number;
	updatedRecords: number;
}

export const normalizeLcovContent = (
	lcov: string,
	options: LcovNormalizeOptions
): LcovNormalizeResult => {
	const normalizedWorkspace = path.normalize(options.workspaceRoot);
	const normalizedExecRoot = options.execRoot ? path.normalize(options.execRoot) : undefined;
	const lines = lcov.replace(/\r\n/g, '\n').split('\n');
	const output: string[] = [];
	let currentRecordFiltered = false;
	let removedRecords = 0;
	let updatedRecords = 0;
	let rewritten = false;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) {
			if (!currentRecordFiltered) {
				output.push(rawLine);
			}
			continue;
		}

		if (line.startsWith('SF:')) {
			// A new SF: line implicitly ends any previous record that
			// lacked an end_of_record marker (guards against truncated LCOV).
			currentRecordFiltered = false;

			const originalPath = line.slice(3).trim();
			const normalizedPath = normalizeLcovSourcePath(originalPath, normalizedWorkspace, normalizedExecRoot);
			const shouldFilter = shouldFilterCoveragePath(normalizedPath, options);
			if (shouldFilter) {
				currentRecordFiltered = true;
				removedRecords += 1;
				continue;
			}
			if (normalizedPath !== originalPath) {
				rewritten = true;
				updatedRecords += 1;
			}
			currentRecordFiltered = false;
			output.push(`SF:${normalizedPath}`);
			continue;
		}

		if (currentRecordFiltered) {
			if (line === 'end_of_record') {
				currentRecordFiltered = false;
			}
			continue;
		}

		output.push(rawLine);
	}

	return {
		content: output.join('\n'),
		rewritten,
		removedRecords,
		updatedRecords
	};
};

const normalizeLcovSourcePath = (
	filePath: string,
	workspaceRoot: string,
	execRoot?: string
): string => {
	const normalizedPath = path.normalize(filePath);
	if (execRoot && normalizedPath.startsWith(execRoot + path.sep)) {
		return toLcovPath(path.relative(execRoot, normalizedPath));
	}

	const execMainMarker = `${path.sep}execroot${path.sep}_main${path.sep}`;
	if (normalizedPath.includes(execMainMarker)) {
		const suffix = normalizedPath.slice(normalizedPath.indexOf(execMainMarker) + execMainMarker.length);
		return toLcovPath(suffix);
	}

	if (normalizedPath.startsWith(workspaceRoot + path.sep)) {
		return toLcovPath(path.relative(workspaceRoot, normalizedPath));
	}

	return toLcovPath(filePath);
};

const shouldFilterCoveragePath = (filePath: string, options: LcovNormalizeOptions): boolean => {
	const posixPath = toLcovPath(filePath);
	const stripped = posixPath.replace(/^[A-Za-z]:/, '');
	if (options.filterExternal) {
		if (stripped.startsWith('external/') || stripped.includes('/external/')) {
			return true;
		}
	}
	if (options.filterBazelOut) {
		if (stripped.startsWith('bazel-out/') || stripped.includes('/bazel-out/')) {
			return true;
		}
	}
	return false;
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

	if (names.length === 0) {return;}

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
