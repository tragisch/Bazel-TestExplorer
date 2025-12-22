/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/**
 * Unified test result parser - relies on Bazel test.xml and its embedded logs for structured data.
 */

import { TestCaseParseResult } from '../types';
import { readStructuredTestXmlResult } from './parseXml';

export type TestResultSource = 'xml' | 'none';

export interface UnifiedTestResult extends TestCaseParseResult {
  source: TestResultSource;
}

export interface UnifiedParseParams {
  targetLabel: string;
  workspacePath: string;
  bazelPath: string;
  allowedPatternIds?: string[];
}

export type TestXmlLoader = (
  targetLabel: string,
  workspacePath: string,
  bazelPath: string,
  allowedPatternIds?: string[]
) => Promise<TestCaseParseResult | null>;

let xmlLoader: TestXmlLoader = readStructuredTestXmlResult;

export function setTestXmlLoader(loader: TestXmlLoader): void {
  xmlLoader = loader;
}

export function getTestXmlLoader(): TestXmlLoader {
  return xmlLoader;
}

const EMPTY_RESULT: TestCaseParseResult = {
  testCases: [],
  summary: { total: 0, passed: 0, failed: 0, ignored: 0 }
};

export async function parseUnifiedTestResult(params: UnifiedParseParams): Promise<UnifiedTestResult> {
  const structuredResult = await xmlLoader(
    params.targetLabel,
    params.workspacePath,
    params.bazelPath,
    params.allowedPatternIds
  );

  if (structuredResult) {
    return {
      ...structuredResult,
      source: 'xml'
    };
  }

  return {
    ...EMPTY_RESULT,
    source: 'none'
  };
}
