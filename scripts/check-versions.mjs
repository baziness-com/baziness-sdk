#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const jsonVersion = async (path) => JSON.parse(await readFile(path, 'utf8')).version;
const extractVersion = async (path, pattern, label) => {
  const match = (await readFile(path, 'utf8')).match(pattern);
  if (!match) throw new Error(`Could not find ${label} in ${path}`);
  return match[1];
};

const versions = new Map([
  ['Node package', await jsonVersion('server-node/package.json')],
  ['Web package', await jsonVersion('web/package.json')],
  ['Java runtime', await extractVersion('server-java/src/main/java/com/baziness/server/BazinessServer.java', /SDK_VERSION\s*=\s*"([^"]+)"/, 'SDK_VERSION')],
  ['Unity package', await jsonVersion('unity/com.baziness.sdk/package.json')],
  ['Unity runtime', await extractVersion('unity/com.baziness.sdk/Runtime/Core/DeviceInfo.cs', /const string Version\s*=\s*"([^"]+)"/, 'Version')],
]);

const expected = versions.values().next().value;
const mismatches = [...versions].filter(([, version]) => version !== expected);
const requested = process.argv[2];

for (const [name, version] of versions) console.log(`${name}: ${version}`);

if (mismatches.length) {
  console.error(`SDK versions do not all match ${expected}.`);
  process.exitCode = 1;
} else if (requested && requested !== expected) {
  console.error(`Requested version ${requested} does not match SDK version ${expected}.`);
  process.exitCode = 1;
} else {
  console.log(`All SDK versions match ${expected}.`);
}
