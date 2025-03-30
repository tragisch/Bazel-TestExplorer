import * as vscode from 'vscode';
import { glob } from 'glob';
import * as path from 'path';
import { logWithTimestamp } from '../logging';

export const findBazelWorkspace = async (): Promise<string | null> => {
  const possibleFiles = ['MODULE.bazel', 'WORKSPACE.bazel', 'WORKSPACE'];
  for (const file of possibleFiles) {
    const matches = await glob(`**/${file}`, {
      nodir: true,
      absolute: true,
      cwd: vscode.workspace.rootPath || "."
    });
    if (matches.length > 0) {
      return path.dirname(matches[0]);
    }
  }
  return null;
};

export const getWorkspaceOrShowError = async (): Promise<string | null> => {
  const workspacePath = await findBazelWorkspace();
  if (!workspacePath) {
    vscode.window.showErrorMessage("No Bazel workspace detected.");
    return null;
  }
  logWithTimestamp(`Bazel workspace found at: ${workspacePath}`);
  return workspacePath;
};