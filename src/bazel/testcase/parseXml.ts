/*
 * Copyright (c) 2025 @tragisch
 * SPDX-License-Identifier: MIT
 */

/**
 * Structured test.xml parser - reads Bazel generated JUnit XML for individual test cases
 */

import * as fs from 'fs/promises';
import { logWithTimestamp, formatError } from '../../logging';
import { IndividualTestCase, TestCaseParseResult } from '../types';
import { buildTestXmlPath, getBazelTestLogsDirectory, hasTestXmlFile } from '../testlogs';

const FRAMEWORK_ID = 'bazel_test_xml';

type TestXmlReader = (targetLabel: string, workspacePath: string, bazelPath: string) => Promise<TestCaseParseResult | null>;

const attrPattern = /([A-Za-z_][\w:\-\.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

export const readStructuredTestXmlResult: TestXmlReader = async (
  targetLabel: string,
  workspacePath: string,
  bazelPath: string
): Promise<TestCaseParseResult | null> => {
  try {
    const logsDir = await getBazelTestLogsDirectory(workspacePath, bazelPath);
    if (!logsDir) {
      return null;
    }

    const xmlPath = buildTestXmlPath(targetLabel, logsDir);
    if (!hasTestXmlFile(xmlPath)) {
      return null;
    }

    const xmlContent = await fs.readFile(xmlPath, 'utf8');
    if (!xmlContent.trim()) {
      return null;
    }

    const parsed = parseStructuredTestXml(xmlContent, targetLabel);
    if (parsed.testCases.length > 0) {
      logWithTimestamp(`Parsed ${parsed.testCases.length} test cases from structured XML for ${targetLabel}`);
    }
    return parsed;
  } catch (error) {
    logWithTimestamp(`Failed to parse structured test.xml for ${targetLabel}: ${formatError(error)}`, 'warn');
    return null;
  }
};

export function parseStructuredTestXml(xmlContent: string, parentTarget: string): TestCaseParseResult {
  const normalizedXml = xmlContent.replace(/\r\n/g, '\n');
  const testCases: IndividualTestCase[] = [];

  const suiteRegex = /<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>/gi;
  let suiteMatch: RegExpExecArray | null;
  let matchedSuite = false;

  while ((suiteMatch = suiteRegex.exec(normalizedXml)) !== null) {
    matchedSuite = true;
    const suiteAttrs = parseAttributes(suiteMatch[1] ?? '');
    const suiteName = decodeXmlEntities(suiteAttrs.name ?? '');
    const suiteBody = suiteMatch[2] ?? '';
    extractTestCasesFromSuiteBody(suiteBody, suiteName, parentTarget, testCases);
  }

  if (!matchedSuite) {
    extractTestCasesFromSuiteBody(normalizedXml, undefined, parentTarget, testCases);
  }

  const summary = summarizeTestCases(testCases);
  return {
    testCases,
    summary
  };
}

function extractTestCasesFromSuiteBody(
  suiteBody: string,
  suiteName: string | undefined,
  parentTarget: string,
  collector: IndividualTestCase[]
): void {
  const casePattern = /<testcase\b([^>]*)\s*(?:\/>|>([\s\S]*?)<\/testcase>)/gi;
  let caseMatch: RegExpExecArray | null;

  while ((caseMatch = casePattern.exec(suiteBody)) !== null) {
    const attrString = caseMatch[1] ?? '';
    const body = caseMatch[2] ?? '';
    const attrs = parseAttributes(attrString);
    const name = decodeXmlEntities(attrs.name ?? '');
    if (!name) {
      continue;
    }

    const file = decodeXmlEntities(attrs.file ?? '');
    const line = attrs.line ? parseInt(attrs.line, 10) || 0 : 0;
    const className = decodeXmlEntities(attrs.classname ?? '');

    const failure = extractTag(body, 'failure');
    const error = extractTag(body, 'error');
    const skipped = extractSelfClosingTag(body, 'skipped');

    let status: IndividualTestCase['status'] = 'PASS';
    let errorMessage: string | undefined;

    if (failure) {
      const type = (failure.attributes.type ?? '').toLowerCase();
      status = type === 'timeout' ? 'TIMEOUT' : 'FAIL';
      errorMessage = buildMessage(failure);
    } else if (error) {
      const type = (error.attributes.type ?? '').toLowerCase();
      status = type === 'timeout' ? 'TIMEOUT' : 'FAIL';
      errorMessage = buildMessage(error);
    } else if (skipped) {
      status = 'SKIP';
      errorMessage = buildMessage(skipped);
    } else {
      const result = (attrs.result ?? '').toLowerCase();
      const rawStatus = (attrs.status ?? '').toLowerCase();
      if (result.includes('timeout') || rawStatus.includes('timeout')) {
        status = 'TIMEOUT';
      }
    }

    const testCase: IndividualTestCase = {
      name,
      file,
      line,
      parentTarget,
      status,
      errorMessage: errorMessage?.trim() || undefined,
      suite: suiteName || undefined,
      className: className || undefined,
      frameworkId: FRAMEWORK_ID
    };

    collector.push(testCase);
  }
}

function parseAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let match: RegExpExecArray | null;
  attrPattern.lastIndex = 0;
  while ((match = attrPattern.exec(input)) !== null) {
    const key = match[1];
    const value = match[3] ?? match[4] ?? '';
    attrs[key] = value;
  }
  return attrs;
}

interface ParsedTag {
  attributes: Record<string, string>;
  text: string;
}

function extractTag(section: string, tagName: string): ParsedTag | undefined {
  const regex = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = section.match(regex);
  if (!match) {
    return undefined;
  }

  const attributes = parseAttributes(match[1] ?? '');
  const rawText = match[2] ?? '';
  return {
    attributes,
    text: decodeCData(rawText)
  };
}

function extractSelfClosingTag(section: string, tagName: string): ParsedTag | undefined {
  const regex = new RegExp(`<${tagName}\\b([^>]*)\\/>`, 'i');
  const match = section.match(regex);
  if (!match) {
    return undefined;
  }
  const attributes = parseAttributes(match[1] ?? '');
  return {
    attributes,
    text: ''
  };
}

function decodeCData(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('<![CDATA[') && trimmed.endsWith(']]>')) {
    const content = trimmed.substring(9, trimmed.length - 3);
    return content;
  }
  return decodeXmlEntities(trimmed);
}

function buildMessage(tag: ParsedTag): string | undefined {
  const attrMessage = tag.attributes.message ? decodeXmlEntities(tag.attributes.message) : undefined;
  const text = tag.text ? decodeXmlEntities(tag.text) : undefined;
  const combined = [attrMessage, text].filter(value => !!value && value.trim().length > 0);
  if (combined.length === 0) {
    return undefined;
  }
  return combined.join('\n').trim();
}

function decodeXmlEntities(value: string): string {
  if (!value) {
    return '';
  }
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function summarizeTestCases(testCases: IndividualTestCase[]): TestCaseParseResult['summary'] {
  let passed = 0;
  let failed = 0;
  let ignored = 0;

  for (const testCase of testCases) {
    if (testCase.status === 'PASS') {
      passed++;
    } else if (testCase.status === 'SKIP') {
      ignored++;
    } else if (testCase.status === 'FAIL' || testCase.status === 'TIMEOUT') {
      failed++;
    }
  }

  return {
    total: testCases.length,
    passed,
    failed,
    ignored
  };
}
