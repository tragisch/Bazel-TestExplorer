/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import { logWithTimestamp } from './logging';

export type DemanglerKind = 'cpp' | 'rust';

const defaultTools: Record<DemanglerKind, string> = {
	cpp: 'c++filt',
	rust: 'rustfilt'
};

export const demangleSymbols = async (
	symbols: string[],
	kind: DemanglerKind,
	toolPath?: string
): Promise<string[]> => {
	if (symbols.length === 0) return symbols;

	const tool = toolPath || defaultTools[kind];
	if (toolPath && !fs.existsSync(toolPath)) {
		logWithTimestamp(`Demangler not found at ${toolPath}. Returning original symbols.`, 'warn');
		return symbols;
	}

	return new Promise((resolve) => {
		let stdout = '';
		let stderr = '';

		const child = cp.spawn(tool, [], { stdio: 'pipe' });
		child.on('error', (err) => {
			logWithTimestamp(`Demangler failed (${tool}): ${String(err)}. Returning original symbols.`, 'warn');
			resolve(symbols);
		});
		child.stdout.on('data', (data) => {
			stdout += data.toString();
		});
		child.stderr.on('data', (data) => {
			stderr += data.toString();
		});
		child.on('close', (code) => {
			if (code !== 0) {
				logWithTimestamp(`Demangler exited with code ${code}: ${stderr.trim()}`, 'warn');
				resolve(symbols);
				return;
			}
			const demangled = stdout.split(/\r?\n/).filter(line => line.length > 0);
			resolve(demangled.length === symbols.length ? demangled : symbols);
		});

		child.stdin.write(symbols.join('\n'));
		child.stdin.end();
	});
};
