import * as vscode from 'vscode';

let logger: vscode.OutputChannel;

export const initializeLogger = (): vscode.OutputChannel => {
    logger = vscode.window.createOutputChannel("Bazel-Test-Logs");
    return logger;
};

export const logWithTimestamp = (message: string, level: "info" | "warn" | "error" = "info") => {
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