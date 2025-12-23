/*
 * Tests for manual-tag filtering during global runs
 */

/// <reference types="mocha" />
import * as assert from 'assert';
import * as vscode from 'vscode';
import { TestControllerManager } from '../../explorer/controller';
import { MockTestController, MockTestItem } from '../mocks';
import { MockConfigurationService } from '../mocks';

suite('Run Profile - Manual Tag Filtering', () => {
  let mockController: MockTestController;
  let originalCreate: typeof vscode.tests.createTestController | undefined;

  setup(() => {
    mockController = new MockTestController();
    originalCreate = vscode.tests.createTestController;
    (vscode.tests as any).createTestController = () => mockController as any;
  });

  teardown(() => {
    if (originalCreate) {
      (vscode.tests as any).createTestController = originalCreate;
    }
    mockController.reset();
  });

  test('skips manual targets on global run', async () => {
    const config = new MockConfigurationService() as any;
    const mockClient = {
      runTest: async (_t: any, _run: any) => { /* no-op */ },
      getTargetMetadata: (id: string) => {
        if (id === '//pkg:manual_test') return { target: id, type: 'cc_test', tags: ['manual'] };
        if (id === '//pkg:normal_test') return { target: id, type: 'cc_test', tags: [] };
        return undefined;
      }
    } as any;
    const context = { subscriptions: [] } as any;
    const annotations = { clear: () => {} } as any;
    const insights = { clear: () => {} } as any;

    const manager = new TestControllerManager(mockClient, config, context, annotations, insights);
    manager.initialize();

    // Build tree: root package -> two tests
    const pkg = mockController.createTestItem('//pkg', '📦 package') as any as vscode.TestItem;
    (mockController.items as any).add(pkg);
    const manual = mockController.createTestItem('//pkg:manual_test', '[cc_test] manual_test') as any as vscode.TestItem;
    const normal = mockController.createTestItem('//pkg:normal_test', '[cc_test] normal_test') as any as vscode.TestItem;
    (pkg as any).children.add(manual as any);
    (pkg as any).children.add(normal as any);

    // Invoke Run profile handler with global run (no include)
    const runProfiles = mockController.getRunProfiles();
    assert.ok(runProfiles.length > 0, 'Run profile should be registered');
    const handler = runProfiles[0].runHandler;

    const token = { isCancellationRequested: false } as any;
    await handler({ include: [] } as any, token);

    const lastRun = mockController.getLastRun();
    assert.ok(lastRun, 'A test run should be created');
    const skipped = lastRun!.getSkippedTests();
    const failed = lastRun!.getFailedTests();

    const skippedIds = skipped.map(t => (t as any).id);
    assert.ok(skippedIds.includes('//pkg:manual_test'), 'Manual test should be skipped in global run');
    assert.ok(!skippedIds.includes('//pkg:normal_test'), 'Normal test should not be skipped');
    assert.strictEqual(failed.length, 0, 'No tests should fail in this scenario');
  });
});
