#!/usr/bin/env bash
# Builds and runs the Unity package's core tests (needs the .NET 8 SDK and Node 18+ for the fake hub).
set -euo pipefail
cd "$(dirname "$0")"
export MSBUILDDISABLENODEREUSE=1 DOTNET_CLI_TELEMETRY_OPTOUT=1
dotnet build -c Release -nodeReuse:false -nologo -v q
dotnet bin/Release/net8.0/Baziness.Core.Tests.dll
