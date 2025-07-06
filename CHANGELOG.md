# Change Log

All notable changes to the "bazel-unity-test" extension will be documented here.

## [0.1.12]
- fix issues in gutter annotations
- add Filter for test-tags, i.e. @smoke, @release, ...

## [0.1.1 - 0.1.11]

### Added
- Bazel test args for settings, i.e. '--config=linux'
- Automatic detection of Workspace file.
- Meta-Data for test types, i.e. 'rust_test', 'py_test', ..
- Multiple test failure locations with gutter annotations (Beta).
- Support for custom failure patterns via `settings.json`.
- Bazel test discovery via `bazel query` for `cc_test` and other test types.

## [0.1.0]
### Initial Release
- Basic Bazel test integration.