/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/*
 * TestCaseInsights
 * - Keeps last known structured test.xml parsing results per target
 * - Enables commands/UI to display aggregated information
 */

import { TestCaseParseResult } from '../bazel/types';

export class TestCaseInsights {
  private readonly results = new Map<string, TestCaseParseResult>();

  setResult(targetId: string, result: TestCaseParseResult): void {
    this.results.set(targetId, result);
  }

  getResult(targetId: string): TestCaseParseResult | undefined {
    return this.results.get(targetId);
  }

  clear(): void {
    this.results.clear();
  }
}
