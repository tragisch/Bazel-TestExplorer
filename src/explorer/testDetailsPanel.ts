/*
 * TestDetailsPanel
 * - Presents aggregated metadata + structured XML insights for a Bazel target
 */

import * as vscode from 'vscode';
import { BazelClient } from '../bazel/client';
import { TestCaseInsights } from './testCaseInsights';
import { IndividualTestCase } from '../bazel/types';

let panel: vscode.WebviewPanel | undefined;

export function showTestDetailsById(testId: string, bazelClient: BazelClient, insights: TestCaseInsights): void {
  const metadata = bazelClient.getTargetMetadata(testId);
  const cases = insights.getResult(testId);

  if (!metadata && !cases) {
    void vscode.window.showWarningMessage(`No metadata or structured test cases found for ${testId}. Try expanding the test target first.`);
    return;
  }

  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'bazelTestDetails',
      'Bazel Test Details',
      vscode.ViewColumn.Beside,
      { enableScripts: false }
    );
    panel.onDidDispose(() => {
      panel = undefined;
    });
  }

  panel.webview.html = renderHtml(testId, metadata, cases?.testCases ?? [], cases?.summary);
}

function renderHtml(
  testId: string,
  metadata: any,
  testCases: IndividualTestCase[],
  summary?: { total: number; passed: number; failed: number; ignored: number }
): string {
  const escape = (input: string | undefined) =>
    (input ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const renderList = (label: string, value?: string | string[]) => {
    if (!value || (Array.isArray(value) && value.length === 0)) {
      return `<li><b>${label}:</b> –</li>`;
    }
    return `<li><b>${label}:</b> ${Array.isArray(value) ? value.map(escape).join(', ') : escape(value)}</li>`;
  };

  const summarySection = summary
    ? `<div class="summary">
        <h3>Structured test.xml Summary</h3>
        <p>Total: ${summary.total}, Passed: ${summary.passed}, Failed: ${summary.failed}, Skipped: ${summary.ignored}</p>
      </div>`
    : `<div class="summary"><i>No structured test.xml data captured yet. Expand the test target to trigger discovery.</i></div>`;

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

  const metadataSection = metadata
    ? `<div class="metadata">
        <h3>Target Metadata</h3>
        <ul>
          ${renderList('Target', metadata.target)}
          ${renderList('Type', metadata.type)}
          ${renderList('Timeout', metadata.timeout)}
          ${renderList('Size', metadata.size)}
          ${renderList('Flaky', metadata.flaky ? 'Yes' : 'No')}
          ${renderList('Toolchain', metadata.toolchain)}
          ${renderList('Tags', metadata.tags)}
          ${renderList('Visibility', metadata.visibility)}
          ${renderList('Dependencies', metadata.deps)}
          ${renderList('Tests', metadata.tests)}
          ${renderList('Sources', metadata.srcs)}
          ${renderList('Location', metadata.location)}
        </ul>
      </div>`
    : `<div class="metadata"><i>No Bazel metadata cached for this target.</i></div>`;

  const dataAvailability = renderDataAvailability(testId, testCases);

  return `
    <html>
      <head>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 1rem; }
          table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
          th, td { border: 1px solid #ccc; padding: 4px 6px; font-size: 12px; }
          th { background: #f3f3f3; text-align: left; }
          .status.pass { color: #22863a; }
          .status.fail { color: #b31d28; }
          .status.timeout { color: #d35400; }
          .status.skip { color: #6a737d; }
          .sections { display: flex; gap: 1rem; flex-wrap: wrap; }
          .metadata, .summary { flex: 1 1 300px; }
          .availability { margin-top: 1rem; }
          .availability table { margin-top: 0; }
          .missing { color: #b31d28; font-style: italic; }
        </style>
      </head>
      <body>
        <h2>${escape(testId)}</h2>
        <div class="sections">
          ${metadataSection}
          ${summarySection}
        </div>
        ${dataAvailability}
        <h3>Individual Test Cases</h3>
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Name</th>
              <th>Suite/Class</th>
              <th>Source</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            ${casesRows}
          </tbody>
        </table>
      </body>
    </html>
  `;
}

function renderDataAvailability(testId: string, testCases: IndividualTestCase[]): string {
  if (testCases.length === 0) {
    return `<div class="availability"><i>No individual cases discovered yet. Expand the test target to populate structured data.</i></div>`;
  }

  const firstCase = testCases[0];
  const sourceCase = testCases.find(tc => (tc.file?.trim().length ?? 0) > 0 && tc.line && tc.line > 0)
    ?? testCases.find(tc => (tc.file?.trim().length ?? 0) > 0);
  const errorCase = testCases.find(tc => tc.errorMessage || tc.status === 'FAIL' || tc.status === 'TIMEOUT');
  const resolvedFile = sourceCase?.file?.trim() ? sourceCase.file : undefined;
  const resolvedLine = sourceCase && sourceCase.line && sourceCase.line > 0 ? sourceCase.line : undefined;

  const escapeField = (input: string) =>
    input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const renderField = (label: string, value?: string | number) => {
    const display = value === undefined || value === ''
      ? `<span class="missing">not available</span>`
      : typeof value === 'number'
        ? value.toString()
        : escapeField(value);
    return `<tr><td>${label}</td><td>${display}</td></tr>`;
  };

  const featureSection = (title: string, rows: string) => `
    <div>
      <h4>${title}</h4>
      <table>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;

  const codeLensRows = [
    renderField('testId', `${testId}::${firstCase.name}`),
    renderField('name', firstCase.name),
    renderField('status (optional)', firstCase.status),
    renderField('uri / path', resolvedFile),
    renderField('range (line)', resolvedLine)
  ].join('');

  const gutterRows = [
    renderField('uri / path', resolvedFile),
    renderField('line', resolvedLine),
    renderField('suite/class', sourceCase?.suite ?? sourceCase?.className ?? firstCase.suite ?? firstCase.className)
  ].join('');

  const diagnosticsRows = [
    renderField('status', errorCase?.status),
    renderField('error message', errorCase?.errorMessage),
    renderField('uri / path', (errorCase?.file?.trim() ? errorCase.file : undefined) ?? resolvedFile),
    renderField('line', (errorCase && errorCase.line && errorCase.line > 0 ? errorCase.line : undefined) ?? resolvedLine)
  ].join('');

  return `
    <div class="availability">
      <h3>Data Availability for VS Code Features</h3>
      <div class="sections">
        ${featureSection('CodeLens / Run Command', codeLensRows)}
        ${featureSection('Gutter Marker / TestController', gutterRows)}
        ${featureSection('Diagnostics & Hover', diagnosticsRows)}
      </div>
    </div>
  `;
}
