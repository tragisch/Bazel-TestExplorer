/*
 * Source resolution utilities for Bazel TestExplorer
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { BazelTestTarget } from '../bazel/types';

// Package-level cache to avoid repeated fs.existsSync calls for the same package.
type PackageCacheEntry = { dirExists: boolean; files?: Set<string> };
const packageFileCache: Map<string, PackageCacheEntry> = new Map();

export function resolveSourceUri(
  testTarget: BazelTestTarget,
  packageName: string,
  testName: string
): vscode.Uri | undefined {
  // Try to use source files from metadata first
  if (testTarget.srcs && testTarget.srcs.length > 0) {
    const preferredSrc = selectPreferredSourceFile(testTarget.srcs);
    const srcUri = bazelLabelToUri(preferredSrc);
    if (srcUri) {
      return srcUri;
    }
  }

  // Fallback to guessing strategy
  return guessSourceUri(packageName, testName, testTarget.type);
}

export function selectPreferredSourceFile(srcs: string[]): string {
  if (srcs.length === 1) return srcs[0];

  const runnerFile = srcs.find(s => s.includes('_Runner.c') || s.includes('_Runner.cc'));
  if (runnerFile) {
    const nonRunner = srcs.find(s => !s.includes('_Runner.c') && !s.includes('_Runner.cc'));
    if (nonRunner) return nonRunner;
  }
  return srcs[0];
}

export function bazelLabelToUri(label: string): vscode.Uri | undefined {
  const workspace = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  if (!workspace) return undefined;

  let packagePath: string;
  let fileName: string;

  if (label.includes(':')) {
    const [pkg, file] = label.split(':');
    packagePath = pkg.replace(/^\/\//, '');
    fileName = file;
  } else {
    packagePath = label.replace(/^\/\//, '');
    const parts = packagePath.split('/');
    fileName = parts.pop() || '';
    packagePath = parts.join('/');
  }

  const fullPath = path.join(workspace, packagePath, fileName);
  try {
    if (fs.existsSync(fullPath)) {
      return vscode.Uri.file(fullPath);
    }
  } catch (e) {
    // ignore
  }
  return undefined;
}

export function guessSourceUri(
  packageName: string,
  testName: string,
  testType: string
): vscode.Uri | undefined {
  const workspace = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
  const packagePath = packageName.replace(/^\/\//, '');
  const extensions = getExtensionsByType(testType);
  const packageCacheKey = packagePath;

  if (!packageFileCache.has(packageCacheKey)) {
    const dirFull = path.join(workspace, packagePath);
    try {
      if (fs.existsSync(dirFull) && fs.statSync(dirFull).isDirectory()) {
        const names = new Set<string>(fs.readdirSync(dirFull));
        packageFileCache.set(packageCacheKey, { dirExists: true, files: names });
      } else {
        packageFileCache.set(packageCacheKey, { dirExists: false });
      }
    } catch (e) {
      packageFileCache.set(packageCacheKey, { dirExists: false });
    }
  }

  const cacheEntry = packageFileCache.get(packageCacheKey)!;
  if (!cacheEntry.dirExists) return undefined;

  for (const ext of extensions) {
    const candidate = testName + ext;
    if (cacheEntry.files && cacheEntry.files.has(candidate)) {
      return vscode.Uri.file(path.join(workspace, packagePath, candidate));
    }
  }

  return undefined;
}

export function getExtensionsByType(testType: string): string[] {
  const typeMap: Record<string, string[]> = {
    'cc_test': ['.cc', '.cpp', '.c'],
    'unity_test': ['.c'],
    'py_test': ['.py'],
    'java_test': ['.java'],
    'go_test': ['.go'],
    'ts_test': ['.ts', '.tsx'],
    'rust_test': ['.rs']
  };
  return typeMap[testType] || ['.c'];
}

/**
 * Extracts the package portion of a Bazel target label.
 *
 * Examples:
 *   //pkg/path:target   -> //pkg/path
 *   //pkg/path          -> //pkg/path
 *   //pkg/path:         -> //pkg/path
 *   pkg/path:target     -> pkg/path
 *   :target             -> ''
 *   pkg/path            -> pkg/path
 */
function extractPackageLabelFromTarget(targetId: string): string {
  if (targetId.startsWith('//')) {
    const withoutPrefix = targetId.slice(2);
    const colonIndex = withoutPrefix.indexOf(':');
    const pkg = colonIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, colonIndex);
    return '//' + pkg;
  }

  if (targetId.startsWith(':')) {
    // Label like ":target" has no explicit package component here.
    return '';
  }

  const colonIndex = targetId.indexOf(':');
  return colonIndex === -1 ? targetId : targetId.slice(0, colonIndex);
}

export function resolveSourceFromMetadata(
  targetId: string,
  workspacePath: string,
  metadata: BazelTestTarget
): { file: string; line?: number } | undefined {
  const packageLabel = extractPackageLabelFromTarget(targetId);
  const packagePath = packageLabel.replace(/^\/\//, '');
  const candidates: { file: string; line?: number }[] = [];

  if (metadata.srcs && metadata.srcs.length > 0) {
    for (const src of metadata.srcs) {
      const normalized = normalizeSrcEntry(src, packagePath);
      if (normalized) candidates.push({ file: normalized });
    }
  }

  if (metadata.location) {
    const parsed = parseLocation(metadata.location);
    if (parsed) candidates.push(parsed);
  }

  for (const candidate of candidates) {
    const absolute = toAbsolutePath(candidate.file, workspacePath);
    if (fs.existsSync(absolute)) return candidate;
  }
  return undefined;
}

export function normalizeSrcEntry(src: string, packagePath: string): string | undefined {
  if (!src) return undefined;
  if (src.startsWith('//')) {
    const withoutPrefix = src.slice(2);
    const [pkg, file] = withoutPrefix.split(':');
    if (pkg && file) return path.posix.join(pkg, file);
    return pkg;
  }
  if (src.startsWith(':')) {
    const file = src.slice(1);
    return path.posix.join(packagePath, file);
  }
  if (src.includes(':')) {
    const [pkg, file] = src.split(':');
    if (file) return path.posix.join(pkg.replace(/^\/\//, ''), file);
  }
  return path.posix.join(packagePath, src);
}

export function parseLocation(location: string): { file: string; line?: number } | undefined {
  const match = location.match(/^(.*?):(\d+)(?::\d+)?$/);
  if (!match) return undefined;
  const file = match[1];
  const line = parseInt(match[2], 10);
  return { file, line: Number.isFinite(line) ? line : undefined };
}

export function selectFilePath(primary?: string, fallback?: string): string | undefined {
  if (primary && primary.trim().length > 0) {
    const normalized = primary.trim();
    const hasSeparator = normalized.includes('/') || normalized.includes(path.sep);
    if (hasSeparator || !fallback) return normalized;
    const fallbackDir = fallback.includes('/') || fallback.includes(path.sep)
      ? path.posix.dirname(fallback).replace(/\\/g, '/')
      : '';
    if (fallbackDir) return path.posix.join(fallbackDir, normalized);
    return normalized;
  }
  return fallback;
}

export function toAbsolutePath(filePath: string, workspacePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  return path.join(workspacePath, filePath);
}
