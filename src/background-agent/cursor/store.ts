import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { CloudAgentRecord } from './types.js';

const DATA_DIR = join(process.cwd(), 'data', 'cloud-agents');
const INDEX_PATH = join(DATA_DIR, 'index.json');

function ensureStore() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(INDEX_PATH)) writeFileSync(INDEX_PATH, JSON.stringify({ agents: [] }, null, 2));
}

export function upsertRecord(record: CloudAgentRecord): void {
  ensureStore();
  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8')) as { agents: CloudAgentRecord[] };
  const existingIdx = index.agents.findIndex(a => a.id === record.id);
  const merged = existingIdx >= 0
    ? { ...index.agents[existingIdx], ...record, updatedAt: new Date().toISOString() }
    : { ...record, updatedAt: new Date().toISOString() };

  if (existingIdx >= 0) {
    index.agents[existingIdx] = merged;
  } else {
    index.agents.unshift(merged);
  }

  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
  const itemPath = join(DATA_DIR, `${record.id}.json`);
  // Write the merged record so fields like ownerClientId are preserved
  writeFileSync(itemPath, JSON.stringify(merged, null, 2));
}

export function getRecord(id: string): CloudAgentRecord | undefined {
  ensureStore();
  try {
    const itemPath = join(DATA_DIR, `${id}.json`);
    const raw = readFileSync(itemPath, 'utf8');
    return JSON.parse(raw) as CloudAgentRecord;
  } catch {
    return undefined;
  }
}

export function listRecords(limit = 20, cursor?: string): { items: CloudAgentRecord[]; nextCursor?: string } {
  ensureStore();
  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8')) as { agents: CloudAgentRecord[] };
  const start = cursor ? Math.max(index.agents.findIndex(a => a.id === cursor), 0) + 1 : 0;
  const items = index.agents.slice(start, start + limit);
  const nextCursor = start + limit < index.agents.length ? items[items.length - 1]?.id : undefined;
  return { items, nextCursor };
}

