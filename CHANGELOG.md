# Change Log

All notable changes to the "bazel-unity-test" extension will be documented here.

## [Unreleased]

## [0.1.16] - 2025-12-23
- Coverage Integration: Bazel coverage runs via Testing UI with Coverage tab in Test Details
- Coverage Artifacts: LCOV/LLVM detection with fallback to llvm-cov export
- Coverage Filters: Default `--instrumentation_filter=.*` 
- Cancel All Runs: Stop all running Bazel processes from Testing view
- Refactoring: Restructured codebase into layered architecture

## [0.1.15] - not published
- Test Settings Webview: Interactive settings panel for advanced Bazel configuration
- Test Case Discovery: XML-based test case extraction (Experimental)
- Test Case Annotations: Gutter decorations and diagnostics for test failure locations
- Flaky Test Support: Detect and display flaky test attributes
- Manual Tag Filtering: Filter tests by custom tags via search field
- Shard Configuration: Support for Bazel test sharding
- Combined Info Panels: Unified test details and insights view
- Test Observer: Experimental test tree observation (Beta)

## [0.1.14] - not published
- Implement extension bundling with esbuild
- Reduce VSIX size by 50% (1.64 MB → 812 KB)
- Add support for VS Code Web (vscode.dev, github.dev)
- Add tests 
- Refactoring
- Use of Copilot

## [0.1.13]
- fix issues.
- add support for test_suites

## [0.1.1 - 0.1.12]

### Added
- Add Filter for test-tags, i.e. @smoke, @release, ...
- Bazel test args for settings, i.e. '--config=linux'
- Automatic detection of Workspace file.
- Meta-Data for test types, i.e. 'rust_test', 'py_test', ..
- Multiple test failure locations with gutter annotations (Beta).
- Support for custom failure patterns via `settings.json`.
- Bazel test discovery via `bazel query` for `cc_test` and other test types.

## [0.1.0]
### Initial Release
- Basic Bazel test integration.
