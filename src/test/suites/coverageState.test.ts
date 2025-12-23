/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/// <reference types="mocha" />
import * as assert from 'assert';
import { formatCoverageShort, getCoverageRuns, getCoverageSummary, setCoverageSummary } from '../../coverage';

suite('Coverage State', () => {
	test('stores latest summary and exposes runs', () => {
		const target = '//apps/demo:target';
		const summary = {
			kind: 'line',
			covered: 10,
			total: 20,
			percent: 50,
			files: [
				{ path: '/tmp/a.ts', covered: 5, total: 10, percent: 50 }
			],
			artifacts: { lcov: ['/tmp/coverage.lcov'] }
		};

		setCoverageSummary(target, summary);
		const latest = getCoverageSummary(target);
		assert.ok(latest);
		assert.strictEqual(latest?.percent, 50);
		assert.strictEqual(formatCoverageShort(latest!), 'cov=50.0%');

		const runs = getCoverageRuns(target);
		assert.strictEqual(runs.length >= 1, true);
		assert.strictEqual(runs[0].summary.percent, 50);
	});
});
