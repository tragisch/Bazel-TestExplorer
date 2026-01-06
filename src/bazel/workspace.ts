/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/**
 * Workspace detection - locates Bazel workspace root by finding WORKSPACE/MODULE.bazel files
 */

import * as vscode from 'vscode';
import { glob } from 'glob';
import * as path from 'path';
import { logWithTimestamp } from '../logging';
import * as fs from 'fs';

let cachedWorkspace: string | null = null;
let cachedViaFile: string | null = null;

// Invalidate cache when workspace folders change
vscode.workspace.onDidChangeWorkspaceFolders(() => {
  cachedWorkspace = null;
  cachedViaFile = null;
});

export const findBazelWorkspace = async (): Promise<string | null> => {
  if (cachedWorkspace) return cachedWorkspace;

  const possibleFiles = ['MODULE.bazel', 'WORKSPACE.bazel', 'WORKSPACE'];

  // Prefer multi-root workspace folders when available; fallback to rootPath/DOT
  const folders: string[] = (vscode.workspace.workspaceFolders || [])
    .map(f => f.uri.fsPath);
  if (folders.length === 0 && vscode.workspace.rootPath) {
    folders.push(vscode.workspace.rootPath);
  }
  if (folders.length === 0) {
    folders.push('.');
  }

  for (const folder of folders) {
    for (const file of possibleFiles) {
      const matches = await glob(`**/${file}`, {
        nodir: true,
        absolute: true,
        cwd: folder
      });
      if (matches.length > 0) {
        const workspaceDir = path.dirname(matches[0]);
        cachedWorkspace = workspaceDir;
        cachedViaFile = file;
        logWithTimestamp(`Detected Bazel workspace at ${workspaceDir} (via ${file})`);
        return workspaceDir;
      }
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
  if (process.env.BAZEL_TESTEXPLORER_DEBUG === '1') {
    logWithTimestamp(`cwd used: ${workspacePath}`);
    logWithTimestamp(`Exists .bazelrc: ${fs.existsSync(path.join(workspacePath, ".bazelrc"))}`);
  }
  return workspacePath;
};

export const invalidateWorkspaceCache = (): void => {
  cachedWorkspace = null;
  cachedViaFile = null;
};

export const getCachedWorkspace = (): string | null => {
  return cachedWorkspace;
};