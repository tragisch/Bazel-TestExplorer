# Test Pattern Configuration

This document explains how to configure test case patterns for the Bazel Test Explorer extension.

## Built-in Patterns

The extension comes with built-in patterns for popular test frameworks:

- **Unity C Framework**: Standard C unit testing framework
- **Google Test (C++)**: C++ testing framework
- **PyTest (Python)**: Python testing framework
- **Go Test**: Go testing framework
- **Rust Test**: Rust testing framework
- **JUnit (Java)**: Java testing framework

## Custom Patterns

You can add your own test patterns via VS Code settings to support additional test frameworks.

### Configuration

Add custom patterns to your VS Code `settings.json`:

```json
{
  "bazelTestRunner.customTestPatterns": [
    {
      "id": "my_custom_framework",
      "framework": "My Custom Test Framework",
      "pattern": "^(.+?):(\\d+):(.+?):(PASS|FAIL|SKIP)(?::\\s*(.+))?$",
      "groups": {
        "file": 1,
        "line": 2,
        "testName": 3,
        "status": 4,
        "message": 5
      },
      "description": "Custom test framework output format",
      "example": "tests/my_test.c:42:test_function_name:PASS"
    }
  ]
}
```

### Pattern Structure

Each pattern must have the following properties:

- **`id`**: Unique identifier for the pattern
- **`framework`**: Human-readable name of the test framework
- **`pattern`**: Regular expression string (will be converted to RegExp)
- **`groups`**: Object specifying which capture groups contain which information
  - `file`: Capture group index for file path (0 if not available)
  - `line`: Capture group index for line number (0 if not available)
  - `testName`: Capture group index for test case name
  - `status`: Capture group index for test status
  - `message`: (Optional) Capture group index for error message
- **`description`**: Description of what this pattern matches
- **`example`**: Example line this pattern would match

### Status Mapping

The following status strings are automatically normalized:

| Framework Status | Normalized Status |
|------------------|-------------------|
| PASS, PASSED, ok | PASS             |
| FAIL, FAILED, ERROR | FAIL          |
| SKIP, SKIPPED, ignored | SKIP        |
| TIMEOUT          | TIMEOUT          |
| RUN              | SKIP             |

Unknown statuses default to `FAIL`.

## Examples

### Custom C++ Framework

```json
{
  "id": "my_cpp_framework",
  "framework": "My C++ Framework",
  "pattern": "^\\[(.+?)\\]\\s+(\\w+)\\s+(.+?)\\s+\\((\\d+)ms\\)$",
  "groups": {
    "file": 0,
    "line": 0,
    "testName": 3,
    "status": 2,
    "message": 0
  },
  "description": "Custom C++ test output",
  "example": "[PASSED] MyTest test_function (15ms)"
}
```

### Custom Python Framework

```json
{
  "id": "my_python_framework",
  "framework": "My Python Framework",
  "pattern": "^(.+?)\\s+(\\w+)\\s+in\\s+(.+?):(\\d+)(?:\\s+(.+))?$",
  "groups": {
    "file": 3,
    "line": 4,
    "testName": 1,
    "status": 2,
    "message": 5
  },
  "description": "Custom Python test output",
  "example": "test_my_function PASSED in my_test.py:25"
}
```

## Debugging

When the extension parses test output, it logs which pattern was used for each test case. Check the VS Code Output panel (select "Bazel Test Explorer") to see:

```
Matched test case "test_my_function" using pattern: My Custom Framework (my_custom_framework)
```

This helps you verify that your custom patterns are working correctly.

## Priority

Patterns are tried in order and the first match wins. If multiple patterns match the same line, the one with the longest match is preferred.

Built-in patterns are tried first, followed by custom patterns in the order they appear in your settings.
