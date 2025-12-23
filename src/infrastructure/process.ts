/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/**
 * Process execution - spawns and manages Bazel command processes with streaming output
 */

import * as cp from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { CancellationToken } from 'vscode';
import { logWithTimestamp } from '../logging';

const runningBazelProcesses = new Set<cp.ChildProcess>();

export const trackBazelProcess = (proc: cp.ChildProcess): void => {
    runningBazelProcesses.add(proc);
};

export const untrackBazelProcess = (proc: cp.ChildProcess): void => {
    runningBazelProcesses.delete(proc);
};

export const cancelAllBazelProcesses = (): number => {
    let count = 0;
    for (const proc of runningBazelProcesses) {
        try {
            proc.kill('SIGTERM');
            count += 1;
        } catch {
            // ignore
        }
    }
    return count;
};

export function runBazelCommand(
    args: string[],
    cwd: string,
    onLine?: (line: string) => void,
    onErrorLine?: (line: string) => void,
    bazelPath: string = 'bazel',
    env?: NodeJS.ProcessEnv,
    cancellationToken?: CancellationToken
): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        logWithTimestamp(`Running Bazel: ${bazelPath} ${args.join(" ")}`);
        const proc = cp.spawn(bazelPath, args, { cwd, shell: true, env: { ...process.env, ...(env || {}) } });
        trackBazelProcess(proc);
        let isCancelled = false;

        let stdout = '';
        let stderr = '';

        // Listen for cancellation requests
        const cancellationDisposable = cancellationToken?.onCancellationRequested(() => {
            isCancelled = true;
            logWithTimestamp(`Cancellation requested for Bazel process: ${bazelPath} ${args.join(" ")}`);
            proc.kill('SIGTERM');
        });

        const rl = readline.createInterface({ input: proc.stdout });
        rl.on('line', line => {
            const normalizedLine = line.replace(/\r?\n/g, '\r\n');
            stdout += normalizedLine + '\n';
            if (onLine) onLine(normalizedLine);
        });

        const errorRl = readline.createInterface({ input: proc.stderr });
        errorRl.on('line', line => {
            const normalizedLine = line.replace(/\r?\n/g, '\r\n');
            stderr += normalizedLine + '\n';
            if (onErrorLine) onErrorLine(normalizedLine);
        });

        proc.on('close', code => {
            cancellationDisposable?.dispose();
            untrackBazelProcess(proc);
            if (isCancelled) {
                reject(new Error('Bazel test execution was cancelled'));
            } else {
                resolve({ code: code ?? 1, stdout, stderr });
            }
        });

        proc.on('error', (err) => {
            cancellationDisposable?.dispose();
            untrackBazelProcess(proc);
            reject(err);
        });
    });
}
