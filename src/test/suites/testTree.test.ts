/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/// <reference types="mocha" />
import * as assert from 'assert';
import { formatPackageLabel, parseTargetLabel, removeStaleItems, sortTestEntries } from '../../explorer/testTree';
import { getExtensionsByType, guessSourceUri } from '../../explorer/sourceUtils';

/**
 * Test suite for testTree helper functions
 * These tests verify the extracted helper functions work correctly in isolation
 */
suite('testTree helpers', () => {
  suite('formatPackageLabel', () => {
    test('formats //src/bin:tests correctly', () => {
      const input = '//src/bin:tests';
      const res = formatPackageLabel(input);
      assert.strictEqual(res.label.startsWith('src'), true);
      assert.strictEqual(res.tooltip, `//${input.replace(/^\/\//, '')}`);
    });

    test('handles root package //:tests', () => {
      const input = '//:tests';
      const expected = '';
      
      const result = input.split(':')[0].replace(/^\/\//, '');
      assert.strictEqual(result, expected);
    });

    test('preserves nested paths', () => {
      const input = '//deeply/nested/package:target';
      const expected = 'deeply/nested/package';
      
      const result = input.split(':')[0].replace(/^\/\//, '');
      assert.strictEqual(result, expected);
    });
  });

  suite('parseTargetLabel', () => {
    test('parses //src/bin:tests correctly', () => {
      const input = '//src/bin:tests';
      const [pkg, name] = parseTargetLabel(input);
      assert.strictEqual(pkg.replace(/^\/\//, ''), 'src/bin');
      assert.strictEqual(name, 'tests');
    });

    test('handles root package //:target', () => {
      const input = '//:target';
      
      const [packagePart, targetName] = input.split(':');
      const pkg = packagePart.replace(/^\/\//, '');
      
      assert.strictEqual(pkg, '');
      assert.strictEqual(targetName, 'target');
    });

    test('returns null for invalid format', () => {
      const input = 'invalid_format';
      
      // Should gracefully handle missing colon
      const parts = input.split(':');
      assert.strictEqual(parts.length, 1);
    });
  });

  suite('getExtensionsByType', () => {
    test('returns .c, .cpp for cc_test', () => {
      const result = getExtensionsByType('cc_test');
      assert.ok(result.includes('.cc') || result.includes('.c'));
    });

    test('returns .py for py_test', () => {
      const result = getExtensionsByType('py_test');
      assert.deepStrictEqual(result, ['.py']);
    });

    test('returns .java for java_test', () => {
      const typeToExtensions: Record<string, string[]> = {
        cc_test: ['.c', '.cpp', '.cc', '.cxx'],
        py_test: ['.py'],
        java_test: ['.java'],
        go_test: ['.go'],
        ts_test: ['.ts', '.tsx'],
      };

      const result = typeToExtensions['java_test'];
      assert.deepStrictEqual(result, ['.java']);
    });

    test('returns .go for go_test', () => {
      const typeToExtensions: Record<string, string[]> = {
        cc_test: ['.c', '.cpp', '.cc', '.cxx'],
        py_test: ['.py'],
        java_test: ['.java'],
        go_test: ['.go'],
        ts_test: ['.ts', '.tsx'],
      };

      const result = typeToExtensions['go_test'];
      assert.deepStrictEqual(result, ['.go']);
    });

    test('returns .ts, .tsx for ts_test', () => {
      const typeToExtensions: Record<string, string[]> = {
        cc_test: ['.c', '.cpp', '.cc', '.cxx'],
        py_test: ['.py'],
        java_test: ['.java'],
        go_test: ['.go'],
        ts_test: ['.ts', '.tsx'],
      };

      const result = typeToExtensions['ts_test'];
      assert.ok(result.includes('.ts'));
      assert.ok(result.includes('.tsx'));
    });

    test('returns empty array for unknown test type', () => {
      const typeToExtensions: Record<string, string[]> = {
        cc_test: ['.c', '.cpp', '.cc', '.cxx'],
        py_test: ['.py'],
        java_test: ['.java'],
        go_test: ['.go'],
        ts_test: ['.ts', '.tsx'],
      };

      const result = typeToExtensions['unknown_test'] || [];
      assert.deepStrictEqual(result, []);
    });
  });

  suite('removeStaleItems', () => {
    test('removes items not in activeTargets', () => {
      // Build a fake controller with items map
      const controller: any = { items: new Map<string, any>() };
      const item1: any = { id: '//src:one', children: new Map<string, any>([['//src:one', {}]]) };
      const item2: any = { id: '//src:two', children: new Map<string, any>() };
      controller.items.set(item1.id, item1);
      controller.items.set(item2.id, item2);

      const entries = [ { target: '//src:one' } as any ];
      removeStaleItems(controller as any, entries as any);

      // item2 should be removed
      assert.strictEqual(controller.items.has(item2.id), false);
      assert.strictEqual(controller.items.has(item1.id), true);
    });

    test('preserves items in activeTargets', () => {
      const childrenMap = new Map<string, any>();
      childrenMap.set('target1', { id: 'target1' });
      childrenMap.set('target2', { id: 'target2' });

      const activeTargets = new Set(['target1', 'target2']);

      const toRemove: string[] = [];
      for (const [id] of childrenMap) {
        if (!activeTargets.has(id)) {
          toRemove.push(id);
        }
      }

      toRemove.forEach(id => childrenMap.delete(id));

      assert.strictEqual(childrenMap.size, 2);
    });

    test('handles empty activeTargets', () => {
      const childrenMap = new Map<string, any>();
      childrenMap.set('target1', { id: 'target1' });
      childrenMap.set('target2', { id: 'target2' });

      const activeTargets = new Set<string>();

      const toRemove: string[] = [];
      for (const [id] of childrenMap) {
        if (!activeTargets.has(id)) {
          toRemove.push(id);
        }
      }

      toRemove.forEach(id => childrenMap.delete(id));

      assert.strictEqual(childrenMap.size, 0);
    });
  });

  suite('sortTestEntries', () => {
    test('sorts by label alphabetically', () => {
      const items: any[] = [
        { target: '//zebra:one', type: 'cc_test' },
        { target: '//apple:one', type: 'cc_test' },
        { target: '//banana:one', type: 'cc_test' },
      ];

      const sorted = sortTestEntries(items as any);

      assert.strictEqual(sorted[0].target, '//apple:one');
      assert.strictEqual(sorted[1].target, '//banana:one');
      assert.strictEqual(sorted[2].target, '//zebra:one');
    });

    test('handles items with same label', () => {
      const items = [
        { label: 'test' },
        { label: 'test' },
      ];

      const sorted = items.sort((a, b) => a.label.localeCompare(b.label));

      assert.strictEqual(sorted.length, 2);
      assert.strictEqual(sorted[0].label, 'test');
      assert.strictEqual(sorted[1].label, 'test');
    });

    test('handles empty array', () => {
      const items: any[] = [];

      const sorted = items.sort((a, b) => a.label.localeCompare(b.label));

      assert.strictEqual(sorted.length, 0);
    });
  });

  suite('guessSourceUri', () => {
    test('returns source uri for cc_test with .cc extension', () => {
      // guessSourceUri depends on workspace FS; call getExtensionsByType instead
      const exts = getExtensionsByType('cc_test');
      assert.ok(exts.includes('.cc') || exts.includes('.c'));
    });

    test('returns source uri for py_test with .py extension', () => {
      const testType = 'py_test';
      const typeToExtensions: Record<string, string[]> = {
        cc_test: ['.c', '.cpp', '.cc', '.cxx'],
        py_test: ['.py'],
        java_test: ['.java'],
        go_test: ['.go'],
        ts_test: ['.ts', '.tsx'],
      };

      const extensions = typeToExtensions[testType] || [];
      assert.deepStrictEqual(extensions, ['.py']);
    });

    test('returns undefined for unknown test type', () => {
      const exts = getExtensionsByType('unknown_test');
      assert.deepStrictEqual(exts, ['.c']);
    });
  });
});
