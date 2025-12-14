/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

// execute Bazel command

import * as cp from 'child_process';
import * as readline from 'readline';
import { logWithTimestamp } from '../logging';

// Overload: legacy signature with callbacks
export function runBazelCommand(
    args: string[],
    cwd: string,
    onLine?: (line: string) => void,
    onErrorLine?: (line: string) => void
): Promise<{ code: number; stdout: string; stderr: string }>;

// Overload: options object allowing streaming without buffering
export function runBazelCommand(
    args: string[],
    cwd: string,
    options?: {
        onLine?: (line: string) => void;
        onErrorLine?: (line: string) => void;
        collectStdout?: boolean; // default true
        collectStderr?: boolean; // default true
        logCommand?: boolean;     // default true
    }
): Promise<{ code: number; stdout: string; stderr: string }>;

export function runBazelCommand(
    args: string[],
    cwd: string,
    onLineOrOptions?: ((line: string) => void) | {
        onLine?: (line: string) => void;
        onErrorLine?: (line: string) => void;
        collectStdout?: boolean;
        collectStderr?: boolean;
        logCommand?: boolean;
    },
    onErrorLineMaybe?: (line: string) => void
): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        // Determine options vs legacy callback signature
        const opts = typeof onLineOrOptions === 'function'
            ? { onLine: onLineOrOptions as (line: string) => void, onErrorLine: onErrorLineMaybe, collectStdout: true, collectStderr: true, logCommand: true }
            : { ...(onLineOrOptions ?? {}), collectStdout: (onLineOrOptions as any)?.collectStdout !== false, collectStderr: (onLineOrOptions as any)?.collectStderr !== false, logCommand: (onLineOrOptions as any)?.logCommand !== false } as {
                onLine?: (line: string) => void;
                onErrorLine?: (line: string) => void;
                collectStdout: boolean;
                collectStderr: boolean;
                logCommand: boolean;
            };

        if (opts.logCommand) {
            logWithTimestamp(`Running Bazel: bazel ${args.join(" ")}`);
        }

        const proc = cp.spawn('bazel', args, { cwd, shell: true });

        let stdout = '';
        let stderr = '';

        const rl = readline.createInterface({ input: proc.stdout });
        rl.on('line', line => {
            const normalizedLine = line.replace(/\r?\n/g, '\r\n');
            if (opts.collectStdout) stdout += normalizedLine + '\r\n';
            if (opts.onLine) opts.onLine(normalizedLine);
        });

        const errorRl = readline.createInterface({ input: proc.stderr });
        errorRl.on('line', line => {
            const normalizedLine = line.replace(/\r?\n/g, '\r\n');
            if (opts.collectStderr) stderr += normalizedLine + '\r\n';
            if (opts.onErrorLine) opts.onErrorLine(normalizedLine);
        });

        proc.on('close', code => {
            resolve({ code: code ?? 1, stdout, stderr });
        });

        proc.on('error', reject);
    });
}
