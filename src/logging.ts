/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import * as vscode from 'vscode';

let logger: vscode.OutputChannel;

export const initializeLogger = (): vscode.OutputChannel => {
    logger = vscode.window.createOutputChannel("Bazel-Test-Logs");
    return logger;
};

export const logWithTimestamp = (message: string, level: "info" | "warn" | "error" = "info") => {
    if (!logger) {
        return; // Skip logging if logger not initialized (e.g., in tests)
    }
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    const timestamp = `${now} `;
    let tag = `[Info] `;
    if (level === "warn") tag = `[Warn] `;
    if (level === "error") tag = `[Error] `;
    const indentedMessage = message.split("\n").map(line => `  ${line}`).join("\n");
    logger.appendLine(`${timestamp} ${tag} ${indentedMessage}`);
};

export const formatError = (error: unknown): string =>
    error instanceof Error ? error.stack || error.message : JSON.stringify(error, null, 2);

export const measure = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const start = Date.now();
    const result = await fn();
    const duration = Date.now() - start;
    logWithTimestamp(`${label} took ${duration}ms`);
    return result;
};

export const logMemoryUsage = () => {
    const mem = process.memoryUsage();
    const toMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(2) + ' MB';
    logWithTimestamp(`Memory Usage — RSS: ${toMB(mem.rss)}, Heap Used: ${toMB(mem.heapUsed)}, Heap Total: ${toMB(mem.heapTotal)}`);
};