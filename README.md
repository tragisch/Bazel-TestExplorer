# Bazel TestExplorer

Test Explorer + Coverage for Bazel tests in VS Code.

Uses `bazel query`, `bazel test`, and `bazel coverage`, integrated with the VS Code Testing API.

## Features
- Show tests in the Testing view (query + run).
- CodeLens, gutter markers, diagnostics.
- Coverage reports in the Testing UI.
- Test Details panel (incl. Coverage tab).
- Advanced Bazel test settings.

## Installation
1. Install the extension from the VS Code Marketplace.
2. Ensure Bazel is installed.

## Usage
1. Open **Testing**.
2. Run tests or Coverage from the UI.

## Settings
- `bazelTestExplorer.testTypes` - e.g. `cc_test`, `rust_test`, `py_test`, `go_test`.
- `bazelTestExplorer.queryPaths` - `//...` or specific paths.
- `bazelTestExplorer.testArgs` - extra flags for `bazel test`.
- `bazelTestExplorer.coverageArgs` - extra flags for `bazel coverage`.

## Screenshot
![Example](images/Example_TestRun.png)

## Remarks
- `c++filt` / `rustfilt` should be available in `PATH` for demangled names in coverage.
- `--instrumentation_filter=.*` can be slow in large repositories. Adjust this filter in settings to match your source paths (e.g., `--instrumentation_filter="app/*"` or `--instrumentation_filter="//src/..."`).
- `--combined_report=lcov` creates a central `bazel-out/_coverage/_coverage_report.dat` for easier coverage aggregation. If this file is empty, check that your instrumentation filter matches your source files.
- The extension prioritizes `coverage.dat` over `baseline_coverage.dat` (which is often empty).
- Experimental test.xml parsing can be slow or incompatible with some frameworks.

## License
MIT License
