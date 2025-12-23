/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/// <reference types="mocha" />
import * as assert from 'assert';
import { demangleSymbols } from '../../coverage';

suite('Demangler', () => {
	test('returns original symbols when tool is missing', async () => {
		const symbols = ['_Z3foov', '_ZN3Foo3barEv'];
		const result = await demangleSymbols(symbols, 'cpp', '/missing/c++filt');
		assert.deepStrictEqual(result, symbols);
	});
});
