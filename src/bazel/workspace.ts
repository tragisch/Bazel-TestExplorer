/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import * as vscode from 'vscode';
import { glob } from 'glob';
import * as path from 'path';
import { logWithTimestamp } from '../logging';
import * as fs from 'fs';

export const findBazelWorkspace = async (): Promise<string | null> => {
  const possibleFiles = ['MODULE.bazel', 'WORKSPACE.bazel', 'WORKSPACE'];
  for (const file of possibleFiles) {
    const matches = await glob(`**/${file}`, {
      nodir: true,
      absolute: true,
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "."
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
  logWithTimestamp(`cwd used: ${workspacePath}`);
  logWithTimestamp(`Exists .bazelrc: ${fs.existsSync(path.join(workspacePath, ".bazelrc"))}`);
  return workspacePath;
};
