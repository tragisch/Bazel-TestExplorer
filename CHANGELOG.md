# Change Log

All notable changes to the "bazel-unity-test" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added
- Implemented Bazel test discovery using `bazel query` to fetch `cc_test` targets.
- Integrated VS Code Test Explorer API for structured test results.
- Added support for executing multiple test targets in parallel.
- Introduced caching mechanism to avoid unnecessary Bazel queries.

### Changed
- Removed `--check_up_to_date` for more reliable test execution.
- Improved output formatting for test results in the "Testergebnisse" window.
- Enhanced error handling to distinguish between build failures and test failures.
- Optimized `executeBazelTest()` to directly capture and display Bazel test output.

### Fixed
- Resolved an issue where test items were not found in `testController.items.get(target)`.
- Fixed indentation problems in test output formatting.

## [0.1.0] - YYYY-MM-DD
### Initial Release
- First version of the extension with basic Bazel test integration.