import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	// Temporarily exclude a problematic test bundle that causes Mocha globals
	// to be unavailable when loaded early by the extension host.
	files: [
		'out/test/**/*.test.js',
		'!out/test/suites/discovery.cache.test.js'
	],
});
