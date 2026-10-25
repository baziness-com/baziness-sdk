# Releasing

All SDKs share one semantic version and are released from a signed `vX.Y.Z` tag. The release
workflow verifies and tests every SDK, publishes the npm and Maven packages, and then creates a
GitHub Release containing Node, Web, Java, and Unity artifacts with SHA-256 checksums.

## One-time registry setup

### npm

1. Create or join the npm organization `baziness` and require two-factor authentication.
2. Sign in locally with `npm login` and publish each package once with `npm publish --access public`.
3. In each package's npm settings, add a GitHub Actions trusted publisher:
   - Organization: `baziness-com`
   - Repository: `baziness-sdk`
   - Workflow: `release.yml`
   - Environment: `release`
   - Allowed action: `npm publish`
4. After one successful OIDC release, require 2FA and disallow token-based publishing.

The first manual publish is necessary because npm trusted publishing is configured on an existing
package. The workflow is idempotent and skips a version that was already published manually.

### Maven Central

1. Register and verify the `com.baziness` namespace in the Maven Central Portal.
2. Generate a dedicated, passphrase-protected GPG release key and publish its public key.
3. Generate a Central Portal user token.
4. Add these encrypted secrets to the GitHub `release` environment:
   - `MAVEN_CENTRAL_USERNAME`
   - `MAVEN_CENTRAL_PASSWORD`
   - `MAVEN_GPG_PRIVATE_KEY`
   - `MAVEN_GPG_PASSPHRASE`

Never commit or paste registry credentials, private keys, or passphrases into issues or logs.

## Release

1. Update all six version declarations and the root changelog.
2. Run `node scripts/check-versions.mjs X.Y.Z` and `./scripts/test-all.sh`.
3. Merge the release commit into `main` and wait for CI.
4. Create and push a signed tag:

   ```bash
   git tag -s vX.Y.Z -m "Baziness SDK X.Y.Z"
   git push origin vX.Y.Z
   ```

5. Wait for the Release workflow. Do not reuse a published version after a partial failure; fix the
   problem and publish a patch version.
