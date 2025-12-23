/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface CoverageLine {
	line: number;
	hits: number;
}

export interface CoverageFile {
	path: string;
	lines: CoverageLine[];
}

export interface CoverageModel {
	files: CoverageFile[];
}

export const parseLcov = (content: string): CoverageModel => {
	const files: CoverageFile[] = [];
	let current: CoverageFile | null = null;

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;

		if (line.startsWith('SF:')) {
			if (current) {
				files.push(current);
			}
			current = {
				path: line.slice(3),
				lines: []
			};
			continue;
		}

		if (line.startsWith('DA:') && current) {
			const [lineNo, hits] = line.slice(3).split(',');
			const lineNum = Number(lineNo);
			const hitNum = Number(hits);
			if (Number.isFinite(lineNum) && Number.isFinite(hitNum)) {
				current.lines.push({ line: lineNum, hits: hitNum });
			}
			continue;
		}

		if (line === 'end_of_record' && current) {
			files.push(current);
			current = null;
		}
	}

	if (current) {
		files.push(current);
	}

	return { files };
};

export const resolveCoverageFilePath = (
	filePath: string,
	workspaceRoot: string,
	fallbackRoot?: string
): string => {
	if (!filePath) return filePath;
	if (path.isAbsolute(filePath)) return filePath;
	const primary = path.join(workspaceRoot, filePath);
	if (fs.existsSync(primary)) {
		return primary;
	}
	if (fallbackRoot) {
		const fallback = path.join(fallbackRoot, filePath);
		if (fs.existsSync(fallback)) {
			return fallback;
		}
	}
	const cwdResolved = path.resolve(filePath);
	if (fs.existsSync(cwdResolved)) {
		return cwdResolved;
	}
	return primary;
};
