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
	covered: number;
	total: number;
	percent: number;
	files: CoverageFileSummary[];
}

const coverageByTarget = new Map<string, CoverageSummary>();

export const setCoverageSummary = (targetId: string, summary: CoverageSummary): void => {
	coverageByTarget.set(targetId, summary);
};

export const getCoverageSummary = (targetId: string): CoverageSummary | undefined => {
	return coverageByTarget.get(targetId);
};

export const formatCoverageShort = (summary: CoverageSummary): string => {
	return `cov=${summary.percent.toFixed(1)}%`;
};
