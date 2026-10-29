'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getStaffContext } from '@/lib/staff-session';
import { errorCode } from '@/lib/staff';
import { pathBelongsToJob, validateFile } from '@/lib/files';
import type { ActionResult } from '@/app/actions/jobs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGE = /^[a-z_]{2,40}$/;

function field(fd: FormData, key: string, max: number): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function backToJob(jobId: string, kind: 'ok' | 'err', code: string): never {
  // only short fixed codes travel in the address; the page maps them to messages
  redirect(`/admin/jobs/${jobId}?${kind}=${encodeURIComponent(code)}`);
}

async function need() {
  const ctx = await getStaffContext();
  if (!ctx) redirect('/login?error=not_staff');
  return ctx;
}

function jobIdOf(fd: FormData): string {
  const id = field(fd, 'job_id', 40);
  if (!UUID.test(id)) redirect('/admin/jobs');
  return id;
}

export async function changeStatus(fd: FormData): Promise<void> {
  const ctx = await need();
  const jobId = jobIdOf(fd);
  const to = field(fd, 'to_status', 40);
  if (!STAGE.test(to)) backToJob(jobId, 'err', 'unknown_stage');

  const { error } = await ctx.supabase.rpc('transition_job', {
    p_job_id: jobId,
    p_to: to,
    p_client_note: field(fd, 'client_note', 1000) || null,
    p_internal_note: field(fd, 'internal_note', 2000) || null,
  });
  if (error) backToJob(jobId, 'err', errorCode(error.message));
  revalidatePath('/admin', 'layout');
  backToJob(jobId, 'ok', 'status');
}

export async function assignStaff(fd: FormData): Promise<void> {
  const ctx = await need();
  const jobId = jobIdOf(fd);
  const userId = field(fd, 'user_id', 40);
  if (!UUID.test(userId)) backToJob(jobId, 'err', 'not_staff_member');
  const { error } = await ctx.supabase.rpc('assign_job', { p_job_id: jobId, p_user_id: userId, p_role: field(fd, 'role', 20) || 'worker' });
  if (error) backToJob(jobId, 'err', errorCode(error.message));
  revalidatePath('/admin', 'layout');
  backToJob(jobId, 'ok', 'assigned');
}

export async function unassignStaff(fd: FormData): Promise<void> {
  const ctx = await need();
  const jobId = jobIdOf(fd);
  const userId = field(fd, 'user_id', 40);
  if (!UUID.test(userId)) backToJob(jobId, 'err', 'not_assigned');
  const { error } = await ctx.supabase.rpc('unassign_job', { p_job_id: jobId, p_user_id: userId });
  if (error) backToJob(jobId, 'err', errorCode(error.message));
  revalidatePath('/admin', 'layout');
  backToJob(jobId, 'ok', 'unassigned');
}

export async function saveEstimate(fd: FormData): Promise<void> {
  const ctx = await need();
  const jobId = jobIdOf(fd);
  const raw = field(fd, 'date', 10);
  if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) backToJob(jobId, 'err', 'date_in_past');
  const { error } = await ctx.supabase.rpc('set_estimated_completion', { p_job_id: jobId, p_date: raw || null });
  if (error) backToJob(jobId, 'err', errorCode(error.message));
  revalidatePath('/admin', 'layout');
  backToJob(jobId, 'ok', 'estimate');
}

export async function approveForClient(fd: FormData): Promise<void> {
  const ctx = await need();
  const jobId = jobIdOf(fd);
  const { error } = await ctx.supabase.rpc('record_client_approval', { p_job_id: jobId, p_note: field(fd, 'note', 500) });
  if (error) backToJob(jobId, 'err', errorCode(error.message));
  revalidatePath('/admin', 'layout');
  backToJob(jobId, 'ok', 'approval');
}

export async function addNote(fd: FormData): Promise<void> {
  const ctx = await need();
  const jobId = jobIdOf(fd);
  const { error } = await ctx.supabase.rpc('add_job_note', { p_job_id: jobId, p_body: field(fd, 'body', 2000) });
  if (error) backToJob(jobId, 'err', errorCode(error.message));
  revalidatePath(`/admin/jobs/${jobId}`);
  backToJob(jobId, 'ok', 'note');
}

/** Called after the browser has uploaded a finished file straight to private storage. */
export async function registerDeliverable(input: {
  jobId: string;
  path: string;
  filename: string;
  mime: string;
  size: number;
}): Promise<ActionResult<{ file: { id: string; filename: string; size_bytes: number; storage_path: string } }>> {
  const ctx = await getStaffContext();
  if (!ctx) return { ok: false, error: 'Please sign in again.' };
  if (!UUID.test(input.jobId)) return { ok: false, error: 'That job was not found.' };
  const problem = validateFile({ name: input.filename, size: input.size });
  if (problem) return { ok: false, error: problem };
  if (!pathBelongsToJob(input.path, ctx.org.id, input.jobId)) return { ok: false, error: 'Invalid upload location.' };

  const { data, error } = await ctx.supabase
    .from('job_files')
    .insert({
      org_id: ctx.org.id,
      job_id: input.jobId,
      storage_path: input.path,
      filename: input.filename.slice(0, 200),
      mime_type: input.mime ? input.mime.slice(0, 100) : null,
      size_bytes: input.size,
      kind: 'deliverable',
      uploaded_by: ctx.userId,
    })
    .select('id, filename, size_bytes, storage_path')
    .single();
  if (error || !data) {
    await ctx.supabase.storage.from('job-files').remove([input.path]);
    return { ok: false, error: 'You cannot add files to this job.' };
  }
  revalidatePath(`/admin/jobs/${input.jobId}`);
  return { ok: true, file: data as { id: string; filename: string; size_bytes: number; storage_path: string } };
}

export async function removeDeliverable(fileId: string): Promise<ActionResult> {
  const ctx = await getStaffContext();
  if (!ctx) return { ok: false, error: 'Please sign in again.' };
  if (!UUID.test(fileId)) return { ok: false, error: 'That file was not found.' };
  const { data: file } = await ctx.supabase.from('job_files').select('storage_path, job_id').eq('id', fileId).maybeSingle();
  if (!file) return { ok: false, error: 'That file was not found.' };
  const { data: removed, error } = await ctx.supabase.from('job_files').delete().eq('id', fileId).select('id');
  if (error || !removed || removed.length === 0) return { ok: false, error: 'You can only remove finished files that you uploaded.' };
  await ctx.supabase.storage.from('job-files').remove([(file as { storage_path: string }).storage_path]);
  revalidatePath(`/admin/jobs/${(file as { job_id: string }).job_id}`);
  return { ok: true };
}

export async function savePaymentGate(fd: FormData): Promise<void> {
  const ctx = await need();
  const enabled = field(fd, 'enabled', 5) === 'true';
  const { error } = await ctx.supabase.rpc('set_business_setting', { p_org: ctx.org.id, p_key: 'enforce_payment_gate', p_value: enabled });
  if (error) redirect(`/admin/settings?err=${encodeURIComponent(errorCode(error.message))}`);
  revalidatePath('/admin/settings');
  redirect('/admin/settings?ok=setting');
}

export async function markAllStaffAlertsRead(): Promise<void> {
  const ctx = await need();
  await ctx.supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('user_id', ctx.userId).is('read_at', null);
  revalidatePath('/admin', 'layout');
}
