# Contributing

Thank you for helping improve the Baziness SDKs.

## Development

Requirements:

- Node.js 18.17 or newer
- JDK 17 or newer (the Java SDK targets Java 8)
- .NET SDK 8 for the Unity core tests

Run the complete verification suite from the repository root:

```bash
./scripts/test-all.sh
```

Keep the public API and behavior consistent across the Node, Java, Web, and Unity implementations.
Add or update tests for behavior changes and update the relevant README.

## Pull requests

1. Open a focused pull request against `main`.
2. Explain the motivation and any compatibility impact.
3. Add a changelog entry for user-visible changes.
4. Ensure all CI checks pass.

By submitting a contribution, you agree that it is licensed under the Apache License 2.0.
