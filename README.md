# Bazel TestExplorer - VS Code Extension

A VS Code extension for managing Bazel-based tests, including **cc_test**.

It uses 'bazel query' to identify test-cases and 'bazel test' to perform them.

## Features
- **View tests** - in Test Explorer.
- **View test report** - in Test Results.
- **Customizable Test Types** – Configure additional test types like 'java_test', 'py_test', ... .
- **Gutter Markers (Beta)** - Multiple failure locations supported.
- **Query Paths** - Optional set for relative Bazel paths (i.e. //tests) where tests should be queried (useful in Repos with submodules).

## Installation
1. Install the extension from the VS Code Marketplace.
2. Ensure Bazel is installed.

## Usage
1. Open the **Test Explorer** (`View` → `Testing`).
2. Run tests by clicking the play button next to a test.

## Roadmap
- **Code Coverage Integration**.
- **Debugging Support**.

## License
MIT License
