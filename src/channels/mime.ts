import path from 'node:path';

const BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
  '.html': 'text/html',
};

export function mimeFor(filename: string): string {
  return BY_EXT[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

export function extFor(mime: string | null | undefined, fallback = '.bin'): string {
  if (!mime) return fallback;
  const base = mime.split(';')[0]!.trim().toLowerCase();
  const hit = Object.entries(BY_EXT).find(([, m]) => m === base);
  return hit ? hit[0] : fallback;
}
