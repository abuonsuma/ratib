import Link from 'next/link';
import { requireClient } from '@/lib/session';
import { DASHBOARD_GROUPS, statusTone } from '@/lib/workflow';
import { formatDate } from '@/lib/format';
import { Badge, Card, EmptyState, inputClass, LinkButton, buttonSecondary } from '@/components/ui';
import type { JobRow } from '@/lib/types';

type Row = Pick<JobRow, 'id' | 'job_ref' | 'title' | 'status' | 'due_date' | 'created_at'> & { workflow_stages: { label: string } | null };

export default async function JobsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { supabase } = await requireClient();
  const sp = await searchParams;
  // strip characters that have special meaning in the filter syntax
  const q = (typeof sp.q === 'string' ? sp.q : '').replace(/[,()%*\\]/g, ' ').trim().slice(0, 60);
  const group = typeof sp.group === 'string' ? sp.group : '';

  let query = supabase
    .from('jobs')
    .select('id, job_ref, title, status, due_date, created_at, workflow_stages!jobs_workflow_id_status_fkey(label)')
    .order('created_at', { ascending: false })
    .limit(100);
  if (q) query = query.or(`title.ilike.%${q}%,job_ref.ilike.%${q}%`);
  const g = DASHBOARD_GROUPS.find((x) => x.id === group);
  if (g) query = query.in('status', [...g.statuses]);
  else if (group === 'drafts') query = query.eq('status', 'draft');

  const { data } = await query;
  const jobs = (data ?? []) as unknown as Row[];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-slate-900">My jobs</h1>
        <LinkButton href="/portal/jobs/new">Start a new job</LinkButton>
      </div>

      <form className="flex flex-col gap-2 sm:flex-row" role="search">
        <label htmlFor="q" className="sr-only">Search jobs</label>
        <input id="q" name="q" defaultValue={q} placeholder="Search by title or job number" className={inputClass} />
        <label htmlFor="group" className="sr-only">Filter by status</label>
        <select id="group" name="group" defaultValue={group} className={`${inputClass} sm:w-64`}>
          <option value="">All jobs</option>
          <option value="drafts">Drafts</option>
          {DASHBOARD_GROUPS.map((x) => (
            <option key={x.id} value={x.id}>{x.label}</option>
          ))}
        </select>
        <button className={buttonSecondary}>Search</button>
      </form>

      {jobs.length === 0 ? (
        <EmptyState
          title={q || group ? 'No jobs match your search' : 'No jobs yet'}
          body={q || group ? 'Try a different word or clear the filter.' : 'When you submit a job it will show up here, and you can follow it step by step.'}
          action={q || group ? <Link href="/portal/jobs" className="text-sm font-medium text-brand hover:underline">Clear search</Link> : <LinkButton href="/portal/jobs/new">Start a new job</LinkButton>}
        />
      ) : (
        <Card className="divide-y divide-slate-100">
          {jobs.map((j) => (
            <Link key={j.id} href={j.status === 'draft' ? `/portal/jobs/new?draft=${j.id}` : `/portal/jobs/${j.id}`} className="flex items-center justify-between gap-3 px-4 py-3.5 hover:bg-slate-50">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-900">{j.title}</p>
                <p className="text-xs text-slate-500">
                  {j.job_ref ?? 'Not submitted yet'} · {j.due_date ? `needed by ${formatDate(j.due_date)}` : `created ${formatDate(j.created_at)}`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge tone={statusTone(j.status)}>{j.workflow_stages?.label ?? j.status}</Badge>
                {j.status === 'draft' && <span className="hidden text-xs font-medium text-brand sm:inline">Continue</span>}
              </div>
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}
