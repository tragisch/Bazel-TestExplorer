# Change Log

All notable changes to the "bazel-unity-test" extension will be documented here.

## [Unreleased]

### Added
- **Coverage Integration**: Bazel coverage runs via Testing UI, Coverage tab in Test Details
- **Coverage Artifacts**: LCOV/LLVM detection with fallback to llvm-cov export
- **Cancel All Runs**: Stop all running Bazel processes from Testing view
- **Coverage Filters**: Default `--instrumentation_filter=.*` and configurable coverage args


## [0.1.14]
- Implement extension bundling with esbuild
- Reduce VSIX size by 50% (1.64 MB → 812 KB)
- Add support for VS Code Web (vscode.dev, github.dev)
- Add tests 
- Refactoring

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
