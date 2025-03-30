import * as cp from 'child_process';
import * as readline from 'readline';
import { logWithTimestamp } from '../logging';

export function runBazelCommand(
    args: string[],
    cwd: string,
    onLine?: (line: string) => void
): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        logWithTimestamp(`Running Bazel: bazel ${args.join(" ")}`);
        const proc = cp.spawn('bazel', args, { cwd, shell: true });

        let stdout = '';
        let stderr = '';

        const rl = readline.createInterface({ input: proc.stdout });
        rl.on('line', line => {
            stdout += line + '\n';
            if (onLine) onLine(line);
        });

        proc.stderr.on('data', data => {
            stderr += data.toString();
        });

        proc.on('close', code => {
            resolve({ code: code ?? 1, stdout, stderr });
        });

        proc.on('error', reject);
    });
}