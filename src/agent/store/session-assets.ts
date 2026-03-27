import { promises as fs } from 'fs';
import { basename, extname, join } from 'path';
import { ensureDirPath, resolveDataPath } from '../../shared/paths';

function getSessionImagesDir(sessionId: string): string {
  return resolveDataPath('sessions', sessionId, 'images');
}

function normalizeExtFromMediaType(mediaType: string): string {
  const mt = (mediaType || '').toLowerCase();
  if (mt.includes('jpeg') || mt.includes('jpg')) return '.jpg';
  if (mt.includes('png')) return '.png';
  if (mt.includes('gif')) return '.gif';
  if (mt.includes('webp')) return '.webp';
  return '.img';
}

function mediaTypeFromExt(ext: string): string {
  const e = ext.toLowerCase();
  switch (e) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

export async function saveSessionImage(sessionId: string, mediaType: string, base64: string): Promise<{ fileName: string; relPath: string }> {
  const dir = getSessionImagesDir(sessionId);
  ensureDirPath(dir);
  const ext = normalizeExtFromMediaType(mediaType);
  const id = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
  const fileName = `${id}${ext}`;
  const filePath = join(dir, fileName);
  const buf = Buffer.from(base64, 'base64');
  await fs.writeFile(filePath, buf);
  return { fileName, relPath: `sessions/${sessionId}/images/${fileName}` };
}

export async function readSessionImageBase64(sessionId: string, fileName: string): Promise<{ mediaType: string; base64: string } | null> {
  // Prevent path traversal
  const safe = basename(fileName);
  if (safe !== fileName) return null;
  const dir = getSessionImagesDir(sessionId);
  const filePath = join(dir, safe);
  try {
    const data = await fs.readFile(filePath);
    const ext = extname(safe) || '.jpg';
    const mediaType = mediaTypeFromExt(ext);
    return { mediaType, base64: data.toString('base64') };
  } catch {
    return null;
  }
}

export function buildSessionAssetPath(sessionId: string, fileName: string): string {
  const safe = basename(fileName);
  return `/agent/session/asset?id=${encodeURIComponent(sessionId)}&file=${encodeURIComponent(safe)}`;
}
