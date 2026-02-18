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

/**
 * Cancels all running Bazel processes with improved reliability
 * Returns a promise that resolves when all processes are terminated
 */
export const cancelAllBazelProcesses = async (): Promise<{ killed: number; failed: number }> => {
    const processes = Array.from(runningBazelProcesses);
    if (processes.length === 0) {
        return { killed: 0, failed: 0 };
    }

    logWithTimestamp(`Attempting to cancel ${processes.length} running Bazel process(es)...`);

    const killPromises = processes.map(async (proc) => {
        return new Promise<boolean>((resolve) => {
            // Process might already be dead
            if (proc.exitCode !== null || proc.signalCode !== null) {
                untrackBazelProcess(proc);
                resolve(true);
                return;
            }

            let settled = false;
            let timeoutHandle: NodeJS.Timeout | undefined;

            // Cleanup function to ensure handlers and timeout are removed
            const cleanup = () => {
                if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                    timeoutHandle = undefined;
                }
                proc.removeListener('close', onClose);
                proc.removeListener('error', onError);
            };

            const finish = (success: boolean) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                untrackBazelProcess(proc);
                resolve(success);
            };

            const onClose = () => {
                finish(true);
            };

            const onError = (err: Error) => {
                logWithTimestamp(`Error while killing process: ${err.message}`, 'warn');
                finish(false);
            };

            proc.once('close', onClose);
            proc.once('error', onError);

            // Set timeout for force-kill
            timeoutHandle = setTimeout(() => {
                // Check if process is still alive before force-killing
                if (proc.exitCode === null && proc.signalCode === null) {
                    logWithTimestamp('Force-killing Bazel process (SIGTERM ignored)', 'warn');
                    try {
                        // Try to kill the process group (all child processes)
                        if (process.platform !== 'win32' && proc.pid) {
                            process.kill(-proc.pid, 'SIGKILL');
                        } else {
                            proc.kill('SIGKILL');
                        }
                    } catch (err) {
                        logWithTimestamp(`Failed to force-kill process: ${err}`, 'warn');
                    }
                }
            }, 5_000);

            try {
                // Try to kill the process group (all child processes) on POSIX systems
                if (process.platform !== 'win32' && proc.pid) {
                    // Negative PID kills the process group
                    process.kill(-proc.pid, 'SIGTERM');
                } else {
                    proc.kill('SIGTERM');
                }
            } catch (err) {
                logWithTimestamp(`Failed to send SIGTERM: ${err}`, 'warn');
                finish(false);
            }
        });
    });

    const results = await Promise.all(killPromises);
    const killed = results.filter(r => r).length;
    const failed = results.length - killed;

    if (killed > 0) {
        logWithTimestamp(`Successfully cancelled ${killed} Bazel process(es)${failed > 0 ? `, ${failed} failed` : ''}`);
    }
    
    return { killed, failed };
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

            // Fallback: force-kill if SIGTERM is ignored after 5 seconds
            const killTimer = setTimeout(() => {
                try {
                    if (proc.exitCode === null && proc.signalCode === null) {
                        logWithTimestamp(`Force-killing Bazel process (SIGTERM ignored): ${bazelPath} ${args.join(" ")}`);
                        proc.kill('SIGKILL');
                    }
                } catch {
                    // Process may already be gone
                }
            }, 5_000);
            killTimer.unref();

            // Clear the fallback timer once the process exits
            proc.once('close', () => clearTimeout(killTimer));
        });

        const rl = readline.createInterface({ input: proc.stdout });
        rl.on('line', line => {
            const normalizedLine = line.replace(/\r?\n/g, '\r\n');
            stdout += normalizedLine + '\n';
            if (onLine) {onLine(normalizedLine);}
        });

        const errorRl = readline.createInterface({ input: proc.stderr });
        errorRl.on('line', line => {
            const normalizedLine = line.replace(/\r?\n/g, '\r\n');
            stderr += normalizedLine + '\n';
            if (onErrorLine) {onErrorLine(normalizedLine);}
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
