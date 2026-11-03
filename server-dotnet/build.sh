#!/usr/bin/env bash
# Runs the tests against the shared fake hub and builds the NuGet package (needs the .NET 8 SDK, and Node 18+ for the fake hub).
#   ./build.sh          → tests, out/Baziness.Server.<version>.nupkg
#   ./build.sh --no-test
set -euo pipefail
cd "$(dirname "$0")"
export MSBUILDDISABLENODEREUSE=1 DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1

if [[ "${1:-}" != "--no-test" ]]; then
  dotnet test test/Baziness.Server.Tests -c Release -nodeReuse:false
fi

rm -rf out
dotnet pack src/Baziness.Server -c Release -o out -nodeReuse:false -p:ContinuousIntegrationBuild=true
echo "built $(ls out/*.nupkg)"
