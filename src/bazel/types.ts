/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

export interface BazelTestTarget {
    target: string;
    type: string;
    location?: string;
    tags?: string[];
    srcs?: string[];
    timeout?: string;
    size?: string;
    flaky?: boolean;
    toolchain?: string;
    deps?: string[];
    visibility?: string[];
}