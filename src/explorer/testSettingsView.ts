import * as vscode from 'vscode';
import { ConfigurationService } from '../configuration';

export class TestSettingsView implements vscode.WebviewViewProvider {
  public static readonly viewType = 'bazelTestExplorer.settingsView';
  public static readonly explorerViewType = 'bazelTestExplorer.settingsView.explorer';

  constructor(private readonly config: ConfigurationService, private readonly context: vscode.ExtensionContext) {}

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    // handle messages from the webview
    const messageDisposable = webviewView.webview.onDidReceiveMessage(async (msg) => {
      const workspaceConfig = vscode.workspace.getConfiguration('bazelTestExplorer');
      switch (msg.command) {
        case 'getSettings': {
          webviewView.webview.postMessage({
            command: 'settings',
            payload: {
                  runsPerTest: this.config.runsPerTest,
                  runsPerTestDetectsFlakes: this.config.runsPerTestDetectsFlakes,
                  nocacheTestResults: this.config.nocacheTestResults,
                  buildTestsOnly: this.config.buildTestsOnly
            }
          });
          break;
        }
        case 'setSetting': {
          try {
            const { key, value } = msg.payload;
            // Update workspace configuration (global or workspace)
            await workspaceConfig.update(key, value, vscode.ConfigurationTarget.Workspace);
            webviewView.webview.postMessage({ command: 'updated', payload: { key, value } });
          } catch (err) {
            webviewView.webview.postMessage({ command: 'error', payload: String(err) });
          }
          break;
        }
      }
    });

    // react to external configuration changes
    const configDisposable = this.config.onDidChangeConfiguration(() => {
      // guard: only post when webview is available
      try {
        webviewView.webview.postMessage({
          command: 'settings',
          payload: {
            runsPerTest: this.config.runsPerTest,
            runsPerTestDetectsFlakes: this.config.runsPerTestDetectsFlakes,
            nocacheTestResults: this.config.nocacheTestResults,
            buildTestsOnly: this.config.buildTestsOnly
          }
        });
      } catch (e) {
        // ignore if webview is gone
      }
    });

    // Tie disposables to the lifecycle of the view to avoid leaking listeners
    webviewView.onDidDispose(() => {
      try { messageDisposable.dispose(); } catch (e) {}
      try { configDisposable.dispose(); } catch (e) {}
    });
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = Date.now().toString(36);
    return `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); }
      label { display:block; margin: 8px 0; }
      fieldset { margin-top:12px; padding:8px; border-radius:6px; background:var(--vscode-inputBackground); }
      fieldset legend { font-weight:600; }
    </style>
    <title>Bazel Test Settings</title>
  </head>
  <body>
    <fieldset>
      <legend>Execution</legend>
      <label><input id="nocacheTestResults" type="checkbox"/> Run tests without cache (<code>--nocache_test_results</code>)</label>
      <label><input id="buildTestsOnly" type="checkbox"/> Only build test targets (<code>--build_tests_only</code>)</label>
      <label><input id="testStrategyExclusive" type="checkbox"/> Force serial execution (<code>--test_strategy=exclusive</code>)</label>
    </fieldset>

    <fieldset>
      <legend>Runs Per Test</legend>
      <label>Runs per test (0 = disabled): <input id="runsPerTest" type="number" min="0" style="width:5em"/></label>
      <label><input id="runsPerTestDetectsFlakes" type="checkbox"/> Detect flakes per run (<code>--runs_per_test_detects_flakes</code>)</label>
    </fieldset>

    

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const sendSetting = (key, value) => {
        vscode.postMessage({ command: 'setSetting', payload: { key, value } });
      };

      const wireControls = () => {
        const checkboxFields = [
          { id: 'nocacheTestResults', key: 'nocacheTestResults' },
          { id: 'buildTestsOnly', key: 'buildTestsOnly' },
          { id: 'runsPerTestDetectsFlakes', key: 'runsPerTestDetectsFlakes' },
          { id: 'testStrategyExclusive', key: 'testStrategyExclusive' }
        ];
        checkboxFields.forEach(({ id, key }) => {
          const el = document.getElementById(id);
          el?.addEventListener('change', () => sendSetting(key, el.checked));
        });

        const numberFields = [
          { id: 'runsPerTest', key: 'runsPerTest' }
        ];
        numberFields.forEach(({ id, key }) => {
          const el = document.getElementById(id);
          el?.addEventListener('change', () => {
            const value = Number(el.value);
            sendSetting(key, Number.isFinite(value) ? value : 0);
          });
        });

      };

      wireControls();

      window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.command === 'settings') {
          const s = msg.payload;
          document.getElementById('runsPerTest').value = s.runsPerTest ?? 0;
          document.getElementById('runsPerTestDetectsFlakes').checked = !!s.runsPerTestDetectsFlakes;
          document.getElementById('nocacheTestResults').checked = !!s.nocacheTestResults;
          document.getElementById('buildTestsOnly').checked = !!s.buildTestsOnly;
          document.getElementById('testStrategyExclusive').checked = !!s.testStrategyExclusive;
          // sharding removed
        }
      });

      // ask for current settings
      vscode.postMessage({ command: 'getSettings' });
    </script>
  </body>
</html>`;
  }
}

export default TestSettingsView;
