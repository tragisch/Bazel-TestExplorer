# Bazel TestExplorer - VS Code Extension

A VS Code extension for managing Bazel-based tests, including **cc_test**.

It uses 'bazel query' to identify test-cases and 'bazel test' to perform them.

## Features
- **View tests** - in Test Explorer.
- **View test report** - in Test Results.
- **ShowMetadata** - show test-target attributes.
- **Filter for test tags** -  i.e. @smoke [tag]("https://bazel.build/reference/be/common-definitions#common.tags").
- **Customizable Test Types** – Configure additional test types like 'java_test', 'py_test', 'rust_test', ... .
- **New: Support of test_suites** - Collect all your tests in [test_suites](https://bazel.build/reference/be/general#test_suite) like "relase".
- **Bazel Test args** - Add test args to Bazel, i.e. --config=linux, ... .
- **Gutter Markers (Beta)** - Multiple failure locations supported.
- **Query Paths** - Optional set for relative Bazel paths (i.e. //tests) where tests should be queried (useful in Repos with submodules).

## Screenshot
![Example](images/Example_TestRun.png)

## Installation
1. Install the extension from the VS Code Marketplace.
2. Ensure Bazel is installed.

## Usage
1. Open the **Test Explorer** (`View` → `Testing`).
2. Run tests by clicking the play button next to a test.

## Roadmap
- **Code Coverage Integration**.
- **Debugging Support**.

## Tested with
- cc_test: boost.test, catch2, criterion, doctest, gtest, munit, ThrowTheSwitch, unittest_cpp
- py_test: doctest, pytest, unittest
- rust_test: build-in
- java_test: JUnit
- go_test: build-in
## License
MIT License
