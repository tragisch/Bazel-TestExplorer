/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logWithTimestamp } from './logging';
import { trackBazelProcess, untrackBazelProcess } from './bazel/process';

export interface CoverageRunConfig {
	bazelBinary: string;
	args: string[];
	workspaceRoot: string;
}

export interface CoverageArtifacts {
	lcov: string[];
	profraw: string[];
	profdata: string[];
	testlogs: string[];
}

export class BazelCoverageRunner {
	constructor(private readonly outputChannel: vscode.OutputChannel) {}

	runCoverage(config: CoverageRunConfig, cancellationToken?: vscode.CancellationToken): Promise<number> {
		return new Promise((resolve, reject) => {
			logWithTimestamp(`Starting bazel coverage: ${config.bazelBinary} ${config.args.join(' ')}`);
			const child = cp.spawn(config.bazelBinary, config.args, {
				cwd: config.workspaceRoot,
				stdio: 'pipe'
			});
			trackBazelProcess(child);

			child.stdout.on('data', (data) => this.outputChannel.append(data.toString()));
			child.stderr.on('data', (data) => this.outputChannel.append(data.toString()));

			cancellationToken?.onCancellationRequested(() => {
				logWithTimestamp('Bazel coverage cancelled by user.', 'warn');
				child.kill('SIGTERM');
			});

			child.on('error', (err) => {
				untrackBazelProcess(child);
				reject(err);
			});
			child.on('close', (code) => {
				untrackBazelProcess(child);
				resolve(code ?? 0);
			});
		});
	}
}

export const resolveBazelInfo = async (
	bazelBinary: string,
	workspaceRoot: string,
	infoKey: string,
	cancellationToken?: vscode.CancellationToken
): Promise<string | undefined> => {
	return new Promise((resolve) => {
		const child = cp.spawn(bazelBinary, ['info', infoKey], {
			cwd: workspaceRoot,
			stdio: 'pipe'
		});
		let output = '';
		child.stdout.on('data', (data) => {
			output += data.toString();
		});
		child.on('error', () => resolve(undefined));
		cancellationToken?.onCancellationRequested(() => {
			child.kill('SIGTERM');
			resolve(undefined);
		});
		child.on('close', () => {
			resolve(output.trim() || undefined);
		});
	});
};

export const findCoverageArtifacts = async (
	searchRoots: string[],
	cancellationToken?: vscode.CancellationToken
): Promise<CoverageArtifacts> => {
	const results: CoverageArtifacts = { lcov: [], profraw: [], profdata: [], testlogs: [] };
	const visited = new Set<string>();
	const ignoreDirs = new Set(['.git', 'node_modules', 'bazel-out', 'bazel-bin', 'bazel-testlogs']);
	const lcovExt = new Set(['.lcov', '.dat']);
	const profrawExt = new Set(['.profraw']);
	const profdataExt = new Set(['.profdata']);

	const walk = async (dir: string): Promise<void> => {
		if (cancellationToken?.isCancellationRequested) return;
		if (visited.has(dir)) return;
		visited.add(dir);
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (cancellationToken?.isCancellationRequested) return;
			if (entry.isDirectory()) {
				if (ignoreDirs.has(entry.name)) continue;
				await walk(path.join(dir, entry.name));
				continue;
			}
			if (!entry.isFile()) continue;
			const fullPath = path.join(dir, entry.name);
			const ext = path.extname(entry.name);
			if (lcovExt.has(ext)) {
				results.lcov.push(fullPath);
			} else if (profrawExt.has(ext)) {
				results.profraw.push(fullPath);
			} else if (profdataExt.has(ext)) {
				results.profdata.push(fullPath);
			} else if (path.normalize(fullPath).split(path.sep).includes('bazel-testlogs')) {
				results.testlogs.push(fullPath);
			}
		}
	};

	for (const root of searchRoots) {
		if (!root) continue;
		await walk(root);
	}

	const dedupeSort = (items: string[]) =>
		Array.from(new Set(items)).sort((a, b) => a.localeCompare(b));
	return {
		lcov: dedupeSort(results.lcov),
		profraw: dedupeSort(results.profraw),
		profdata: dedupeSort(results.profdata),
		testlogs: dedupeSort(results.testlogs)
	};
};
