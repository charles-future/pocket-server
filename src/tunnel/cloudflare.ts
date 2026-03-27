import { spawn } from 'child_process';
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../shared/logger';
import { getPublicBaseUrl as getCurrentPublicUrl, setPublicBaseUrl } from '../shared/public-url';

const HOME = process.env.HOME || process.cwd();
const BIN_DIR = join(HOME, '.pocket-server', 'cloudflared', '1.10.0');
const BIN_PATH = join(BIN_DIR, 'cloudflared');

function detectArch(): 'amd64' | 'arm64' {
  const arch = process.arch;
  if (arch === 'arm64') return 'arm64';
  return 'amd64';
}

function detectOS(): 'darwin' | 'linux' {
  if (process.platform === 'darwin') return 'darwin';
  // Default to linux for non-darwin POSIX platforms
  return 'linux';
}

function getDownloadUrl(): string {
  const arch = detectArch();
  const os = detectOS();
  // Official release tgz with latest tag
  return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${os}-${arch}.tgz`;
}

async function fetchBinary(): Promise<string> {
  if (existsSync(BIN_PATH)) return BIN_PATH;
  mkdirSync(BIN_DIR, { recursive: true });
  const url = getDownloadUrl();

  logger.info('Tunnel', `Downloading cloudflared tgz`);
  const res = await fetch(url, { headers: { 'User-Agent': 'pocket-server/1.0' } });
  if (!res.ok) throw new Error(`Failed to download cloudflared: HTTP ${res.status}`);
  const tgzPath = join(BIN_DIR, 'cloudflared.tgz');
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(tgzPath, buf);
  await extractTgz(tgzPath, BIN_DIR);
  try { unlinkSync(tgzPath); } catch {}
  try { chmodSync(BIN_PATH, 0o755); } catch {}
  if (!existsSync(BIN_PATH)) throw new Error('cloudflared binary not found after extract');
  return BIN_PATH;
}

async function extractTgz(tgzPath: string, destDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tar = spawn('tar', ['-xzf', tgzPath, '-C', destDir]);
    tar.on('exit', (code) => {
      if (code === 0) {
        // The archive usually contains a file named 'cloudflared'
        resolve();
      } else {
        reject(new Error(`tar exit code ${code}`));
      }
    });
    tar.on('error', reject);
  });
}

export interface TunnelProcess {
  process: ReturnType<typeof spawn>;
  urlPromise: Promise<string>;
}

export async function startQuickTunnel(port: number): Promise<TunnelProcess> {
  const bin = await fetchBinary();
  // Default to 'info' so cloudflared prints the assigned public URL
  const logLevel = process.env.CF_TUNNEL_LOGLEVEL || 'info';
  const VERBOSE = (process.env.CF_TUNNEL_VERBOSE === '1' || process.env.CF_TUNNEL_VERBOSE === 'true');
  const args = ['tunnel', '--no-autoupdate', '--loglevel', logLevel, '--url', `http://localhost:${port}`];
  logger.info('Tunnel', 'Starting quick tunnel', { args: args.join(' ') });

  const child = spawn(bin, args, { env: process.env });

  let urlResolve: (url: string) => void;
  let urlReject: (err: any) => void;
  const urlPromise = new Promise<string>((resolve, reject) => { urlResolve = resolve; urlReject = reject; });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const onLine = (line: string) => {
    // Only accept the first URL we see per process
    const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) {
      const url = match[0];
      const current = getCurrentPublicUrl();
      if (!current) {
        setPublicBaseUrl(url);
        logger.info('Tunnel', 'public_url_assigned', { url });
        urlResolve!(url);
      }
    }
  };

  child.stdout.on('data', (d: Buffer | string) => {
    const s = d.toString();
    s.split('\n').forEach((ln: string) => {
      const line = ln.trim();
      if (!line) return;
      if (VERBOSE) logger.info('Tunnel', line);
      onLine(line);
    });
  });
  child.stderr.on('data', (d: Buffer | string) => {
    const s = d.toString();
    s.split('\n').forEach((ln: string) => {
      const line = ln.trim();
      if (!line) return;
      if (VERBOSE) logger.info('Tunnel', line);
      onLine(line);
    });
  });

  child.on('exit', (code) => {
    logger.warn('Tunnel', `cloudflared exited with code ${code}`);
    setPublicBaseUrl(null);
    urlReject!(new Error('cloudflared exited'));
  });

  return { process: child, urlPromise };
}


