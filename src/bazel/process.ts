/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

// excecute Bazel command

import * as cp from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { logWithTimestamp } from '../logging';

export function runBazelCommand(
    args: string[],
    cwd: string,
    onLine?: (line: string) => void,
    onErrorLine?: (line: string) => void
): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        logWithTimestamp(`Running Bazel: bazel ${args.join(" ")}`);
        const proc = cp.spawn('bazel', args, { cwd, shell: true });

        let stdout = '';
        let stderr = '';

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
            resolve({ code: code ?? 1, stdout, stderr });
        });

        proc.on('error', reject);
    });
}