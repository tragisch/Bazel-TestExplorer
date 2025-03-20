# Change Log

All notable changes to the "bazel-unity-test" extension will be documented here.

## [0.1.6]

### Fixed
- Add '--output=label_kind' to query.


## [0.1.5]

### Fixed
- Add forgotten 'union' to join different //bazel paths queries.

## [0.1.4]

### Added
- Add '--keep_going' in bazel queries as an option in settings.
- Allow to specify specific folders to look for bazel tests.

## [0.1.3]

### Added
- Bazel test discovery via `bazel query` for `cc_test` and other test types.
- VS Code Test Explorer API integration.
- Parallel test execution and caching to reduce redundant queries.
- Configurable test types in `settings.json`.

### Changed
- Removed `--check_up_to_date` for better reliability.
- Improved test result formatting and error handling.
- Optimized `executeBazelTest()` and structured test display.

### Fixed
- Resolved issues with test discovery, indentation, and cached results.

## [0.1.0]
### Initial Release
- Basic Bazel test integration.