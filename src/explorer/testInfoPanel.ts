/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import * as vscode from 'vscode';
import { BazelTestTarget } from '../bazel/types';
import { getTestTargetById } from '../bazel/queries';

let panel: vscode.WebviewPanel | undefined;

export function showTestMetadataPanel(target: BazelTestTarget) {
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'bazelTestMetadata',
      'Bazel Test Info',
      vscode.ViewColumn.Beside,
      { enableScripts: false }
    );

    panel.onDidDispose(() => {
      panel = undefined;
    });
  }

  panel.webview.html = renderHtml(target);
}

export function showTestMetadataById(testId: string) {
  const target = getTestTargetById(testId);
  if (target) {
    showTestMetadataPanel(target);
  } else {
    vscode.window.showWarningMessage(`No metadata found for test: ${testId}`);
  }
}

function renderHtml(target: BazelTestTarget): string {
  return `
    <html>
    <body>
      <h2>${target.target}</h2>
      <ul>
        <li><b>Type:</b> ${target.type}</li>
        <li><b>Timeout:</b> ${target.timeout ?? '–'}</li>
        <li><b>Size:</b> ${target.size ?? '–'}</li>
        <li><b>Flaky:</b> ${target.flaky ? 'Yes' : 'No'}</li>
        <li><b>Toolchain:</b> ${target.toolchain ?? '–'}</li>
        <li><b>Tags:</b> ${target.tags?.join(', ') ?? '–'}</li>
        <li><b>Visibility:</b> ${target.visibility?.join(', ') ?? '–'}</li>
        <li><b>Compatible Platforms:</b> ${target.compatiblePlatforms?.join(', ') ?? '–'}</li>
        <li><b>Srcs:</b> ${target.srcs?.join(', ') ?? '–'}</li>
        <li><b>Location:</b> ${target.location ?? '–'}</li>
      </ul>
    </body>
    </html>
  `;
}