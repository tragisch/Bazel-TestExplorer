/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

export interface CoverageFileSummary {
	path: string;
	covered: number;
	total: number;
	percent: number;
}

export interface CoverageSummary {
	kind?: string;
	covered: number;
	total: number;
	percent: number;
	files: CoverageFileSummary[];
	artifacts?: CoverageArtifacts;
	coverageArgs?: string[];
	generated?: boolean;
}

export interface CoverageArtifacts {
	lcov?: string[];
	profraw?: string[];
	profdata?: string[];
	testlogs?: string[];
}

export interface CoverageRun {
	id: string;
	timestamp: number;
	summary: CoverageSummary;
}

interface CoverageTargetState {
	latest: CoverageSummary;
	runs: CoverageRun[];
}

const coverageByTarget = new Map<string, CoverageTargetState>();
let storage: { get: (key: string) => unknown; set: (key: string, value: unknown) => Thenable<void> } | undefined;
const STORAGE_KEY = 'bazelTestExplorer.coverageSummaries';
const MAX_RUNS_PER_TARGET = 5;
const MAX_RUN_AGE_DAYS = 14;

export const initializeCoverageState = (
	state: { get: (key: string) => unknown; update: (key: string, value: unknown) => Thenable<void> }
): void => {
	storage = {
		get: (key) => state.get(key),
		set: (key, value) => state.update(key, value)
	};
	const raw = storage.get(STORAGE_KEY);
	if (!raw || typeof raw !== 'object') {
		return;
	}
	const entries = Object.entries(raw as Record<string, CoverageTargetState | CoverageSummary>);
	for (const [key, value] of entries) {
		if (!value || typeof value !== 'object') continue;
		if ('latest' in value && 'runs' in value) {
			coverageByTarget.set(key, value as CoverageTargetState);
			continue;
		}
		const summary = value as CoverageSummary;
		if (typeof summary.percent === 'number') {
			const run: CoverageRun = {
				id: `legacy-${Date.now()}`,
				timestamp: Date.now(),
				summary
			};
			coverageByTarget.set(key, { latest: summary, runs: [run] });
		}
	}
};

export const setCoverageSummary = (targetId: string, summary: CoverageSummary): void => {
	const run: CoverageRun = {
		id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		timestamp: Date.now(),
		summary
	};
	const existing = coverageByTarget.get(targetId);
	const runs = existing ? [run, ...existing.runs] : [run];
	const cutoff = Date.now() - MAX_RUN_AGE_DAYS * 24 * 60 * 60 * 1000;
	const trimmed = runs.filter(r => r.timestamp >= cutoff).slice(0, MAX_RUNS_PER_TARGET);
	coverageByTarget.set(targetId, { latest: summary, runs: trimmed });
	if (storage) {
		const serialized = Object.fromEntries(coverageByTarget.entries());
		void storage.set(STORAGE_KEY, serialized);
	}
};

export const removeCoverageTarget = (targetId: string): void => {
	if (coverageByTarget.delete(targetId) && storage) {
		const serialized = Object.fromEntries(coverageByTarget.entries());
		void storage.set(STORAGE_KEY, serialized);
	}
};

export const getCoverageSummary = (targetId: string): CoverageSummary | undefined => {
	return coverageByTarget.get(targetId)?.latest;
};

export const formatCoverageShort = (summary: CoverageSummary): string => {
	return `cov=${summary.percent.toFixed(1)}%`;
};

export const getCoverageRuns = (targetId: string): CoverageRun[] => {
	return coverageByTarget.get(targetId)?.runs ?? [];
};
