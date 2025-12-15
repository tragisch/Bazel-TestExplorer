/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import { initializeLogger } from '../logging';

// Initialize logger before running tests
export function mochaGlobalSetup() {
    initializeLogger();
}
