# Releasing

All SDKs share one semantic version and are released from a signed `vX.Y.Z` tag. The release
workflow verifies and tests every SDK, publishes both npm packages and the NuGet package, and then
creates a GitHub Release containing clearly named JavaScript server, JavaScript web, Java, .NET, and
Unity artifacts with SHA-256 checksums:

- `baziness-sdk-js-server-X.Y.Z.tgz`
- `baziness-sdk-js-web-X.Y.Z.tgz`
- `baziness-sdk-java-X.Y.Z.jar`
- `baziness-sdk-dotnet-X.Y.Z.nupkg`
- `baziness-sdk-unity-X.Y.Z.tgz`

## One-time registry setup

### npm

1. Create or join the npm organization `baziness` and require two-factor authentication.
2. Sign in locally with `npm login` and publish each package once with `npm publish --access public`.
3. Immediately before the first automated version, configure GitHub Actions as the trusted
   publisher for both packages:

   ```bash
   npm trust github @baziness/server --file release.yml \
     --repo baziness-com/baziness-sdk --env release --allow-publish --yes
   npm trust github @baziness/web --file release.yml \
     --repo baziness-com/baziness-sdk --env release --allow-publish --yes
   ```

4. After the first successful OIDC release, require 2FA and disallow token-based publishing.

The first manual publish is necessary because npm trusted publishing is configured on an existing
package. Configure trust immediately before the next version: a new trust relationship expires if
it does not successfully publish within two days. The workflow is idempotent and skips a version
that was already published manually.

### NuGet

`Baziness.Server` is published with [Trusted Publishing](https://learn.microsoft.com/nuget/nuget-org/trusted-publishing):
no API key is stored, the workflow exchanges a GitHub OIDC token for a key that lasts an hour.

1. Sign in to nuget.org and, under your account, create an organization that will own the package.
2. Under your username, open **Trusted Publishing** and add a policy owned by that organization:

   | Field | Value |
   | --- | --- |
   | Repository Owner | `baziness-com` |
   | Repository | `baziness-sdk` |
   | Workflow File | `release.yml` |
   | Environment | `release` |

   Its scope must allow publishing new packages, so the first release can create `Baziness.Server`.
3. Add the repository secret `NUGET_USER`: the nuget.org username (profile name, not the email) of the
   account that made the policy.
4. Optionally, ask nuget.org to [reserve the prefix](https://learn.microsoft.com/nuget/nuget-org/id-prefix-reservation)
   `Baziness.`, which adds the verified check mark and stops anyone else publishing under it.

The workflow is idempotent and skips a version that is already on NuGet. A package published to NuGet
can be unlisted but not deleted.

### Java

`server-java/build.sh` compiles a dependency-free Java 8 JAR, runs its tests, and the release
workflow attaches the versioned JAR directly to the GitHub Release.

## Release

1. Update all the version declarations `scripts/check-versions.mjs` lists and the root changelog.
2. Run `node scripts/check-versions.mjs X.Y.Z` and `./scripts/test-all.sh`.
3. Merge the release commit into `main` and wait for CI.
4. Create and push a signed tag:

   ```bash
   git tag -s vX.Y.Z -m "Baziness SDK X.Y.Z"
   git push origin vX.Y.Z
   ```

5. Wait for the Release workflow. Do not reuse a published version after a partial failure; fix the
   problem and publish a patch version.
