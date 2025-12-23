/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
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

	runCoverage(config: CoverageRunConfig, cancellationToken?: vscode.CancellationToken): Promise<{ code: number; stdout: string; stderr: string }> {
		return new Promise((resolve, reject) => {
			logWithTimestamp(`Starting bazel coverage: ${config.bazelBinary} ${config.args.join(' ')}`);
			const child = cp.spawn(config.bazelBinary, config.args, {
				cwd: config.workspaceRoot,
				stdio: 'pipe'
			});
			trackBazelProcess(child);
			let stdout = '';
			let stderr = '';

			child.stdout.on('data', (data) => {
				const text = data.toString();
				stdout += text;
				this.outputChannel.append(text);
			});
			child.stderr.on('data', (data) => {
				const text = data.toString();
				stderr += text;
				this.outputChannel.append(text);
			});

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
				resolve({ code: code ?? 0, stdout, stderr });
			});
		});
	}
}

export const extractLcovPathFromOutput = (output: string): string | undefined => {
	const lines = output.split(/\r?\n/);
	for (const line of lines) {
		const marker = 'LCOV coverage report is located at ';
		const index = line.indexOf(marker);
		if (index === -1) continue;
		const pathPart = line.slice(index + marker.length).trim();
		if (pathPart.length > 0) {
			return pathPart;
		}
	}
	return undefined;
};

export const extractBazelBinExecPath = (output: string): string | undefined => {
	const matches = Array.from(output.matchAll(/bazel-bin\/[^\s]+/g));
	if (matches.length === 0) return undefined;
	return matches[matches.length - 1]?.[0];
};

export const convertProfrawToLcov = async (
	profrawFiles: string[],
	binaryPath: string,
	cancellationToken?: vscode.CancellationToken
): Promise<{ path: string; content: string } | undefined> => {
	if (profrawFiles.length === 0) return undefined;
	const profdataPath = path.join(os.tmpdir(), `bazel-coverage-${Date.now()}.profdata`);

	const runTool = async (tool: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> => {
		return new Promise((resolve) => {
			if (cancellationToken?.isCancellationRequested) {
				resolve({ ok: false, stdout: '', stderr: 'cancelled' });
				return;
			}
			const child = cp.spawn(tool, args, { stdio: 'pipe' });
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (data) => (stdout += data.toString()));
			child.stderr.on('data', (data) => (stderr += data.toString()));
			child.on('error', (err) => {
				resolve({ ok: false, stdout, stderr: String(err) });
			});
			child.on('close', (code) => {
				resolve({ ok: code === 0, stdout, stderr });
			});
		});
	};

	try {
		const merge = await runTool('llvm-profdata', ['merge', '-sparse', ...profrawFiles, '-o', profdataPath]);
		if (!merge.ok) {
			logWithTimestamp(`llvm-profdata merge failed: ${merge.stderr}`, 'warn');
			return undefined;
		}

		const exportResult = await runTool('llvm-cov', ['export', '--format=lcov', `--instr-profile=${profdataPath}`, binaryPath]);
		if (!exportResult.ok) {
			logWithTimestamp(`llvm-cov export failed: ${exportResult.stderr}`, 'warn');
			return undefined;
		}
		return { path: '<llvm-cov export>', content: exportResult.stdout };
	} finally {
		try {
			await fs.promises.rm(profdataPath, { force: true });
		} catch {
			// ignore cleanup failures
		}
	}
};

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

export const pickLatestArtifact = async (files: string[]): Promise<string | undefined> => {
	let latestPath: string | undefined;
	let latestMtime = 0;
	for (const file of files) {
		try {
			const stat = await fs.promises.stat(file);
			const mtime = stat.mtimeMs;
			if (!latestPath || mtime > latestMtime) {
				latestPath = file;
				latestMtime = mtime;
			}
		} catch {
			// ignore missing files
		}
	}
	return latestPath;
};

export const loadFirstValidLcov = async (
	files: string[],
	cancellationToken?: vscode.CancellationToken
): Promise<{ path: string; content: string } | undefined> => {
	const candidates = await sortByMtimeDesc(files);
	for (const file of candidates) {
		if (cancellationToken?.isCancellationRequested) return undefined;
		try {
			const content = await fs.promises.readFile(file, 'utf8');
			if (hasLcovRecords(content)) {
				return { path: file, content };
			}
		} catch {
			// ignore unreadable file
		}
	}
	return undefined;
};

const sortByMtimeDesc = async (files: string[]): Promise<string[]> => {
	const stats = await Promise.all(
		files.map(async (file) => {
			try {
				const stat = await fs.promises.stat(file);
				return { file, mtime: stat.mtimeMs };
			} catch {
				return { file, mtime: 0 };
			}
		})
	);
	return stats
		.sort((a, b) => b.mtime - a.mtime)
		.map((entry) => entry.file);
};

const hasLcovRecords = (content: string): boolean => {
	let hasSource = false;
	let hasLines = false;
	for (const raw of content.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		if (line.startsWith('SF:')) hasSource = true;
		if (line.startsWith('DA:') || line.startsWith('LF:')) hasLines = true;
		if (hasSource && hasLines) return true;
	}
	return false;
};
