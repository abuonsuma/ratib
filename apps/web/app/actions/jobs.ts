'use server';

import { revalidatePath } from 'next/cache';
import { getClientContext } from '@/lib/session';
import { friendlyDbError, parseJobDraft } from '@/lib/job';
import { MAX_FILES_PER_JOB, pathBelongsToJob, validateFile } from '@/lib/files';

export type ActionResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGN_IN_AGAIN = 'Please sign in again.';

/** Create or update a draft. The business comes from the server, never from the browser. */
export async function saveDraft(input: unknown, jobId: string | null): Promise<ActionResult<{ jobId: string }>> {
  const ctx = await getClientContext();
  if (!ctx) return { ok: false, error: SIGN_IN_AGAIN };
  if (jobId !== null && !UUID.test(jobId)) return { ok: false, error: 'That draft was not found.' };

  const parsed = parseJobDraft(input);
  if (!parsed.ok) return { ok: false, error: 'Please fix the highlighted fields.', fieldErrors: parsed.errors };

  const { data, error } = await ctx.supabase.rpc('save_job_draft', {
    p_org_id: ctx.org.id,
    p_job_id: jobId,
    p_payload: parsed.value,
  });
  if (error || typeof data !== 'string') return { ok: false, error: friendlyDbError(error?.message ?? '') };
  revalidatePath('/portal/jobs');
  return { ok: true, jobId: data };
}

export async function submitJob(jobId: string): Promise<ActionResult<{ ref: string }>> {
  const ctx = await getClientContext();
  if (!ctx) return { ok: false, error: SIGN_IN_AGAIN };
  if (!UUID.test(jobId)) return { ok: false, error: 'That job was not found.' };

  const { data, error } = await ctx.supabase.rpc('submit_job', { p_job_id: jobId });
  if (error || typeof data !== 'string') return { ok: false, error: friendlyDbError(error?.message ?? '') };
  revalidatePath('/portal', 'layout');
  return { ok: true, ref: data };
}

export async function discardDraft(jobId: string): Promise<ActionResult> {
  const ctx = await getClientContext();
  if (!ctx) return { ok: false, error: SIGN_IN_AGAIN };
  if (!UUID.test(jobId)) return { ok: false, error: 'That draft was not found.' };

  // remove uploaded files first so nothing is left behind in storage
  const { data: files } = await ctx.supabase.from('job_files').select('storage_path').eq('job_id', jobId);
  const paths = ((files ?? []) as { storage_path: string }[]).map((f) => f.storage_path);
  if (paths.length > 0) await ctx.supabase.storage.from('job-files').remove(paths);

  const { error } = await ctx.supabase.rpc('delete_job_draft', { p_job_id: jobId });
  if (error) return { ok: false, error: friendlyDbError(error.message) };
  revalidatePath('/portal', 'layout');
  return { ok: true };
}

/** Called after the browser has uploaded a file straight to storage. Validates and records it. */
export async function registerFile(input: {
  jobId: string;
  path: string;
  filename: string;
  mime: string;
  size: number;
  kind: 'reference' | 'design';
}): Promise<ActionResult<{ file: { id: string; filename: string; size_bytes: number; storage_path: string } }>> {
  const ctx = await getClientContext();
  if (!ctx) return { ok: false, error: SIGN_IN_AGAIN };
  if (!UUID.test(input.jobId)) return { ok: false, error: 'That job was not found.' };

  const problem = validateFile({ name: input.filename, size: input.size });
  if (problem) return { ok: false, error: problem };
  if (!pathBelongsToJob(input.path, ctx.org.id, input.jobId)) return { ok: false, error: 'Invalid upload location.' };
  const kind = input.kind === 'reference' ? 'reference' : 'design';

  const { count } = await ctx.supabase.from('job_files').select('id', { count: 'exact', head: true }).eq('job_id', input.jobId);
  if ((count ?? 0) >= MAX_FILES_PER_JOB) {
    await ctx.supabase.storage.from('job-files').remove([input.path]);
    return { ok: false, error: `You can attach up to ${MAX_FILES_PER_JOB} files to one job.` };
  }

  const { data, error } = await ctx.supabase
    .from('job_files')
    .insert({
      org_id: ctx.org.id,
      job_id: input.jobId,
      storage_path: input.path,
      filename: input.filename.slice(0, 200),
      mime_type: input.mime ? input.mime.slice(0, 100) : null,
      size_bytes: input.size,
      kind,
      uploaded_by: ctx.userId,
    })
    .select('id, filename, size_bytes, storage_path')
    .single();

  if (error || !data) {
    await ctx.supabase.storage.from('job-files').remove([input.path]);
    return { ok: false, error: 'You can no longer add files to this job.' };
  }
  return { ok: true, file: data as { id: string; filename: string; size_bytes: number; storage_path: string } };
}

export async function removeFile(fileId: string): Promise<ActionResult> {
  const ctx = await getClientContext();
  if (!ctx) return { ok: false, error: SIGN_IN_AGAIN };
  if (!UUID.test(fileId)) return { ok: false, error: 'That file was not found.' };

  const { data: file } = await ctx.supabase.from('job_files').select('storage_path').eq('id', fileId).maybeSingle();
  if (!file) return { ok: false, error: 'That file was not found.' };

  const { error } = await ctx.supabase.from('job_files').delete().eq('id', fileId);
  if (error) return { ok: false, error: 'Files can only be removed while the job is a draft.' };
  await ctx.supabase.storage.from('job-files').remove([(file as { storage_path: string }).storage_path]);
  return { ok: true };
}
