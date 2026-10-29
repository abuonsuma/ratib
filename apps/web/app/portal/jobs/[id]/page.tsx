import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireClient } from '@/lib/session';
import { buildTimeline, clientAction, statusTone, type HistoryEntry, type Stage } from '@/lib/workflow';
import { formatBytes } from '@/lib/files';
import { formatDate, formatDateTime } from '@/lib/format';
import { Alert, Badge, Card } from '@/components/ui';
import type { JobFileRow, JobItemRow, JobRow } from '@/lib/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function JobPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!UUID.test(id)) notFound();
  const { supabase } = await requireClient();

  const { data: jobData } = await supabase.from('jobs').select('*, service_categories(name)').eq('id', id).maybeSingle();
  if (!jobData) notFound(); // RLS hides other people's jobs, so they look the same as missing ones
  const job = jobData as JobRow & { service_categories: { name: string } | null };
  if (job.status === 'draft') redirect(`/portal/jobs/new?draft=${job.id}`);

  const [{ data: stageData }, { data: historyData }, { data: itemData }, { data: fileData }] = await Promise.all([
    supabase.from('workflow_stages').select('status_key, label, position, off_track, is_terminal, client_visible').eq('workflow_id', job.workflow_id),
    supabase.from('client_job_timeline').select('to_status, label, client_note, created_at').eq('job_id', id).order('created_at', { ascending: false }),
    supabase.from('job_items').select('*').eq('job_id', id).order('position'),
    supabase.from('job_files').select('id, storage_path, filename, mime_type, size_bytes, kind, created_at').eq('job_id', id).order('created_at'),
  ]);

  const stages = (stageData ?? []) as Stage[];
  const history = (historyData ?? []) as HistoryEntry[];
  const items = (itemData ?? []) as JobItemRow[];
  const files = (fileData ?? []) as JobFileRow[];
  const timeline = buildTimeline(stages, history, job.status);
  const currentLabel = stages.find((s) => s.status_key === job.status)?.label ?? job.status;
  const action = clientAction(job.status);

  // files are private: each download link is signed for 10 minutes
  const urlByPath = new Map<string, string>();
  if (files.length > 0) {
    const { data: signed } = await supabase.storage.from('job-files').createSignedUrls(files.map((f) => f.storage_path), 600);
    for (const s of signed ?? []) if (s.path && s.signedUrl) urlByPath.set(s.path, s.signedUrl);
  }

  const deliverables = files.filter((f) => f.kind === 'deliverable');
  const uploads = files.filter((f) => f.kind !== 'deliverable');

  return (
    <div className="space-y-6">
      <div>
        <Link href="/portal/jobs" className="text-sm font-medium text-brand hover:underline">← My jobs</Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-slate-500">{job.job_ref}</p>
            <h1 className="text-2xl font-semibold text-slate-900">{job.title}</h1>
            <p className="mt-1 text-sm text-slate-600">{job.service_categories?.name}</p>
          </div>
          <Badge tone={statusTone(job.status)}>{currentLabel}</Badge>
        </div>
      </div>

      {sp.submitted && <Alert tone="success">Your job was submitted. You will see every update on this page.</Alert>}
      {action && job.status !== 'draft' && <Alert tone="warning"><strong>Action needed:</strong> {action}</Alert>}
      {timeline.offTrack && (
        <Alert tone={timeline.offTrack.key === 'cancelled' ? 'error' : 'warning'}>
          <strong>{timeline.offTrack.label}.</strong> {timeline.offTrack.note ?? ''}
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="lg:col-span-2" aria-labelledby="progress">
          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 id="progress" className="text-base font-semibold text-slate-900">Progress</h2>
              <span className="text-sm text-slate-600">{timeline.percent}%</span>
            </div>
            <div className="mb-5 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={timeline.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Job progress">
              <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${timeline.percent}%` }} />
            </div>
            <ol className="space-y-0">
              {timeline.steps.map((s, i) => (
                <li key={s.key} className="relative flex gap-3 pb-5 last:pb-0">
                  {i < timeline.steps.length - 1 && <span aria-hidden className={`absolute left-[11px] top-6 h-full w-0.5 ${s.state === 'done' ? 'bg-brand' : 'bg-slate-200'}`} />}
                  <span
                    aria-hidden
                    className={`relative z-[1] mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-[10px] font-bold ${
                      s.state === 'done' ? 'border-brand bg-brand text-white' : s.state === 'current' ? 'border-brand bg-white text-brand' : 'border-slate-300 bg-white text-slate-300'
                    }`}
                  >
                    {s.state === 'done' ? '✓' : s.state === 'current' ? '•' : ''}
                  </span>
                  <div className="min-w-0 pt-0.5">
                    <p className={`text-sm ${s.state === 'upcoming' ? 'text-slate-400' : 'font-medium text-slate-900'}`}>
                      {s.label}
                      {s.state === 'current' && <span className="sr-only"> (current step)</span>}
                    </p>
                    {s.at && <p className="text-xs text-slate-500">{formatDateTime(s.at)}</p>}
                    {s.note && s.state !== 'upcoming' && <p className="mt-1 text-sm text-slate-700">{s.note}</p>}
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </section>

        <aside className="space-y-6">
          <Card className="space-y-3 p-5 text-sm">
            <h2 className="text-base font-semibold text-slate-900">Details</h2>
            <Detail label="Needed by" value={job.due_date ? formatDate(job.due_date) : 'No date set'} />
            <Detail label="Estimated completion" value={job.estimated_completion ? formatDate(job.estimated_completion) : 'We will confirm after review'} />
            <Detail label="Collection or delivery" value={job.delivery_method === 'delivery' ? `Delivery to ${job.delivery_address ?? ''}` : 'Collect from us'} />
            {job.priority === 'urgent' && <Detail label="Priority" value="Urgent" />}
            {job.instructions && <Detail label="Your instructions" value={job.instructions} />}
          </Card>

          {deliverables.length > 0 && (
            <Card className="p-5">
              <h2 className="mb-3 text-base font-semibold text-slate-900">Finished files</h2>
              <FileList files={deliverables} urls={urlByPath} />
            </Card>
          )}
        </aside>
      </div>

      <section aria-labelledby="items">
        <h2 id="items" className="mb-3 text-base font-semibold text-slate-900">What you ordered</h2>
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-2.5">Item</th>
                <th scope="col" className="px-4 py-2.5">Qty</th>
                <th scope="col" className="px-4 py-2.5">Size</th>
                <th scope="col" className="px-4 py-2.5">Colour</th>
                <th scope="col" className="px-4 py-2.5">Material and finishing</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((it) => (
                <tr key={it.id}>
                  <td className="px-4 py-3 font-medium text-slate-900">{it.description}</td>
                  <td className="px-4 py-3">{it.quantity.toLocaleString('en-GB')}</td>
                  <td className="px-4 py-3">{[it.size, it.orientation !== 'not_applicable' ? it.orientation : ''].filter(Boolean).join(', ') || '—'}</td>
                  <td className="px-4 py-3">{it.colour_mode === 'black_white' ? 'Black and white' : 'Full colour'}</td>
                  <td className="px-4 py-3">{[it.material, it.finishing].filter(Boolean).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </section>

      {uploads.length > 0 && (
        <section aria-labelledby="files">
          <h2 id="files" className="mb-3 text-base font-semibold text-slate-900">Files you sent</h2>
          <Card className="p-5"><FileList files={uploads} urls={urlByPath} /></Card>
        </section>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 text-slate-900">{value}</p>
    </div>
  );
}

function FileList({ files, urls }: { files: JobFileRow[]; urls: Map<string, string> }) {
  return (
    <ul className="divide-y divide-slate-100">
      {files.map((f) => {
        const url = urls.get(f.storage_path);
        return (
          <li key={f.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span className="min-w-0 truncate text-slate-900">{f.filename}</span>
            <span className="flex shrink-0 items-center gap-3 text-xs text-slate-500">
              {formatBytes(f.size_bytes)}
              {url ? (
                <a href={url} download={f.filename} className="font-medium text-brand hover:underline">Download</a>
              ) : (
                <span>Unavailable</span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
