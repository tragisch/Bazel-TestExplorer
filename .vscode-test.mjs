import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: [
		'out/test/**/*.test.js',
	],
	env: {
		// Ensure VS Code starts as desktop app (not Electron-as-Node) in nested host environments.
		ELECTRON_RUN_AS_NODE: undefined,
		// Remove inherited VS Code host wiring that can interfere with child Extension Host startup.
		VSCODE_IPC_HOOK: undefined,
		VSCODE_NLS_CONFIG: undefined,
		VSCODE_CODE_CACHE_PATH: undefined,
		VSCODE_PID: undefined,
		VSCODE_CWD: undefined,
		VSCODE_HANDLES_UNCAUGHT_ERRORS: undefined,
		VSCODE_ESM_ENTRYPOINT: undefined,
		VSCODE_CRASH_REPORTER_PROCESS_TYPE: undefined,
	},
});
