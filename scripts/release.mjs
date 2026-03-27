#!/usr/bin/env node
// Release helper: builds server, bundles Node runtime for target OS/ARCH, and creates tarball + sha256
// Expected env:
//   TARGET_OS: darwin | linux
//   TARGET_ARCH: arm64 | x64
//   NODE_VERSION: default 22.18.0
//   PUBLISH_MODE: 'artifacts-only' (we only emit files)
//   METADATA_PATH: path to write a small json with metadata

import { execSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync, cpSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TARGET_OS = process.env.TARGET_OS || process.platform;
const TARGET_ARCH = process.env.TARGET_ARCH || process.arch;
const NODE_VERSION = process.env.NODE_VERSION || '22.18.0';
const METADATA_PATH = process.env.METADATA_PATH || '';

function log(msg) {
  console.log(`[release] ${msg}`);
}

function run(cmd, opts = {}) {
  log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', shell: '/bin/bash', ...opts });
}

function mapNodeKey(os, arch) {
  if (os === 'darwin') {
    if (arch === 'arm64') return 'darwin-arm64';
    if (arch === 'x64') return 'darwin-x64';
  }
  if (os === 'linux') {
    if (arch === 'x64') return 'linux-x64';
    if (arch === 'arm64') return 'linux-arm64';
  }
  throw new Error(`Unsupported TARGET_OS/TARGET_ARCH: ${os}/${arch}`);
}

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

async function main() {
  const key = mapNodeKey(TARGET_OS, TARGET_ARCH);
  const outName = `pocket-server-${TARGET_OS}-${TARGET_ARCH}.tar.gz`;
  const shaName = `${outName}.sha256`;
  const cwd = process.cwd();

  // Clean prior outputs
  try { rmSync(outName); } catch {}
  try { rmSync(shaName); } catch {}

  // 1) Build server (esbuild bundles to dist/)
  run('npm run build');

  // 2) Prepare staging
  const staging = path.resolve(cwd, `.staging-${TARGET_OS}-${TARGET_ARCH}`);
  const appDir = path.join(staging, 'app');
  ensureDir(path.join(staging, 'bin'));
  ensureDir(path.join(appDir, 'dist'));

  // Copy dist → app/dist
  run(`cp -R dist/* "${path.join(appDir, 'dist')}"/`);
  // Copy package.json (to preserve ESM type and metadata)
  run(`cp package.json "${path.join(appDir, 'package.json')}"`);
  // Copy node_modules (needed because dist is bundled with external packages)
  if (existsSync('node_modules')) {
    log('Copying node_modules into app (this may take a while)...');
    cpSync('node_modules', path.join(appDir, 'node_modules'), { recursive: true });
  }

  // 3) Bundle Node runtime into bin/node for the target
  const nodeUrl = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${key}.tar.xz`;
  const tmpBase = path.join(tmpdir(), `pocket-release-${Date.now()}`);
  ensureDir(tmpBase);
  const nodeTgz = path.join(tmpBase, `node-${NODE_VERSION}-${key}.tar.xz`);
  log(`Downloading Node ${NODE_VERSION} for ${key} ...`);
  run(`curl -fsSL "${nodeUrl}" -o "${nodeTgz}"`);
  const nodeExtract = path.join(tmpBase, 'node');
  ensureDir(nodeExtract);
  // Extract and copy bin/node
  run(`tar -xJf "${nodeTgz}" -C "${nodeExtract}" --strip-components=1`);
  run(`cp "${path.join(nodeExtract, 'bin/node')}" "${path.join(staging, 'bin/node')}" && chmod +x "${path.join(staging, 'bin/node')}"`);

  // 4) Create tar.gz at repo root
  log('Creating tarball ...');
  run(`tar -czf "${outName}" -C "${staging}" .`);

  // 5) Write sha256
  try {
    run(`shasum -a 256 "${outName}" | awk '{print $1}' > "${shaName}"`);
  } catch {
    // Linux runners have sha256sum; mac has shasum
    run(`sha256sum "${outName}" | awk '{print $1}' > "${shaName}"`);
  }

  // 6) Metadata
  if (METADATA_PATH) {
    const sizeBytes = statSync(outName).size;
    const meta = {
      os: TARGET_OS,
      arch: TARGET_ARCH,
      node: NODE_VERSION,
      artifact: outName,
      sha256File: shaName,
      sizeBytes,
      createdAt: new Date().toISOString(),
    };
    ensureDir(path.dirname(METADATA_PATH));
    writeFileSync(METADATA_PATH, JSON.stringify(meta, null, 2));
    log(`Metadata written: ${METADATA_PATH}`);
  }

  log(`Done. Artifacts: ${outName}, ${shaName}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


