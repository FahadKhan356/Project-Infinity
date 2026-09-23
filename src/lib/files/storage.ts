import 'server-only';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * Physical storage for project files.
 *
 * Two rules hold everywhere in this module:
 *
 *   1. Paths are built from database integers, never from anything a client
 *      sent. The only client-derived component is a file extension, and it
 *      must match a strict allowlist pattern before it is used.
 *   2. Files live outside the web root and are never served statically. Every
 *      byte leaves through the download handler, which checks policy and
 *      writes an audit row (brief §43).
 */

export function storageRoot(): string {
  const root = process.env.STORAGE_ROOT;
  if (!root) throw new Error('STORAGE_ROOT is not set');
  return path.resolve(root);
}

/**
 * Staging area for in-flight uploads. Kept under STORAGE_ROOT so the final
 * move is a same-filesystem rename, which is atomic — a half-written file can
 * never appear at its final path.
 */
export function tempRoot(): string {
  return path.join(storageRoot(), 'tmp');
}

export function filesRoot(): string {
  return path.join(storageRoot(), 'files');
}

/** Resolves a stored relative path, refusing anything that escapes the root. */
export function absolutePath(relative: string): string {
  const root = storageRoot();
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Refusing to resolve a path outside STORAGE_ROOT');
  }
  return resolved;
}

const SAFE_EXTENSION = /^[a-z0-9]{1,8}$/;

/**
 * The extension is the only part of a filename that survives to disk, and only
 * when it is plainly safe. Anything else is dropped — the download handler
 * sets Content-Type from the stored mime type, so nothing depends on it.
 */
export function safeExtension(originalFilename: string): string {
  const ext = path.extname(originalFilename).replace(/^\./, '').toLowerCase();
  return SAFE_EXTENSION.test(ext) ? `.${ext}` : '';
}

export interface DeliverableLocation {
  clientId: number;
  periodYear: number;
  periodMonth: number;
  projectId: number;
  deliverableId: number;
  versionNo: number;
  storageKey: string;
  originalFilename: string;
}

/**
 * Mirrors the shape the brief asks for (§42) — client, month, project,
 * deliverable, version — while the leaf name stays an unguessable UUID.
 */
export function deliverableRelativePath(loc: DeliverableLocation): string {
  const month = String(loc.periodMonth).padStart(2, '0');
  return path.join(
    'files',
    'clients', String(loc.clientId),
    `${loc.periodYear}-${month}`,
    'projects', String(loc.projectId),
    'deliverables', String(loc.deliverableId),
    `v${loc.versionNo}`,
    `${loc.storageKey}${safeExtension(loc.originalFilename)}`,
  );
}

export interface AttachmentLocation {
  clientId: number;
  projectId: number;
  storageKey: string;
  originalFilename: string;
}

export function attachmentRelativePath(loc: AttachmentLocation): string {
  return path.join(
    'files',
    'clients', String(loc.clientId),
    'projects', String(loc.projectId),
    'attachments',
    `${loc.storageKey}${safeExtension(loc.originalFilename)}`,
  );
}

export function tempRelativePath(uploadId: string): string {
  return path.join('tmp', `${uploadId}.part`);
}

export async function ensureParentDirectory(relative: string): Promise<void> {
  await mkdir(path.dirname(absolutePath(relative)), { recursive: true });
}

export async function ensureStorageLayout(): Promise<void> {
  await mkdir(tempRoot(), { recursive: true });
  await mkdir(filesRoot(), { recursive: true });
}

/** Atomic within one filesystem: the file appears complete or not at all. */
export async function promoteTempFile(fromRelative: string, toRelative: string): Promise<void> {
  await ensureParentDirectory(toRelative);
  await rename(absolutePath(fromRelative), absolutePath(toRelative));
}

export async function fileSize(relative: string): Promise<number> {
  const info = await stat(absolutePath(relative));
  return info.size;
}

export async function removeFile(relative: string): Promise<void> {
  try {
    await unlink(absolutePath(relative));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Streamed so memory use stays flat regardless of file size — a 4 GB master is
 * read in chunks, never loaded.
 */
export function checksumOf(relative: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absolutePath(relative));
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * RFC 6266 / 5987 disposition. Header injection is impossible: control
 * characters are stripped and the UTF-8 form is percent-encoded.
 */
export function contentDisposition(originalFilename: string): string {
  const cleaned = originalFilename.replace(/[\u0000-\u001f\u007f"\\]/g, '_').slice(0, 200) || 'file';
  const ascii = cleaned.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(cleaned)}`;
}
