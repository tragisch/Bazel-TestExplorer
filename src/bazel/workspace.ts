

import * as vscode from 'vscode';
import { glob } from 'glob';
import * as path from 'path';
import { logWithTimestamp } from '../logging';

export const findBazelWorkspace = async (): Promise<string | null> => {
  const config = vscode.workspace.getConfiguration("bazelTestRunner");
  const workspaceRootFile = config.get<string>("workspaceRootFile", "MODULE.bazel");
  const workspaceFiles = await glob(`**/${workspaceRootFile}*`, {
    nodir: true,
    absolute: true,
    cwd: vscode.workspace.rootPath || "."
  });
  return workspaceFiles.length > 0 ? path.dirname(workspaceFiles[0]) : null;
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