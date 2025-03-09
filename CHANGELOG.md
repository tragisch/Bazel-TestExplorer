# Change Log

All notable changes to the "bazel-unity-test" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added
- Implemented Bazel test discovery using `bazel query` to fetch `cc_test` targets.
- Integrated VS Code Test Explorer API for structured test results.
- Added support for executing multiple test targets in parallel.
- Introduced caching mechanism to avoid unnecessary Bazel queries.
- Added support for configurable test types in `settings.json`.
- Implemented multiple test type (cc_test, java_test, pj_test, ...) detection using `bazel query union`.
- Introduced support for filtering test targets based on configurable prefixes.

### Changed
- Removed `--check_up_to_date` for more reliable test execution.
- Improved output formatting for test results in the "Testergebnisse" window.
- Enhanced error handling to distinguish between build failures and test failures.
- Optimized `executeBazelTest()` to directly capture and display Bazel test output.
- Improved test execution logic to support parallel execution for grouped tests.
- Refactored test output handling to provide a cleaner, more structured display.
- Enhanced Test Explorer visualization by structuring tests into groups.

### Fixed
- Resolved an issue where test items were not found in `testController.items.get(target)`.
- Fixed indentation problems in test output formatting.
- Fixed an issue where cached test results were not correctly applied.
- Resolved indentation issues in test logs when displayed in the "Testresult" window.

## [0.1.0] - YYYY-MM-DD
### Initial Release
- First version of the extension with basic Bazel test integration.