/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import * as cp from 'child_process';
import * as vscode from 'vscode';
import { logWithTimestamp } from './logging';

export interface CoverageRunConfig {
	bazelBinary: string;
	args: string[];
	workspaceRoot: string;
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

			child.stdout.on('data', (data) => this.outputChannel.append(data.toString()));
			child.stderr.on('data', (data) => this.outputChannel.append(data.toString()));

			cancellationToken?.onCancellationRequested(() => {
				logWithTimestamp('Bazel coverage cancelled by user.', 'warn');
				child.kill('SIGTERM');
			});

			child.on('error', (err) => reject(err));
			child.on('close', (code) => resolve(code ?? 0));
		});
	}
}
