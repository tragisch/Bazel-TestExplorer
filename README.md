# Bazel Unity Test - VS Code Extension

A Visual Studio Code extension for discovering, running, and managing Bazel-based tests, including **cc_test**, **java_test**, and other supported test types.

## Features
✅ **Customizable Test Types** – Configure additional test types (e.g., `java_test`, `py_test`) via VS Code settings.  

## Installation
1. Install the extension from the VS Code Marketplace (coming soon).
2. Ensure Bazel is installed and configured correctly.
3. Open a Bazel-based project in VS Code.

## Usage
1. Open the **Test Explorer** (`View` → `Testing`).
2. Click **"Show Bazel Tests"** to discover available test targets.
3. Run tests by clicking the play button next to a test or package.

## Configuration
You can customize test discovery and execution through VS Code settings:
- `bazelTestRunner.testTypes`: Define which Bazel test types should be recognized.
- `bazelTestRunner.parallelExecution`: Enable or disable parallel test execution.

## Roadmap & Future Enhancements
- 🔄 **Code Coverage Integration** (`bazel test --collect_code_coverage`)
- 🔍 **Debugging Support** for Bazel tests
- 🛠 **Improved Test Reporting & UI Enhancements**

## Contributing
Contributions are welcome! Open an issue or submit a PR to help improve the extension.

## License
MIT License – Feel free to modify and improve!

