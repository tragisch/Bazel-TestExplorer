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

/**
 * Validates that the bazel path is safe (no path traversal or command injection)
 */
function validateBazelPath(bazelPath: string): void {
    // Check for basic command injection attempts
    if (bazelPath.includes(';') || bazelPath.includes('&&') || bazelPath.includes('||') || bazelPath.includes('|')) {
        throw new Error(`Invalid bazel path: potential command injection detected`);
    }
    
    // Normalize and check for path traversal
    const normalized = path.normalize(bazelPath);
    if (normalized.includes('..')) {
        throw new Error(`Invalid bazel path: path traversal detected`);
    }
}

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
        // Validate bazel path to prevent command injection
        try {
            validateBazelPath(bazelPath);
        } catch (error) {
            logWithTimestamp(`Bazel path validation failed: ${error}`, 'error');
            reject(error);
            return;
        }

        logWithTimestamp(`Running Bazel: ${bazelPath} ${args.join(" ")}`);
        // Use shell: false to prevent command injection - bazelPath and args are now safely passed
        const proc = cp.spawn(bazelPath, args, { cwd, shell: false, env: { ...process.env, ...(env || {}) } });
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
            
            // Cleanup readline interfaces to prevent memory leaks
            rl.close();
            errorRl.close();
            
            if (isCancelled) {
                reject(new Error('Bazel test execution was cancelled'));
            } else {
                resolve({ code: code ?? 1, stdout, stderr });
            }
        });

        proc.on('error', (err) => {
            cancellationDisposable?.dispose();
            untrackBazelProcess(proc);
            
            // Cleanup readline interfaces
            rl.close();
            errorRl.close();
            
            reject(err);
        });
    });
}
