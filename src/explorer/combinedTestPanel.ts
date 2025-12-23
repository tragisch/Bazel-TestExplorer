/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/*
 * Combined Test Panel
 * - Consolidates Test Info + Test Details into a single webview with tabs
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BazelClient } from '../bazel/client';
import { TestCaseInsights } from './testCaseInsights';
import { IndividualTestCase } from '../bazel/types';
import { getBazelTestLogsDirectory, buildTestXmlPath, hasTestXmlFile } from '../bazel/testlogs';
import { getCoverageSummary } from '../coverageState';

let panel: vscode.WebviewPanel | undefined;
let pinned = false;
let currentId: string | undefined;
let debounceTimer: NodeJS.Timeout | undefined;
let pendingArgs: { testId: string; metadata: any; cases: any } | undefined;
const DEBOUNCE_MS = 300;

export async function showCombinedTestPanel(testId: string, bazelClient: BazelClient, insights: TestCaseInsights, extensionContext?: vscode.ExtensionContext): Promise<void> {
  const metadata = bazelClient.getTargetMetadata(testId);
  const cases = insights.getResult(testId);

  if (!metadata && !cases) {
    void vscode.window.showWarningMessage(`No metadata or structured test cases found for ${testId}. Try expanding the test target first.`);
    return;
  }

  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'bazelCombinedTest',
      'Bazel Test',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    panel.onDidDispose(() => {
      panel = undefined;
      pinned = false;
      currentId = undefined;
    });

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (!panel) return;
      const activeId = currentId ?? testId;

      if (msg.command === 'requestRawXml') {
        const logsDir = await getBazelTestLogsDirectory(bazelClient.workspace, bazelClient.bazel);
        if (!logsDir) {
          panel.webview.postMessage({ command: 'rawXml', ok: false, error: 'Could not locate bazel-testlogs' });
          return;
        }
        const xmlPath = buildTestXmlPath(activeId, logsDir);
        if (!hasTestXmlFile(xmlPath)) {
          panel.webview.postMessage({ command: 'rawXml', ok: false, error: 'test.xml not present for this target' });
          return;
        }
        try {
          const raw = fs.readFileSync(xmlPath, 'utf8');
          panel.webview.postMessage({ command: 'rawXml', ok: true, content: raw });
        } catch (e: any) {
          panel.webview.postMessage({ command: 'rawXml', ok: false, error: String(e) });
        }
        return;
      }

      if (msg.command === 'togglePin') {
        pinned = !!msg.value;
        panel.title = pinned ? `Bazel Test (pinned)` : `Bazel Test`;
        return;
      }

      if (msg.command === 'requestLogs') {
        const logsDir = await getBazelTestLogsDirectory(bazelClient.workspace, bazelClient.bazel);
        if (!logsDir) {
          panel.webview.postMessage({ command: 'logs', ok: false, error: 'Could not locate bazel-testlogs' });
          return;
        }
        const xmlPath = buildTestXmlPath(activeId, logsDir);
        const targetDir = path.dirname(xmlPath);
        try {
          const items = fs.existsSync(targetDir) ? fs.readdirSync(targetDir) : [];
          const files = items.filter(f => f !== 'test.xml').slice(0, 10);
          const contents: { name: string; content: string }[] = [];
          for (const fname of files) {
            try {
              const full = path.join(targetDir, fname);
              const data = fs.readFileSync(full, 'utf8');
              contents.push({ name: fname, content: data.substring(0, 20000) });
            } catch (e: any) {
              // skip unreadable
            }
          }
          panel.webview.postMessage({ command: 'logs', ok: true, files: contents });
        } catch (e: any) {
          panel.webview.postMessage({ command: 'logs', ok: false, error: String(e) });
        }
        return;
      }

      if (msg.command === 'copyRunCommand') {
        const cmd = `bazel test ${activeId}`;
        try {
          await vscode.env.clipboard.writeText(cmd);
          void vscode.window.showInformationMessage('Copied run command to clipboard');
        } catch (e) {
          void vscode.window.showErrorMessage('Failed to copy command to clipboard');
        }
        return;
      }

      if (msg.command === 'rerun') {
        try {
          await vscode.commands.executeCommand('bazelTestExplorer.rerunTestFromHistory', activeId);
        } catch (e) {
          void vscode.window.showErrorMessage('Failed to trigger rerun command');
        }
        return;
      }
    });
  }

  // schedule update (debounced) unless pinned
  if (pinned && currentId && currentId !== testId) {
    void vscode.window.showInformationMessage('Panel is pinned and will not follow selection. Unpin to follow.');
    return;
  }

  pendingArgs = { testId, metadata, cases };
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (!panel || !pendingArgs) return;
    currentId = pendingArgs.testId;
    panel.webview.html = renderHtml(pendingArgs.testId, pendingArgs.metadata, pendingArgs.cases?.testCases ?? [], pendingArgs.cases?.summary, extensionContext, panel);
    pendingArgs = undefined;
    debounceTimer = undefined;
  }, DEBOUNCE_MS);
}

function renderHtml(
  testId: string,
  metadata: any,
  testCases: IndividualTestCase[],
  summary?: { total: number; passed: number; failed: number; ignored: number }
  , extensionContext?: vscode.ExtensionContext, panel?: vscode.WebviewPanel
): string {
  const escape = (input: string | undefined) => (input ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const casesRows = testCases.length > 0
    ? testCases.map(tc => `
        <tr>
          <td class="status ${tc.status.toLowerCase()}">${tc.status}</td>
          <td>${escape(tc.name)}</td>
          <td>${escape(tc.suite ?? tc.className ?? '')}</td>
          <td>${escape(tc.file)}${tc.line ? `:${tc.line}` : ''}</td>
          <td>${escape(tc.errorMessage ?? '')}</td>
        </tr>
      `).join('')
    : `<tr><td colspan="5"><i>No individual test cases recorded.</i></td></tr>`;

  const metadataList = metadata
    ? `
      <ul>
        <li><b>Target:</b> ${escape(metadata.target)}</li>
        <li><b>Type:</b> ${escape(metadata.type)}</li>
        <li><b>Timeout:</b> ${escape(metadata.timeout)}</li>
        <li><b>Size:</b> ${escape(metadata.size)}</li>
        <li><b>Flaky:</b> ${metadata.flaky ? 'Yes' : 'No'}</li>
        <li><b>Toolchain:</b> ${escape(metadata.toolchain)}</li>
        <li><b>Tags:</b> ${Array.isArray(metadata.tags) ? escape(metadata.tags.join(', ')) : escape(metadata.tags)}</li>
        <li><b>Visibility:</b> ${Array.isArray(metadata.visibility) ? escape(metadata.visibility.join(', ')) : escape(metadata.visibility)}</li>
        <li><b>Dependencies:</b> ${Array.isArray(metadata.deps) ? escape(metadata.deps.join(', ')) : escape(metadata.deps)}</li>
        <li><b>Sources:</b> ${Array.isArray(metadata.srcs) ? escape(metadata.srcs.join(', ')) : escape(metadata.srcs)}</li>
        <li><b>Location:</b> ${escape(metadata.location)}</li>
      </ul>
    `
    : '<i>No Bazel metadata cached for this target.</i>';

  const summarySection = summary
    ? `<p>Total: ${summary.total}, Passed: ${summary.passed}, Failed: ${summary.failed}, Skipped: ${summary.ignored}</p>`
    : `<i>No structured test.xml data captured yet.</i>`;

  const coverage = getCoverageSummary(testId);
  const coverageRows = coverage
    ? coverage.files.map(f => `
        <tr>
          <td>${escape(f.path)}</td>
          <td>${f.percent.toFixed(2)}%</td>
          <td>${f.covered}/${f.total}</td>
        </tr>
      `).join('')
    : '';
  const coverageSection = coverage
    ? `
      <p><b>Total:</b> ${coverage.percent.toFixed(2)}% (${coverage.covered}/${coverage.total} lines)</p>
      <table>
        <thead>
          <tr><th>File</th><th>Coverage</th><th>Lines</th></tr>
        </thead>
        <tbody>
          ${coverageRows || `<tr><td colspan="3"><i>No file coverage entries.</i></td></tr>`}
        </tbody>
      </table>
    `
    : `<i>No coverage data available for this target.</i>`;

  const initialRawHtml = `<pre id="rawXmlPre" style="white-space:pre-wrap;">(raw XML not loaded)</pre>`;
  // Prepare external script URI when extensionContext is available
  const scriptTag = extensionContext && panel
    ? `<script src="${panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionContext.extensionUri, 'media', 'combinedPanel.js'))}"></script>`
    : `<script>/* fallback inline script omitted */</script>`;

  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' vscode-resource:;">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 0.5rem; }
          .topbar { display:flex; gap:8px; align-items:center; margin-bottom:8px; }
          .tabs { display:flex; gap:6px; margin-bottom:8px; }
          .tab { padding:6px 10px; border-radius:4px; cursor:pointer; background:#eee; }
          .tab.active { background:#ddd; font-weight:600; }
          .content { border:1px solid #eee; padding:8px; }
          table { width:100%; border-collapse:collapse; margin-top:0.5rem; }
          th, td { border:1px solid #ccc; padding:4px 6px; font-size:12px; }
          th { background:#f3f3f3; }
          .status.pass { color:#22863a; }
          .status.fail { color:#b31d28; }
          .status.timeout { color:#d35400; }
        </style>
      </head>
      <body>
        <div class="topbar">
          <button id="rerunBtn">Rerun</button>
          <label><input id="pinChk" type="checkbox"> Pin</label>
          <span style="margin-left:auto; font-size:12px; color:#666">${escape(testId)}</span>
        </div>

        <div class="tabs">
          <div class="tab active" data-tab="overview">Overview</div>
          <div class="tab" data-tab="details">Details</div>
          <div class="tab" data-tab="coverage">Coverage</div>
          <div class="tab" data-tab="logs">Logs</div>
          <div class="tab" data-tab="raw">Raw XML</div>
        </div>

        <div class="content" id="content">
          <div id="overview">
            <h3>Metadata</h3>
            ${metadataList}
            <h3>Structured summary</h3>
            ${summarySection}
          </div>

          <div id="details" style="display:none">
            <h3>Individual Test Cases</h3>
            <table>
              <thead>
                <tr><th>Status</th><th>Name</th><th>Suite/Class</th><th>Source</th><th>Message</th></tr>
              </thead>
              <tbody>
                ${casesRows}
              </tbody>
            </table>
          </div>

          <div id="coverage" style="display:none">
            <h3>Coverage</h3>
            ${coverageSection}
          </div>

          <div id="logs" style="display:none">
            <p><i>Logs are loaded lazily.</i> <button id="loadLogsBtn">Load logs</button> <button id="copyCmdBtn">Copy run command</button></p>
            <pre id="logsPre" style="white-space:pre-wrap;">(not loaded)</pre>
          </div>

          <div id="raw" style="display:none">
            <h4>test.xml</h4>
            ${initialRawHtml}
          </div>
        </div>

        ${scriptTag}
      </body>
    </html>
  `;
}
