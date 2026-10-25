#!/usr/bin/env bash
# Builds the Java 8 jar and runs the tests against the shared fake hub (needs Node 18+ for it).
#   ./build.sh          → out/baziness-server-<version>.jar, tests
#   ./build.sh --no-test
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(grep -o 'SDK_VERSION = "[^"]*"' src/main/java/com/baziness/server/BazinessServer.java | cut -d'"' -f2)

rm -rf out && mkdir -p out/classes out/test-classes
javac --release 8 -Xlint:all,-options -Werror -d out/classes $(find src/main/java -name '*.java')
jar --create --file "out/baziness-server-$VERSION.jar" -C out/classes .
echo "built out/baziness-server-$VERSION.jar"

if [[ "${1:-}" != "--no-test" ]]; then
  # Tests use Java 8 lambdas only; compiled against the classes above.
  javac --release 8 -Xlint:all,-options -cp out/classes -d out/test-classes $(find src/test/java -name '*.java')
  java -cp out/classes:out/test-classes com.baziness.server.BazinessServerTest
fi
