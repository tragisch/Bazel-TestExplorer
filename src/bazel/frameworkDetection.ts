/*
 * Framework detection utilities
 */

import { BazelTestTarget } from './types';

export const FRAMEWORK_PATTERNS: Record<string, string[]> = {
  rust: ['rust_test'],
  pytest: ['pytest_python', 'pytest_assertion_line'],
  unity: ['unity_c_standard', 'unity_c_with_message'],
  doctest: ['doctest_cpp', 'doctest_subcase'],
  catch2: ['catch2_cpp', 'catch2_passed', 'catch2_summary'],
  gtest: ['gtest_cpp'],
  check: ['parentheses_format', 'check_framework'],
  ctest: ['ctest_output', 'ctest_verbose'],
  go: ['go_test'],
  junit: ['junit_java']
};

export function detectFrameworks(metadata?: BazelTestTarget): string[] {
  if (!metadata) {
    return [];
  }
  const frameworks = new Set<string>();
  const type = metadata.type?.toLowerCase() ?? '';
  const deps = (metadata.deps ?? []).map(dep => dep.toLowerCase());

  const hasDep = (...keywords: string[]) => deps.some(dep => keywords.some(keyword => dep.includes(keyword)));

  if (type.includes('rust')) {
    frameworks.add('rust');
  }

  if (type.includes('py_test') || hasDep('pytest')) {
    frameworks.add('pytest');
  }

  if (type.includes('go_test')) {
    frameworks.add('go');
  }

  if (type.includes('java_test') || type.includes('junit')) {
    frameworks.add('junit');
  }

  if (type.includes('cc_test')) {
    if (hasDep('gtest', 'googletest')) {
      frameworks.add('gtest');
    }
    if (hasDep('catch2')) {
      frameworks.add('catch2');
    }
    if (hasDep('doctest')) {
      frameworks.add('doctest');
    }
    if (hasDep('throw_the_switch', 'unity')) {
      frameworks.add('unity');
    }
  }

  return Array.from(frameworks);
}

export function detectPrimaryFramework(metadata?: BazelTestTarget): string | undefined {
  const detected = detectFrameworks(metadata);
  return detected.length > 0 ? detected[0] : undefined;
}
