// External webview script for combinedTestPanel
(function () {
  const vscode = acquireVsCodeApi();

  function init() {
    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', onTabClick));
    const pin = document.getElementById('pinChk');
    if (pin) pin.addEventListener('change', (ev) => {
      vscode.postMessage({ command: 'togglePin', value: ev.target.checked });
    });
    const rerun = document.getElementById('rerunBtn');
    if (rerun) rerun.addEventListener('click', () => vscode.postMessage({ command: 'rerun' }));
    const loadLogs = document.getElementById('loadLogsBtn');
    if (loadLogs) loadLogs.addEventListener('click', () => vscode.postMessage({ command: 'requestLogs' }));
    const copyBtn = document.getElementById('copyCmdBtn');
    if (copyBtn) copyBtn.addEventListener('click', () => vscode.postMessage({ command: 'copyRunCommand' }));
    const covFilter = document.getElementById('covOnlyUncovered');
    if (covFilter) covFilter.addEventListener('change', () => applyCoverageFilter(covFilter.checked));
  }

  function onTabClick(e) {
    const el = e.target.closest ? e.target.closest('.tab') : findClosestTab(e.target);
    if (!el) return;
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    el.classList.add('active');
    const tab = el.dataset ? el.dataset.tab : null;
    document.getElementById('overview').style.display = tab==='overview' ? 'block' : 'none';
    document.getElementById('details').style.display = tab==='details' ? 'block' : 'none';
    document.getElementById('coverage').style.display = tab==='coverage' ? 'block' : 'none';
    document.getElementById('logs').style.display = tab==='logs' ? 'block' : 'none';
    document.getElementById('raw').style.display = tab==='raw' ? 'block' : 'none';
    if (tab === 'raw') {
      vscode.postMessage({ command: 'requestRawXml' });
    }
  }

  function applyCoverageFilter(onlyUncovered) {
    const rows = document.querySelectorAll('#coverage tbody tr[data-percent]');
    rows.forEach(row => {
      const percent = parseFloat(row.getAttribute('data-percent') || '0');
      const hidden = onlyUncovered && percent >= 100;
      row.style.display = hidden ? 'none' : '';
    });
  }

  function findClosestTab(node) {
    let n = node;
    while (n && n !== document.body) {
      if (n.classList && n.classList.contains && n.classList.contains('tab')) return n;
      n = n.parentElement;
    }
    return null;
  }

  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.command === 'rawXml') {
      const pre = document.getElementById('rawXmlPre');
      if (pre) pre.textContent = msg.ok ? msg.content : '(error loading xml) ' + (msg.error || '');
    }
    if (msg.command === 'logs') {
      const pre = document.getElementById('logsPre');
      if (!pre) return;
      if (!msg.ok) {
        pre.textContent = '(error loading logs) ' + (msg.error || '');
        return;
      }
      const parts = [];
      for (const f of msg.files || []) {
        parts.push('--- ' + f.name + ' ---\n' + f.content);
      }
      pre.textContent = parts.join('\n\n');
    }
  });

  document.addEventListener('DOMContentLoaded', init);
})();
