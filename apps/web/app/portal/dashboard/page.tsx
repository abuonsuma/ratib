import Link from 'next/link';
import { requireClient } from '@/lib/session';
import { countByGroup, DASHBOARD_GROUPS, statusTone } from '@/lib/workflow';
import { formatDate, formatDateTime, ownerFirstName } from '@/lib/format';
import { Badge, Card, EmptyState, LinkButton } from '@/components/ui';
import type { JobRow, NotificationRow } from '@/lib/types';

type JobSummary = Pick<JobRow, 'id' | 'job_ref' | 'title' | 'status' | 'due_date' | 'created_at'> & { workflow_stages: { label: string } | null };

export default async function DashboardPage() {
  const { supabase, userId, customer } = await requireClient();

  const { data: jobData } = await supabase
    .from('jobs')
    .select('id, job_ref, title, status, due_date, created_at, workflow_stages!jobs_workflow_id_status_fkey(label)')
    .order('created_at', { ascending: false })
    .limit(500);
  const jobs = (jobData ?? []) as unknown as JobSummary[];

  const { data: noteData } = await supabase
    .from('notifications')
    .select('id, type, title, body, link, read_at, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(5);
  const notes = (noteData ?? []) as NotificationRow[];

  const counts = countByGroup(jobs.map((j) => j.status));
  const recent = jobs.filter((j) => j.status !== 'draft').slice(0, 5);
  const drafts = jobs.filter((j) => j.status === 'draft');

  const cards: { label: string; value: number; href: string }[] = [
    { label: 'Jobs submitted', value: counts.total, href: '/portal/jobs' },
    ...DASHBOARD_GROUPS.map((g) => ({ label: g.label, value: counts[g.id], href: `/portal/jobs?group=${g.id}` })),
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Hello, {ownerFirstName(customer.name)}</h1>
          <p className="text-sm text-slate-600">Here is where your jobs stand today.</p>
        </div>
        <LinkButton href="/portal/jobs/new">Start a new job</LinkButton>
      </div>

      {drafts.length > 0 && (
        <Card className="border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            You have {drafts.length} unfinished {drafts.length === 1 ? 'draft' : 'drafts'}.{' '}
            <Link href={`/portal/jobs/new?draft=${drafts[0].id}`} className="underline">Continue &ldquo;{drafts[0].title}&rdquo;</Link>
          </p>
        </Card>
      )}

      <section aria-label="Job summary" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {cards.map((c) => (
          <Link key={c.label} href={c.href} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300">
            <p className="text-3xl font-semibold text-slate-900">{c.value}</p>
            <p className="mt-1 text-xs font-medium leading-snug text-slate-600">{c.label}</p>
          </Link>
        ))}
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="lg:col-span-2" aria-labelledby="recent-jobs">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="recent-jobs" className="text-base font-semibold text-slate-900">Recent jobs</h2>
            <Link href="/portal/jobs" className="text-sm font-medium text-brand hover:underline">See all</Link>
          </div>
          {recent.length === 0 ? (
            <EmptyState title="No jobs yet" body="Submit your first job in a few minutes. No need to message anyone." action={<LinkButton href="/portal/jobs/new">Start a new job</LinkButton>} />
          ) : (
            <Card className="divide-y divide-slate-100">
              {recent.map((j) => (
                <Link key={j.id} href={`/portal/jobs/${j.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">{j.title}</p>
                    <p className="text-xs text-slate-500">{j.job_ref} · submitted {formatDate(j.created_at)}</p>
                  </div>
                  <Badge tone={statusTone(j.status)}>{j.workflow_stages?.label ?? j.status}</Badge>
                </Link>
              ))}
            </Card>
          )}
        </section>

        <section aria-labelledby="recent-activity">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="recent-activity" className="text-base font-semibold text-slate-900">Recent activity</h2>
            <Link href="/portal/notifications" className="text-sm font-medium text-brand hover:underline">All alerts</Link>
          </div>
          {notes.length === 0 ? (
            <Card className="p-4 text-sm text-slate-600">Updates about your jobs will appear here.</Card>
          ) : (
            <Card className="divide-y divide-slate-100">
              {notes.map((n) => (
                <Link key={n.id} href={n.link ?? '/portal/notifications'} className="block px-4 py-3 hover:bg-slate-50">
                  <p className={`text-sm ${n.read_at ? 'text-slate-700' : 'font-semibold text-slate-900'}`}>{n.title}</p>
                  <p className="text-xs text-slate-500">{formatDateTime(n.created_at)}</p>
                </Link>
              ))}
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}
