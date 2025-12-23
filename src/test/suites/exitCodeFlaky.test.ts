/*
 * Tests for exit code 4 (flaky) handling in runner
 */

/// <reference types="mocha" />
import * as assert from 'assert';
import * as vscode from 'vscode';
import * as processModule from '../../infrastructure/process';
import { executeBazelTest } from '../../bazel/runner';
import { MockTestItem, MockTestRun } from '../mocks';
import { ConfigurationService } from '../../configuration';

suite('Runner - Exit Code 4 (Flaky)', () => {
  let originalRun: typeof processModule.runBazelCommand | undefined;
  let run: MockTestRun;
  const mockConfig = {
    bazelPath: 'bazel',
    testArgs: [],
    buildTestsOnly: false,
    runsPerTest: 0,
    runsPerTestDetectsFlakes: false,
    nocacheTestResults: false,
    testStrategyExclusive: false,
  } as Partial<ConfigurationService> as ConfigurationService;

  setup(() => {
    run = new MockTestRun();
    originalRun = processModule.runBazelCommand;
    (processModule as any).runBazelCommand = async () => {
      return {
        code: 4,
        stdout: '',
        stderr: 'Test retry passed after flake',
      };
    };
  });

  teardown(() => {
    if (originalRun) {
      (processModule as any).runBazelCommand = originalRun;
    }
  });

  test('marks run as failed on exit code 4 and pushes diagnostics', async () => {
    const item = new MockTestItem('//pkg:flaky_test', '[cc_test] flaky_test') as unknown as vscode.TestItem;
    await executeBazelTest(item, '/workspace', (run as unknown) as vscode.TestRun, mockConfig);

    const failed = run.getFailedTests();
    const skipped = run.getSkippedTests();
    assert.strictEqual(failed.length, 1, 'Flaky exit code should mark test as failed');
    assert.strictEqual(skipped.length, 0, 'Flaky exit code should not mark test as skipped');
  });
});
