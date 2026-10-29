'use client';

import { useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { registerDeliverable, removeDeliverable } from '@/app/actions/staff';
import { ALLOWED_EXTENSIONS, formatBytes, storagePath, validateFile } from '@/lib/files';
import { inputClass } from '@/components/ui';

export type DeliverableFile = { id: string; filename: string; size_bytes: number; storage_path: string; url?: string; mine: boolean };

export function DeliverableManager(props: { orgId: string; jobId: string; canUpload: boolean; initial: DeliverableFile[] }) {
  const [files, setFiles] = useState<DeliverableFile[]>(props.initial);
  const [busy, setBusy] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);

  async function onChosen(list: FileList | null) {
    if (!list) return;
    const supabase = createClient();
    const errs: string[] = [];
    for (const file of Array.from(list)) {
      const problem = validateFile(file);
      if (problem) {
        errs.push(problem);
        continue;
      }
      const path = storagePath(props.orgId, props.jobId, crypto.randomUUID(), file.name);
      setBusy((b) => [...b, file.name]);
      const up = await supabase.storage.from('job-files').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
      if (up.error) {
        errs.push(`"${file.name}" could not be uploaded.`);
        setBusy((b) => b.filter((n) => n !== file.name));
        continue;
      }
      const res = await registerDeliverable({ jobId: props.jobId, path, filename: file.name, mime: file.type, size: file.size });
      setBusy((b) => b.filter((n) => n !== file.name));
      if (!res.ok) errs.push(res.error);
      else setFiles((f) => [...f, { ...res.file, mine: true }]);
    }
    setErrors(errs);
    if (input.current) input.current.value = '';
  }

  async function remove(id: string) {
    const res = await removeDeliverable(id);
    if (res.ok) setFiles((f) => f.filter((x) => x.id !== id));
    else setErrors([res.error]);
  }

  return (
    <div className="space-y-3">
      {files.length === 0 ? (
        <p className="text-sm text-slate-600">No finished files yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {files.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0 truncate text-slate-900">{f.filename}</span>
              <span className="flex shrink-0 items-center gap-3 text-xs text-slate-500">
                {formatBytes(f.size_bytes)}
                {f.url && <a href={f.url} download={f.filename} className="font-medium text-brand hover:underline">Download</a>}
                {f.mine && props.canUpload && (
                  <button type="button" onClick={() => remove(f.id)} className="font-medium text-red-600 hover:underline" aria-label={`Remove ${f.filename}`}>Remove</button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {props.canUpload && (
        <div>
          <label htmlFor="deliverable" className="mb-1.5 block text-sm font-medium text-slate-800">Attach a finished file</label>
          <input
            id="deliverable" ref={input} type="file" multiple disabled={busy.length > 0}
            accept={ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(',')}
            onChange={(e) => onChosen(e.target.files)}
            className={`${inputClass} file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-semibold`}
          />
          <p className="mt-1 text-xs text-slate-500">The client can download finished files from their job page.</p>
        </div>
      )}
      {busy.map((n) => <p key={n} role="status" className="text-sm text-slate-600">Uploading {n}…</p>)}
      {errors.map((m, i) => <p key={i} role="alert" className="text-sm font-medium text-red-600">{m}</p>)}
    </div>
  );
}
