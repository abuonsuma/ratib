// Upload rules. These mirror the storage policy and job_files constraints in the database;
// the database remains the final authority. Keep the two lists in sync.

export const ALLOWED_EXTENSIONS = [
  'pdf', 'jpg', 'jpeg', 'png', 'tif', 'tiff', 'svg', 'ai', 'eps', 'psd', 'cdr', 'indd',
  'zip', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt',
] as const;

export const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
export const MAX_FILES_PER_JOB = 20;

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 || i === name.length - 1 ? '' : name.slice(i + 1).toLowerCase();
}

/** Returns an error message, or null when the file is acceptable. */
export function validateFile(file: { name: string; size: number }): string | null {
  if (!file.name || file.name.trim() === '') return 'The file has no name.';
  const ext = extensionOf(file.name);
  if (!ext) return `"${file.name}" has no file extension.`;
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    return `".${ext}" files are not accepted. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}.`;
  }
  if (file.size <= 0) return `"${file.name}" is empty.`;
  if (file.size > MAX_FILE_BYTES) {
    return `"${file.name}" is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_FILE_BYTES)} per file.`;
  }
  return null;
}

/** Safe storage file name: letters, digits, dot, dash, underscore only; keeps the extension. */
export function safeFilename(name: string): string {
  const ext = extensionOf(name);
  const base = ext ? name.slice(0, name.length - ext.length - 1) : name;
  const cleaned = base
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return `${cleaned || 'file'}.${ext || 'bin'}`;
}

export function storagePath(orgId: string, jobId: string, uniqueId: string, filename: string): string {
  return `${orgId}/${jobId}/${uniqueId}-${safeFilename(filename)}`;
}

/** The server only accepts paths inside the job's own folder. */
export function pathBelongsToJob(path: string, orgId: string, jobId: string): boolean {
  const prefix = `${orgId}/${jobId}/`;
  return path.startsWith(prefix) && !path.slice(prefix.length).includes('/') && !path.includes('..');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function isImage(name: string): boolean {
  return ['jpg', 'jpeg', 'png', 'svg'].includes(extensionOf(name));
}
