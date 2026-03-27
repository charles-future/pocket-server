#!/usr/bin/env node
import { spawn } from 'child_process';
import { existsSync, readFileSync, readlinkSync, realpathSync, unlinkSync, writeFileSync } from 'fs';
import fuzzysort from 'fuzzysort';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';
import { startPairingWindow } from './auth/pairing';
import { logger } from './shared/logger';
import { resolveDataPath } from './shared/paths';
import { getPublicBaseUrl, setPublicBaseUrl } from './shared/public-url';
import { createHelpDisplay, createPairingDisplay, status } from './shared/terminal-ui';
import { startQuickTunnel } from './tunnel/cloudflare';

const DEFAULT_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

function printHelp(): void {
  console.log(createHelpDisplay());
}

function parseArgs(argv: string[]): { cmd: string; subcmd?: string; flags: Record<string, string | boolean>; } {
  const out: Record<string, string | boolean> = {};
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'start';
  let subcmd: string | undefined;
  const rest = argv[0] === cmd ? argv.slice(1) : argv.slice(0);
  let skipIndex: number | null = null;
  if (cmd === 'terminal' && rest.length > 0 && !rest[0].startsWith('-')) {
    const candidate = rest[0];
    if (candidate === 'sessions' || candidate === 'attach' || candidate === 'select') {
      subcmd = candidate;
      // Optional positional query after subcmd (e.g., terminal attach opencode)
      if (rest[1] && !rest[1].startsWith('-')) {
        out.query = rest[1];
        skipIndex = 1;
      }
    } else {
      // Treat as positional query (e.g., terminal opencode)
      out.query = candidate;
      skipIndex = 0;
    }
  }
  for (let i = 0; i < rest.length; i++) {
    if (i === 0 && subcmd) continue; // skip the subcommand token
    if (skipIndex !== null && i === skipIndex) continue; // skip the positional query token
    const a = rest[i];
    if (a === '--') break;
    if (a.startsWith('--')) {
      const [rawK, rawV] = a.slice(2).split('=');
      const k = rawK.trim();
      if (rawV !== undefined) {
        out[k] = rawV;
      } else {
        // generic support space-separated values: --key value
        const next = rest[i + 1];
        if (next && !next.startsWith('-')) {
          out[k] = next;
          i++;
        } else {
          out[k] = true;
        }
      }
      continue;
    }
    if (a.startsWith('-')) {
      if (a === '-r') {
        out.remote = true;
        continue;
      }
      if (a === '-h') {
        out.help = true;
        continue;
      }
      if (a.startsWith('-p=')) {
        out.port = a.split('=')[1];
        continue;
      }
      if (a === '-p') {
        const next = rest[i + 1];
        if (next && !next.startsWith('-')) {
          out.port = next;
          i++;
        }
      }
    }
  }
  return { cmd, subcmd, flags: out };
}

async function startServer(port: number, enableTunnel: boolean): Promise<void> {
  // Clear any stale cached public URL before starting a new tunnel
  setPublicBaseUrl(null);
  // Ensure server reads the desired port
  process.env.PORT = String(port);
  console.log(status.starting(port, enableTunnel));
  // Start server by importing index (side-effect)
  await import('./index.js');
  // Write PID
  try {
    const pidPath = resolveDataPath('runtime', 'server.pid');
    writeFileSync(pidPath, String(process.pid), 'utf8');
    process.on('exit', () => { try { unlinkSync(pidPath); } catch {} });
    process.on('SIGINT', () => { try { unlinkSync(pidPath); } catch {}; process.exit(0); });
  } catch {}
  // Optionally start Cloudflare quick tunnel
  if (enableTunnel) {
    try {
      const t = await startQuickTunnel(port);
      let printed = false;
      const maybePrint = () => {
        const found = getPublicBaseUrl();
        if (found && !printed) {
          logger.info('Tunnel', 'public_url_ready', { url: found });
          console.log(status.tunnelReady(found));
          printed = true;
          clearInterval(timer);
        }
      };
      const timer = setInterval(maybePrint, 1000);
      t.urlPromise.then((u) => { setPublicBaseUrl(u); maybePrint(); }).catch(() => {});
    } catch (e) {
      console.log(status.tunnelFailed((e as Error).message));
      setPublicBaseUrl(null);
    }
  }
}

function normalizeVersion(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.replace(/^v/i, '').trim();
}

function getInstallHome(): string {
  try {
    return path.join(os.homedir(), '.pocket-server');
  } catch {
    return path.join(process.cwd(), '.pocket-server');
  }
}

function getCurrentInstalledVersion(): string | null {
  try {
    const home = getInstallHome();
    const currentLink = path.join(home, 'current');
    // Prefer symlink target name (e.g., .../releases/vX.Y.Z)
    try {
      const linkTarget = readlinkSync(currentLink);
      const base = path.basename(linkTarget);
      const norm = normalizeVersion(base);
      if (norm) return norm;
    } catch {
      // Not a symlink or cannot read; fall through
    }
    // Resolve real path and check tail directory name
    try {
      const real = realpathSync(currentLink);
      const base = path.basename(real);
      const norm = normalizeVersion(base);
      if (norm) return norm;
    } catch {}
    // Fallback: read package.json version in current/app
    try {
      const pkgPath = path.join(currentLink, 'app', 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
      const norm = normalizeVersion(pkg?.version);
      if (norm) return norm;
    } catch {}
  } catch {}
  return null;
}

async function fetchLatestVersionFromInstaller(installerUrl: string): Promise<string | null> {
  try {
    const res = await fetch(installerUrl, { cache: 'no-store' });
    if (!res.ok) return null;
    const text = await res.text();
    const m = text.match(/\nVERSION="([^"]+)"/);
    const raw = (m && m[1]) ? m[1] : null;
    const norm = normalizeVersion(raw);
    return norm;
  } catch {
    return null;
  }
}

async function maybeAutoUpdateBeforeStart(flags: Record<string, string | boolean>): Promise<boolean> {
  // Allow opt-out
  if ((flags as any)['no-auto-update']) return false;
  const currentVersion = getCurrentInstalledVersion();
  // If not installed (dev mode), skip
  if (!currentVersion) return false;
  const installerUrl = process.env.POCKET_INSTALL_URL || 'https://www.pocket-agent.xyz/install';
  const latest = await fetchLatestVersionFromInstaller(installerUrl);
  if (!latest) return false;
  if (latest === currentVersion) return false;

  // Build start args to preserve user's intent
  const startArgs: string[] = [];
  if (typeof flags.port === 'string' && flags.port) {
    startArgs.push('--port', String(flags.port));
  }
  if (flags.remote) {
    startArgs.push('--remote');
  }

  // Run installer with start args so the updated server starts immediately
  const env = { ...process.env, POCKET_SERVER_START_ARGS: startArgs.join(' ') };
  console.log(status.updating());
  const sh = spawn('/bin/bash', ['-lc', `curl -fsSL ${installerUrl} | bash`], { stdio: 'inherit', env });
  await new Promise<void>((resolve, reject) => {
    sh.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Installer exited with code ${code}`)));
    sh.on('error', reject);
  });
  // We initiated an update which already starts the server; do not continue here
  return true;
}

async function cmdStart(flags: Record<string, string | boolean>): Promise<void> {
  const port = flags.port ? Number(flags.port) : DEFAULT_PORT;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${flags.port}`);
    process.exit(2);
  }
  const enableTunnel = Boolean(flags.remote);
  // Auto-update before starting, if applicable
  const updated = await maybeAutoUpdateBeforeStart(flags);
  if (updated) return;
  await startServer(port, enableTunnel);
}

async function cmdPair(flags: Record<string, string | boolean>): Promise<void> {
  const port = flags.port ? Number(flags.port) : DEFAULT_PORT;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${flags.port}`);
    process.exit(2);
  }
  // If user passes --remote here, we do not automatically start tunnel,
  // but we will indicate remote pairing mode and print public URL if available.
  const remotePair = Boolean(flags.remote);
  await startServer(port, false);
  const pinArg = typeof flags.pin === 'string' ? String(flags.pin) : undefined;
  const durationMs = typeof flags.duration === 'string' ? Math.max(10_000, Number(flags.duration)) : 60_000;
  const { pin, expiresAt, pairToken, mode } = startPairingWindow(durationMs, pinArg, remotePair);
  const nets = os.networkInterfaces();
  const urls: string[] = [];
  Object.values(nets).forEach(ifaces => {
    ifaces?.forEach(addr => {
      if ((addr as any).family === 'IPv4' && !(addr as any).internal) {
        urls.push(`http://${(addr as any).address}:${port}`);
      }
    });
  });
  const expiresInSec = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  const pub = getPublicBaseUrl();
  
  // Build pairing display with remote info if applicable
  const baseDisplay = createPairingDisplay(pin, expiresInSec, urls, remotePair || !!pub);
  const remoteLines: string[] = [];
  if (remotePair) {
    remoteLines.push('');
    remoteLines.push('Remote pairing mode enabled:');
    if (pub) {
      remoteLines.push(`  Public URL: ${pub}`);
    } else {
      remoteLines.push(`  Public URL: (start with --remote to enable tunnel)`);
    }
    if (pairToken) {
      remoteLines.push(`  Pairing Token: ${pairToken}`);
    }
    remoteLines.push('');
    remoteLines.push('Use URL + PIN + Token in the mobile app to pair remotely.');
  }
  console.log(`\n${baseDisplay}${remoteLines.length ? '\n' + remoteLines.join('\n') : ''}\n`);
}

async function cmdStop(): Promise<void> {
  const pidPath = resolveDataPath('runtime', 'server.pid');
  if (!existsSync(pidPath)) {
    console.log(status.notRunning());
    return;
  }
  try {
    const pid = Number(readFileSync(pidPath, 'utf8'));
    process.kill(pid, 'SIGINT');
    console.log(status.stopping());
    try { unlinkSync(pidPath); } catch {}
  } catch (e) {
    console.error('Failed to stop server:', (e as Error).message);
  }
}

async function cmdUpdate(): Promise<void> {
  // Delegate to installer script hosted on the website
  const installerUrl = process.env.POCKET_INSTALL_URL || 'https://www.pocket-agent.xyz/install';
  console.log(status.updating());
  const sh = spawn('/bin/bash', ['-lc', `curl -fsSL ${installerUrl} | bash`], { stdio: 'inherit' });
  await new Promise<void>((resolve, reject) => {
    sh.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Installer exited with code ${code}`)));
    sh.on('error', reject);
  });
}

async function cmdTerminal(flags: Record<string, string | boolean>, subcmd?: string): Promise<void> {
  const action = subcmd || (hasAnySelectorFlag(flags) ? 'select' : 'sessions');
  switch (action) {
    case 'sessions': {
      const path = resolveDataPath('runtime', 'term-sessions.json');
      if (!existsSync(path)) {
        console.log('No active terminal sessions.');
        return;
      }
      try {
        const raw = readFileSync(path, 'utf8');
        const data = JSON.parse(raw) as { sessions?: Array<TerminalRegistryItem>; updatedAt?: number };
        let sessions = Array.isArray(data.sessions) ? data.sessions.slice() : [];
        const sortKey = typeof flags.sort === 'string' ? String(flags.sort) : 'smart';
        sessions = sortSessions(sessions, sortKey);
        if (flags.json) {
          // include 1-based index in JSON
          const enriched = sessions.map((s, i) => ({ index: i + 1, ...s }));
          console.log(JSON.stringify({ sessions: enriched }, null, 2));
          return;
        }
        if (sessions.length === 0) {
          console.log('No active terminal sessions.');
          return;
        }
        const long = Boolean(flags.long);
        const lines: string[] = [];
        sessions.forEach((s, idx) => {
          lines.push(formatSessionLine(s, idx + 1, long));
        });
        console.log(lines.join('\n'));
      } catch (e) {
        console.error('Failed to read terminal sessions:', (e as Error).message);
      }
      return;
    }
    case 'select':
    case 'attach': {
      // Selection flow: try by index/name/id/positional
      const selected = await selectSession(flags);
      if (!selected) return;
      const port = flags.port ? Number(flags.port) : DEFAULT_PORT;
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        console.error(`Invalid port: ${flags.port}`);
        return;
      }
      await attachToSession(selected.session.id, selected.session.title || deriveTitleFromId(selected.session.id), port);
      return;
    }
    default:
      console.log(status.unknownCommand(`terminal ${action}`));
  }
}

function deriveTitleFromId(id: string): string {
  const m = id.match(/#(\d+)$/);
  if (m) return `Terminal ${m[1]}`;
  return 'Terminal';
}

function compactPath(p: string): string {
  try {
    const home = os.homedir();
    if (p.startsWith(home)) return '~' + p.slice(home.length);
  } catch {}
  return p;
}

type TerminalRegistryItem = {
  id: string;
  title?: string;
  cwd: string;
  createdAt: number;
  cols?: number;
  rows?: number;
  active: boolean;
  ownerClientId?: string;
  ownerDeviceId?: string;
  lastAttachedAt?: number;
};

function hasAnySelectorFlag(flags: Record<string, string | boolean>): boolean {
  return Boolean(flags.name || flags.id || flags.index || flags.pick || flags.query) || false;
}

function sortSessions(sessions: TerminalRegistryItem[], sort: string): TerminalRegistryItem[] {
  // smart: active desc, lastAttachedAt desc, createdAt asc
  const smart = (a: TerminalRegistryItem, b: TerminalRegistryItem) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    const la = a.lastAttachedAt || 0;
    const lb = b.lastAttachedAt || 0;
    if (la !== lb) return lb - la;
    return (a.createdAt || 0) - (b.createdAt || 0);
  };
  const created = (a: TerminalRegistryItem, b: TerminalRegistryItem) => (a.createdAt || 0) - (b.createdAt || 0);
  const attached = (a: TerminalRegistryItem, b: TerminalRegistryItem) => (b.lastAttachedAt || 0) - (a.lastAttachedAt || 0);
  const title = (a: TerminalRegistryItem, b: TerminalRegistryItem) => (a.title || deriveTitleFromId(a.id)).localeCompare(b.title || deriveTitleFromId(b.id), undefined, { sensitivity: 'base' });
  const sorter = sort === 'created' ? created : sort === 'attached' ? attached : sort === 'title' ? title : smart;
  return sessions.sort(sorter);
}

function formatSessionLine(s: TerminalRegistryItem, index: number, long: boolean): string {
  const title = s.title || deriveTitleFromId(s.id);
  const cwd = compactPath(s.cwd);
  const size = s.cols && s.rows ? `${s.cols}x${s.rows}` : '';
  const active = s.active ? 'active' : 'inactive';
  const owner = s.ownerDeviceId ? ` · device:${s.ownerDeviceId}` : '';
  const idPart = long ? ` · id=${s.id}` : '';
  return `[${index}] ${title}:${idPart}${size ? ` · ${size}` : ''} · ${active} · ${cwd}${owner}`;
}

async function selectSession(flags: Record<string, string | boolean>): Promise<{ index: number; session: TerminalRegistryItem } | null> {
  const path = resolveDataPath('runtime', 'term-sessions.json');
  if (!existsSync(path)) {
    console.log('No active terminal sessions.');
    return null;
  }
  let sessions: TerminalRegistryItem[] = [];
  try {
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw) as { sessions?: Array<TerminalRegistryItem> };
    sessions = Array.isArray(data.sessions) ? data.sessions.slice() : [];
  } catch (e) {
    console.error('Failed to read terminal sessions:', (e as Error).message);
    return null;
  }
  if (sessions.length === 0) {
    console.log('No active terminal sessions.');
    return null;
  }
  const sortKey = typeof flags.sort === 'string' ? String(flags.sort) : 'smart';
  sessions = sortSessions(sessions, sortKey);

  // Direct index
  if (typeof flags.index === 'string' && /^\d+$/.test(flags.index)) {
    const idx = Math.max(1, parseInt(String(flags.index), 10));
    if (idx <= sessions.length) return { index: idx, session: sessions[idx - 1] };
    console.log(`Index out of range. Choose 1..${sessions.length}`);
    return null;
  }

  // Name / ID flags
  const name = typeof flags.name === 'string' ? String(flags.name) : undefined;
  const id = typeof flags.id === 'string' ? String(flags.id) : undefined;
  const positional = typeof flags.query === 'string' ? String(flags.query) : undefined;
  // If positional is a number, treat as index
  if (positional && /^\d+$/.test(positional)) {
    const idx = Math.max(1, parseInt(positional, 10));
    if (idx <= sessions.length) return { index: idx, session: sessions[idx - 1] };
    console.log(`Index out of range. Choose 1..${sessions.length}`);
    return null;
  }
  const query = name || id || positional;
  if (query) {
    const res = resolveQuery(sessions, query, Boolean(id));
    if (res) return res;
    console.log(`No match for ${query}`);
    return null;
  }

  // No flags; interactive if TTY or print list with indices
  if (process.stdin.isTTY && process.stdout.isTTY && (Boolean(flags.pick) || Boolean(flags.query))) {
    return await interactivePick(sessions);
  }
  // If user provided a positional search term (after 'attach'), try it too
  // parseArgs already mapped subcmd; we don't keep the extra positional. As a convenience,
  // allow --pick (interactive) or show the list prompt.
  console.log('Provide a selector: --index N | --name "Title" | --id term:... or use --pick for interactive.');
  sessions.forEach((s, i) => {
    console.log(formatSessionLine(s, i + 1, false));
  });
  return null;
}

function resolveQuery(sessions: TerminalRegistryItem[], q: string, idOnly: boolean): { index: number; session: TerminalRegistryItem } | null {
  const lower = q.toLowerCase();
  const exactId = sessions.findIndex(s => s.id === q);
  if (exactId >= 0) return { index: exactId + 1, session: sessions[exactId] };
  if (!idOnly) {
    // Exact title (case-insensitive)
    const exactTitle = sessions.findIndex(s => (s.title || deriveTitleFromId(s.id)).toLowerCase() === lower);
    if (exactTitle >= 0) return { index: exactTitle + 1, session: sessions[exactTitle] };
    // Prefix title
    const prefixTitle = sessions.findIndex(s => (s.title || deriveTitleFromId(s.id)).toLowerCase().startsWith(lower));
    if (prefixTitle >= 0) return { index: prefixTitle + 1, session: sessions[prefixTitle] };
    // Fuzzy
    const results = fuzzysort.go(lower, sessions, {
      keys: ['title', 'id', 'cwd'],
      threshold: -10000,
      allowTypo: true,
      all: true,
    } as any);
    if (results && results.length > 0) {
      const best = results[0].obj as TerminalRegistryItem;
      const idx = sessions.findIndex(s => s.id === best.id);
      if (idx >= 0) return { index: idx + 1, session: sessions[idx] };
    }
  }
  return null;
}

async function interactivePick(sessions: TerminalRegistryItem[]): Promise<{ index: number; session: TerminalRegistryItem } | null> {
  sessions.forEach((s, i) => {
    console.log(formatSessionLine(s, i + 1, false));
  });
  const rl = await import('readline');
  const r = rl.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>(resolve => r.question(q, resolve));
  try {
    const answer = (await ask('Select index (q to cancel): ')).trim();
    if (!answer || /^q$/i.test(answer)) return null;
    const idx = parseInt(answer, 10);
    if (!Number.isFinite(idx) || idx < 1 || idx > sessions.length) {
      console.log('Invalid selection.');
      return null;
    }
    return { index: idx, session: sessions[idx - 1] };
  } finally {
    r.close();
  }
}

async function attachToSession(id: string, title: string, port: number): Promise<void> {
  // Prefer using local secret query param for deterministic local access
  let url = `ws://127.0.0.1:${port}/ws`;
  try {
    const keyPath = resolveDataPath('runtime', 'local-ws.key');
    const secret = readFileSync(keyPath, 'utf8').trim();
    if (secret) {
      url = `ws://127.0.0.1:${port}/ws?local=${encodeURIComponent(secret)}`;
    }
  } catch {}
  const ws = new WebSocket(url);
  let closed = false;
  let resizeSeq = 0;

  const cleanup = () => {
    if ((process.stdin as any).isTTY) {
      try { (process.stdin as any).setRawMode(false); } catch {}
    }
    try { process.stdin.pause(); } catch {}
  };

  const send = (msg: any) => {
    try { ws.send(JSON.stringify({ ...msg, timestamp: Date.now() })); } catch {}
  };

  const sendResize = () => {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    resizeSeq++;
    send({ type: 'term:resize', payload: { id, cols, rows, seq: resizeSeq } });
  };

  ws.on('open', () => {
    console.log(`Attaching to ${title} (id=${id}) — Ctrl+C to detach`);
    // Attach to the session; backlog will follow
    send({ type: 'term:attach', payload: { id } });

    // Start raw input
    if ((process.stdin as any).isTTY) {
      try { (process.stdin as any).setRawMode(true); } catch {}
    }
    process.stdin.resume();
    process.stdin.on('data', (buf: Buffer) => {
      if (closed) return;
      // Ctrl+C detach
      if (buf.length === 1 && buf[0] === 0x03) { // ^C
        closed = true;
        try { ws.close(); } catch {}
        cleanup();
        console.log('\nDetached.');
        return;
      }
      send({ type: 'term:input', payload: { id, data: buf.toString('utf8') } });
    });
    // For server (desktop) attach: do not send any PTY resize events.
  });

  ws.on('message', (data: WebSocket.RawData) => {
    if (closed) return;
    try {
      const msg = JSON.parse(data.toString());
      switch (msg?.type) {
        case 'term:frame':
          if (msg.payload?.data) {
            process.stdout.write(msg.payload.data);
          }
          break;
        case 'term:opened':
          // Desktop attach: do not send an initial resize; rely on app's existing PTY size
          break;
        case 'term:exit': {
          const code = msg?.payload?.code;
          console.log(`\n[process exited with code ${code}]`);
          closed = true;
          cleanup();
          try { ws.close(); } catch {}
          break;
        }
        default:
          break;
      }
    } catch {}
  });

  ws.on('close', (code: number, reasonBuf: Buffer) => {
    const reason = reasonBuf?.toString?.() || '';
    if (!closed) {
      closed = true;
      cleanup();
      if (code) {
        console.log(`\nDisconnected (code=${code}${reason ? `, reason=${reason}` : ''}).`);
      } else {
        console.log('\nDisconnected.');
      }
    }
  });

  ws.on('error', (err) => {
    if (!closed) {
      closed = true;
      cleanup();
      console.error('WebSocket error:', (err as any)?.message || err);
    }
  });
}

async function main() {
  const { cmd, subcmd, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || cmd === 'help') {
    printHelp();
    return;
  }
  switch (cmd) {
    case 'start':
      return cmdStart(flags);
    case 'pair':
      return cmdPair(flags);
    case 'stop':
      return cmdStop();
    case 'update':
      return cmdUpdate();
    case 'terminal':
      return cmdTerminal(flags, subcmd);
    default:
      console.log(status.unknownCommand(cmd));
      printHelp();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
