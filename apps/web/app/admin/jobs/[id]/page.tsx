import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireStaff } from '@/lib/staff-session';
import { statusTone } from '@/lib/workflow';
import { ROLE_LABELS, okMessage, reasonText, splitOptions, staffErrorMessage, type Activity, type NextOption } from '@/lib/staff';
import { formatBytes } from '@/lib/files';
import { formatDate, formatDateTime } from '@/lib/format';
import { addNote, approveForClient, assignStaff, changeStatus, saveEstimate, unassignStaff } from '@/app/actions/staff';
import { SubmitButton } from '@/components/submit-button';
import { DeliverableManager, type DeliverableFile } from '@/components/deliverable-manager';
import { Alert, Badge, Card, Field, buttonDanger, buttonSecondary, inputClass } from '@/components/ui';
import type { JobFileRow, JobItemRow, JobRow } from '@/lib/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AdminJobPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!UUID.test(id)) notFound();
  const staff = await requireStaff('jobs.read');
  const { supabase, org, perms } = staff;

  const { data: jobData } = await supabase.from('jobs').select('*, service_categories(name)').eq('id', id).maybeSingle();
  if (!jobData) notFound();
  const job = jobData as JobRow & { service_categories: { name: string } | null };

  const canUpdate = perms.has('jobs.update_status');
  const canAssign = perms.has('jobs.assign');

  const [{ data: activityData }, { data: optionData }, { data: itemData }, { data: fileData }, { data: stageData }, people] = await Promise.all([
    supabase.rpc('staff_job_activity', { p_job_id: id }),
    canUpdate ? supabase.rpc('job_next_options', { p_job_id: id }) : Promise.resolve({ data: [] as unknown[] }),
    supabase.from('job_items').select('*').eq('job_id', id).order('position'),
    supabase.from('job_files').select('id, storage_path, filename, mime_type, size_bytes, kind, created_at, uploaded_by').eq('job_id', id).order('created_at'),
    supabase.from('workflow_stages').select('status_key, label, requires_approval').eq('workflow_id', job.workflow_id),
    canAssign ? supabase.rpc('list_assignable_staff', { p_org: org.id }) : Promise.resolve({ data: [] as unknown[] }),
  ]);

  const activity = (activityData ?? { customer: null, assignees: [], history: [], notes: [], controls: {} }) as Activity;
  const options = (optionData ?? []) as NextOption[];
  const items = (itemData ?? []) as JobItemRow[];
  const files = (fileData ?? []) as (JobFileRow & { uploaded_by: string | null })[];
  const stages = (stageData ?? []) as { status_key: string; label: string; requires_approval: boolean }[];
  const staffList = (people.data ?? []) as { user_id: string; full_name: string; role_name: string }[];

  const stage = stages.find((s) => s.status_key === job.status);
  const awaitingApproval = !!stage?.requires_approval;
  const { allowed, blocked } = splitOptions(options);
  const onTrack = allowed.filter((o) => !['on_hold', 'cancelled'].includes(o.status_key));
  const offTrack = allowed.filter((o) => ['on_hold', 'cancelled'].includes(o.status_key));

  const urls = new Map<string, string>();
  if (files.length > 0) {
    const { data: signed } = await supabase.storage.from('job-files').createSignedUrls(files.map((f) => f.storage_path), 600);
    for (const s of signed ?? []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
  }
  const uploads = files.filter((f) => f.kind !== 'deliverable');
  const deliverables: DeliverableFile[] = files
    .filter((f) => f.kind === 'deliverable')
    .map((f) => ({ id: f.id, filename: f.filename, size_bytes: f.size_bytes, storage_path: f.storage_path, url: urls.get(f.storage_path), mine: f.uploaded_by === staff.userId }));

  const ok = okMessage(typeof sp.ok === 'string' ? sp.ok : null);
  const err = typeof sp.err === 'string' ? staffErrorMessage(sp.err) : null;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = !!job.due_date && job.due_date < today && !['completed', 'cancelled', 'ready_for_collection', 'out_for_delivery'].includes(job.status);
  const c = activity.controls;
  const assignedIds = new Set(activity.assignees.map((a) => a.user_id));

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/jobs" className="text-sm font-medium text-brand hover:underline">← All jobs</Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-slate-500">{job.job_ref} · {job.service_categories?.name}</p>
            <h1 className="text-2xl font-semibold text-slate-900">{job.title}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {job.priority === 'urgent' && <Badge tone="red">Urgent</Badge>}
            {overdue && <Badge tone="red">Overdue</Badge>}
            <Badge tone={statusTone(job.status)}>{stage?.label ?? job.status}</Badge>
          </div>
        </div>
      </div>

      {ok && <Alert tone="success">{ok}</Alert>}
      {err && <Alert tone="error">{err}</Alert>}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {canUpdate ? (
            <Card className="p-5">
              <h2 className="mb-1 text-base font-semibold text-slate-900">Move this job</h2>
              <p className="mb-4 text-xs text-slate-500">The client sees the message and gets an alert. Internal notes stay with staff.</p>
              <form action={changeStatus} className="space-y-4">
                <input type="hidden" name="job_id" value={job.id} />
                <Field label="Move to" htmlFor="to_status">
                  <select id="to_status" name="to_status" required defaultValue="" className={inputClass}>
                    <option value="" disabled>Choose the next step…</option>
                    {onTrack.length > 0 && <optgroup label="Next steps">{onTrack.map((o) => <option key={o.status_key} value={o.status_key}>{o.label}</option>)}</optgroup>}
                    {offTrack.length > 0 && <optgroup label="Pause or stop">{offTrack.map((o) => <option key={o.status_key} value={o.status_key}>{o.label}</option>)}</optgroup>}
                    {blocked.length > 0 && <optgroup label="Not available right now">{blocked.map((o) => <option key={o.status_key} value={o.status_key} disabled>{o.label} ({reasonText(o.reason)})</option>)}</optgroup>}
                  </select>
                </Field>
                <Field label="Message to the client (optional)" htmlFor="client_note" hint="Required for On Hold and Cancelled, so the client knows why.">
                  <textarea id="client_note" name="client_note" rows={2} maxLength={1000} className={inputClass} />
                </Field>
                <Field label="Internal note (optional)" htmlFor="internal_note" hint="Required for Payment Confirmed: say how the payment was received.">
                  <textarea id="internal_note" name="internal_note" rows={2} maxLength={2000} className={inputClass} />
                </Field>
                <SubmitButton pendingText="Saving…" className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">Update job</SubmitButton>
              </form>
            </Card>
          ) : (
            <Alert tone="info">You can view this job, but you cannot change its stage.</Alert>
          )}

          <Card className="p-5">
            <h2 className="mb-4 text-base font-semibold text-slate-900">History</h2>
            <ol className="space-y-4">
              {activity.history.map((h) => (
                <li key={h.id} className="border-l-2 border-slate-200 pl-4">
                  <p className="text-sm font-medium text-slate-900">{h.label}</p>
                  <p className="text-xs text-slate-500">{formatDateTime(h.created_at)}{h.actor_name ? ` · ${h.actor_name}` : ''}</p>
                  {h.client_note && <p className="mt-1 text-sm text-slate-700"><span className="text-xs font-semibold uppercase tracking-wide text-slate-500">To client: </span>{h.client_note}</p>}
                  {h.internal_note && <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-sm text-amber-900"><span className="text-xs font-semibold uppercase tracking-wide">Internal: </span>{h.internal_note}</p>}
                </li>
              ))}
            </ol>
          </Card>

          <Card className="overflow-x-auto">
            <h2 className="px-5 pt-5 text-base font-semibold text-slate-900">Order</h2>
            <table className="mt-3 w-full min-w-[620px] text-left text-sm">
              <thead className="border-y border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr><th scope="col" className="px-5 py-2">Item</th><th scope="col" className="px-3 py-2">Qty</th><th scope="col" className="px-3 py-2">Size</th><th scope="col" className="px-3 py-2">Colour</th><th scope="col" className="px-3 py-2">Material and finishing</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((it) => (
                  <tr key={it.id}>
                    <td className="px-5 py-3 font-medium text-slate-900">{it.description}</td>
                    <td className="px-3 py-3">{it.quantity.toLocaleString('en-GB')}</td>
                    <td className="px-3 py-3">{[it.size, it.orientation !== 'not_applicable' ? it.orientation : ''].filter(Boolean).join(', ') || '—'}</td>
                    <td className="px-3 py-3">{it.colour_mode === 'black_white' ? 'Black and white' : 'Full colour'}</td>
                    <td className="px-3 py-3">{[it.material, it.finishing].filter(Boolean).join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {job.description && <p className="px-5 py-3 text-sm text-slate-700">{job.description}</p>}
            {job.instructions && <p className="px-5 pb-4 text-sm text-slate-700"><span className="font-medium">Client instructions:</span> {job.instructions}</p>}
          </Card>

          <div className="grid gap-6 md:grid-cols-2">
            <Card className="p-5">
              <h2 className="mb-3 text-base font-semibold text-slate-900">Files from the client</h2>
              {uploads.length === 0 ? <p className="text-sm text-slate-600">No files attached.</p> : (
                <ul className="divide-y divide-slate-100">
                  {uploads.map((f) => (
                    <li key={f.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <span className="min-w-0 truncate text-slate-900">{f.filename}{f.kind === 'reference' ? ' (reference)' : ''}</span>
                      <span className="flex shrink-0 items-center gap-3 text-xs text-slate-500">
                        {formatBytes(f.size_bytes)}
                        {urls.get(f.storage_path) && <a href={urls.get(f.storage_path)} download={f.filename} className="font-medium text-brand hover:underline">Download</a>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card className="p-5">
              <h2 className="mb-3 text-base font-semibold text-slate-900">Finished files</h2>
              <DeliverableManager orgId={org.id} jobId={job.id} canUpload={canUpdate} initial={deliverables} />
            </Card>
          </div>
        </div>

        <aside className="space-y-6">
          <Card className="space-y-3 p-5 text-sm">
            <h2 className="text-base font-semibold text-slate-900">Customer</h2>
            <p className="font-medium text-slate-900">{activity.customer?.name}{activity.customer?.company_name ? <span className="block text-xs font-normal text-slate-500">{activity.customer.company_name}</span> : null}</p>
            {activity.customer?.phone && <p><a href={`tel:${activity.customer.phone}`} className="text-brand hover:underline">{activity.customer.phone}</a></p>}
            {activity.customer?.email && <p className="break-all"><a href={`mailto:${activity.customer.email}`} className="text-brand hover:underline">{activity.customer.email}</a></p>}
            {!activity.customer?.phone && !activity.customer?.email && <p className="text-xs text-slate-500">Contact details are visible to customer service, managers and accountants.</p>}
          </Card>

          <Card className="space-y-3 p-5 text-sm">
            <h2 className="text-base font-semibold text-slate-900">Details</h2>
            <p><span className="text-slate-500">Needed by:</span> {job.due_date ? formatDate(job.due_date) : 'No date'}</p>
            <p><span className="text-slate-500">Estimate:</span> {job.estimated_completion ? formatDate(job.estimated_completion) : 'Not set'}</p>
            <p><span className="text-slate-500">Collection or delivery:</span> {job.delivery_method === 'delivery' ? `Delivery to ${job.delivery_address ?? ''}` : 'Collection'}</p>
            <p><span className="text-slate-500">Payment:</span> {c.payment_cleared_at ? `Confirmed ${formatDate(c.payment_cleared_at)}` : 'Not confirmed'}</p>
            {c.payment_note && <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">{c.payment_note}</p>}
            {canUpdate && (
              <form action={saveEstimate} className="space-y-2 border-t border-slate-100 pt-3">
                <input type="hidden" name="job_id" value={job.id} />
                <Field label="Estimated completion" htmlFor="date">
                  <input id="date" name="date" type="date" min={today} defaultValue={job.estimated_completion ?? ''} className={inputClass} />
                </Field>
                <SubmitButton pendingText="Saving…" className={buttonSecondary}>Save estimate</SubmitButton>
              </form>
            )}
          </Card>

          {awaitingApproval && (
            <Card className="space-y-3 p-5 text-sm">
              <h2 className="text-base font-semibold text-slate-900">Client approval</h2>
              {c.approved_at ? (
                <p className="text-emerald-800">Approved {formatDate(c.approved_at)}. {c.approval_note}</p>
              ) : canUpdate ? (
                <form action={approveForClient} className="space-y-2">
                  <input type="hidden" name="job_id" value={job.id} />
                  <p className="text-xs text-slate-600">Waiting for the client. If they approved by phone, WhatsApp or in person, record it here.</p>
                  <Field label="How did they approve?" htmlFor="approval_note">
                    <input id="approval_note" name="note" required minLength={3} maxLength={500} placeholder="Approved by phone on 28 Oct" className={inputClass} />
                  </Field>
                  <SubmitButton pendingText="Saving…" className={buttonSecondary}>Record approval</SubmitButton>
                </form>
              ) : <p className="text-slate-600">Waiting for the client.</p>}
            </Card>
          )}

          <Card className="space-y-3 p-5 text-sm">
            <h2 className="text-base font-semibold text-slate-900">Assigned to</h2>
            {activity.assignees.length === 0 ? <p className="text-slate-600">Nobody yet.</p> : (
              <ul className="space-y-2">
                {activity.assignees.map((a) => (
                  <li key={a.user_id} className="flex items-center justify-between gap-2">
                    <span>{a.full_name || 'Unnamed'} <span className="text-xs text-slate-500">({ROLE_LABELS[a.role_on_job] ?? a.role_on_job})</span></span>
                    {canAssign && (
                      <form action={unassignStaff}>
                        <input type="hidden" name="job_id" value={job.id} /><input type="hidden" name="user_id" value={a.user_id} />
                        <button className={`${buttonDanger} !px-2 !py-1 text-xs`} aria-label={`Remove ${a.full_name}`}>Remove</button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canAssign && (
              <form action={assignStaff} className="space-y-2 border-t border-slate-100 pt-3">
                <input type="hidden" name="job_id" value={job.id} />
                <Field label="Add someone" htmlFor="user_id">
                  <select id="user_id" name="user_id" required defaultValue="" className={inputClass}>
                    <option value="" disabled>Choose a staff member…</option>
                    {staffList.filter((p) => !assignedIds.has(p.user_id)).map((p) => <option key={p.user_id} value={p.user_id}>{p.full_name || 'Unnamed'} ({p.role_name})</option>)}
                  </select>
                </Field>
                <Field label="Their part in this job" htmlFor="role">
                  <select id="role" name="role" defaultValue="worker" className={inputClass}>
                    {Object.entries(ROLE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </Field>
                <SubmitButton pendingText="Saving…" className={buttonSecondary}>Assign</SubmitButton>
              </form>
            )}
          </Card>

          <Card className="space-y-3 p-5 text-sm">
            <h2 className="text-base font-semibold text-slate-900">Internal notes</h2>
            <p className="text-xs text-slate-500">Only staff on this job can see these.</p>
            <form action={addNote} className="space-y-2">
              <input type="hidden" name="job_id" value={job.id} />
              <label htmlFor="body" className="sr-only">New note</label>
              <textarea id="body" name="body" rows={2} required maxLength={2000} className={inputClass} placeholder="e.g. Waiting for lamination film" />
              <SubmitButton pendingText="Saving…" className={buttonSecondary}>Add note</SubmitButton>
            </form>
            {activity.notes.length > 0 && (
              <ul className="space-y-3 border-t border-slate-100 pt-3">
                {activity.notes.map((n) => (
                  <li key={n.id}>
                    <p className="whitespace-pre-line text-slate-900">{n.body}</p>
                    <p className="text-xs text-slate-500">{n.author_name} · {formatDateTime(n.created_at)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}
