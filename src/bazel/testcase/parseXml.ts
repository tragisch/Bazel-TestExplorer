/*
 * Copyright (c) 2025 @tragisch
 * SPDX-License-Identifier: MIT
 */

/**
 * Structured test.xml parser - reads Bazel generated JUnit XML for individual test cases
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { logWithTimestamp, formatError } from '../../logging';
import { IndividualTestCase, TestCaseParseResult } from '../types';
import { buildTestXmlPath, getBazelTestLogsDirectory, hasTestXmlFile } from '../testlogs';
import { extractTestCasesFromOutput } from './parseOutput';

const FRAMEWORK_ID = 'bazel_test_xml';

type TestXmlReader = (
  targetLabel: string,
  workspacePath: string,
  bazelPath: string,
  allowedPatternIds?: string[]
) => Promise<TestCaseParseResult | null>;

const attrPattern = /([A-Za-z_][\w:\-\.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

export const readStructuredTestXmlResult: TestXmlReader = async (
  targetLabel: string,
  workspacePath: string,
  bazelPath: string,
  allowedPatternIds?: string[]
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

    const parsed = parseStructuredTestXml(xmlContent, targetLabel, { allowedPatternIds });
    if (parsed.testCases.length > 0) {
      logWithTimestamp(`Parsed ${parsed.testCases.length} test cases from structured XML for ${targetLabel}`);
    }
    return parsed;
  } catch (error) {
    logWithTimestamp(`Failed to parse structured test.xml for ${targetLabel}: ${formatError(error)}`, 'warn');
    return null;
  }
};

interface ParseXmlOptions {
  allowedPatternIds?: string[];
}

export function parseStructuredTestXml(
  xmlContent: string,
  parentTarget: string,
  options?: ParseXmlOptions
): TestCaseParseResult {
  const normalizedXml = xmlContent.replace(/\r\n/g, '\n');
  const testCases: IndividualTestCase[] = [];
  const systemOutSections = collectSystemOutSections(normalizedXml);
  const targetPackagePath = extractPackagePath(parentTarget);

  const suiteRegex = /<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>/gi;
  let suiteMatch: RegExpExecArray | null;
  let matchedSuite = false;

  while ((suiteMatch = suiteRegex.exec(normalizedXml)) !== null) {
    matchedSuite = true;
    const suiteAttrs = parseAttributes(suiteMatch[1] ?? '');
    const suiteName = decodeXmlEntities(suiteAttrs.name ?? '');
    const suiteBody = suiteMatch[2] ?? '';
    extractTestCasesFromSuiteBody(suiteBody, suiteName, parentTarget, testCases, targetPackagePath);
  }

  if (!matchedSuite) {
    extractTestCasesFromSuiteBody(normalizedXml, undefined, parentTarget, testCases, targetPackagePath);
  }

  let finalTestCases = testCases;
  let detectedFramework: string | undefined;

  if (systemOutSections.length > 0) {
    const combinedOut = systemOutSections.join('\n').trim();
    if (combinedOut.length > 0) {
      detectedFramework = detectFrameworkFromSystemOut(combinedOut);
      const fallback = extractTestCasesFromOutput(
        combinedOut,
        parentTarget,
        options?.allowedPatternIds ?? resolveFallbackPatterns(detectedFramework)
      );
      finalTestCases = mergeStructuredWithSystemOut(testCases, fallback.testCases);
    }
  }

  const summary = summarizeTestCases(finalTestCases);
  return {
    testCases: finalTestCases,
    summary
  };
}

function extractTestCasesFromSuiteBody(
  suiteBody: string,
  suiteName: string | undefined,
  parentTarget: string,
  collector: IndividualTestCase[],
  packagePath?: string
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

    if (testCase.errorMessage) {
      const loc = extractLocationFromMessage(testCase.errorMessage, packagePath);
      if (loc) {
        if (!testCase.file || testCase.file.trim().length === 0) {
          testCase.file = loc.file;
        }
        if (!testCase.line || testCase.line <= 0) {
          testCase.line = loc.line;
        }
      }
      testCase.errorMessage = cleanFailureMessage(testCase.errorMessage);
    }

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

function collectSystemOutSections(xml: string): string[] {
  const sections: string[] = [];
  const regex = /<system-out>([\s\S]*?)<\/system-out>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    const raw = match[1] ?? '';
    sections.push(decodeCData(raw));
  }
  return sections;
}

function mergeStructuredWithSystemOut(
  structured: IndividualTestCase[],
  fallbackCases: IndividualTestCase[]
): IndividualTestCase[] {
  if (fallbackCases.length === 0) {
    return structured;
  }

  if (structured.length === 0 || structured.every(caseItem => !hasLocation(caseItem))) {
    return fallbackCases.map(caseItem => ({ ...caseItem, frameworkId: caseItem.frameworkId || FRAMEWORK_ID }));
  }

  const fallbackMap = new Map<string, IndividualTestCase>();
  for (const fallback of fallbackCases) {
    fallbackMap.set(buildCaseKey(fallback), fallback);
  }

  const merged = structured.map(item => {
    if (hasLocation(item)) {
      return item;
    }
    const fallback = fallbackMap.get(buildCaseKey(item));
    if (!fallback) {
      return item;
    }
    return {
      ...item,
      file: item.file || fallback.file,
      line: item.line && item.line > 0 ? item.line : fallback.line,
      status: item.status || fallback.status,
      errorMessage: item.errorMessage || fallback.errorMessage,
      suite: item.suite || fallback.suite,
      className: item.className || fallback.className,
      frameworkId: item.frameworkId || fallback.frameworkId
    };
  });

  // Append any fallback cases not present in structured set
  for (const fallback of fallbackCases) {
    const key = buildCaseKey(fallback);
    const alreadyPresent = merged.some(existing => buildCaseKey(existing) === key);
    if (!alreadyPresent) {
      merged.push(fallback);
    }
  }

  return merged;
}

function hasLocation(testCase: IndividualTestCase): boolean {
  return !!(testCase.file && testCase.file.trim().length > 0 && testCase.line && testCase.line > 0);
}

function buildCaseKey(testCase: IndividualTestCase): string {
  const scope = (testCase.suite || testCase.className || '').toLowerCase();
  return `${scope}::${testCase.name.toLowerCase()}`;
}

function extractLocationFromMessage(message: string, packagePath?: string): { file: string; line: number } | undefined {
  const matcher = message.matchAll(/([^\s():]+\.\w+):(\d+)/g);
  const candidates = Array.from(matcher);
  if (candidates.length === 0) {
    return undefined;
  }

  const preferPackage = packagePath
    ? candidates.find(match => match[1].includes(packagePath))
    : undefined;
  const preferred = preferPackage
    ?? candidates.find(match => isLikelyUserCode(match[1]))
    ?? candidates[candidates.length - 1];

  return {
    file: preferred[1],
    line: parseInt(preferred[2], 10) || 0
  };
}

function isLikelyUserCode(file: string): boolean {
  const lower = file.toLowerCase();
  const base = path.basename(file).toLowerCase();
  if (lower.includes('/org/junit') || lower.includes('\\org\\junit')) {
    return false;
  }
  if (base.startsWith('assert.') || base.endsWith('runner.java')) {
    return false;
  }
  return true;
}

function cleanFailureMessage(message: string): string {
  return message
    .replace(/--- FAIL: .*?\(\d+(?:\.\d+)?s\)\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPackagePath(targetLabel: string): string | undefined {
  const match = targetLabel.match(/^\/\/(.+):/);
  return match ? match[1] : undefined;
}

function detectFrameworkFromSystemOut(log: string): string | undefined {
  if (/pytest-[\d.]+/i.test(log)) {
    return 'pytest';
  }
  if (/unittest/.test(log)) {
    return 'unittest';
  }
  return undefined;
}

function resolveFallbackPatterns(framework?: string): string[] | undefined {
  if (!framework) {
    return undefined;
  }
  switch (framework) {
    case 'pytest':
      return ['pytest_python', 'pytest_assertion_line'];
    default:
      return undefined;
  }
}
