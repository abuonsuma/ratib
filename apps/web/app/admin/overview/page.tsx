import Link from 'next/link';
import { requireStaff } from '@/lib/staff-session';
import { statusTone } from '@/lib/workflow';
import { formatDate } from '@/lib/format';
import { Alert, Badge, Card, EmptyState } from '@/components/ui';
import type { StaffJobRow } from '@/lib/staff';

type Overview = { received_today: number; active: number; overdue: number; awaiting_approval: number; awaiting_payment: number; ready: number; completed_30d: number };

export default async function OverviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff('jobs.read');
  const sp = await searchParams;
  const { supabase, org } = staff;

  const [{ data: ov }, { data: fresh }, { data: late }] = await Promise.all([
    supabase.rpc('staff_overview', { p_org: org.id }),
    supabase.rpc('staff_list_jobs', { p_org: org.id, p_status: ['submitted'], p_limit: 5 }),
    supabase.rpc('staff_list_jobs', { p_org: org.id, p_overdue: true, p_limit: 5 }),
  ]);
  const o = ((ov as Overview[] | null)?.[0] ?? { received_today: 0, active: 0, overdue: 0, awaiting_approval: 0, awaiting_payment: 0, ready: 0, completed_30d: 0 }) as Overview;
  const newJobs = (fresh ?? []) as StaffJobRow[];
  const lateJobs = (late ?? []) as StaffJobRow[];
  const seesAll = staff.perms.has('jobs.read_all');

  const cards = [
    { label: 'Received today', value: o.received_today, href: '/admin/jobs?status=submitted' },
    { label: 'Active jobs', value: o.active, href: '/admin/jobs' },
    { label: 'Overdue', value: o.overdue, href: '/admin/jobs?overdue=1', warn: o.overdue > 0 },
    { label: 'Awaiting client approval', value: o.awaiting_approval, href: '/admin/jobs?status=awaiting_client_approval' },
    { label: 'Awaiting payment', value: o.awaiting_payment, href: '/admin/jobs?status=awaiting_payment' },
    { label: 'Ready for collection or delivery', value: o.ready, href: '/admin/jobs?status=ready_for_collection' },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Overview</h1>
        <p className="text-sm text-slate-600">{seesAll ? 'All jobs in the business.' : 'Jobs assigned to you.'} {o.completed_30d} completed in the last 30 days.</p>
      </div>
      {sp.err === 'forbidden' && <Alert tone="error">You do not have access to that page.</Alert>}

      <section aria-label="Summary" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {cards.map((c) => (
          <Link key={c.label} href={c.href} className={`rounded-xl border bg-white p-4 shadow-sm transition hover:border-slate-300 ${c.warn ? 'border-red-300' : 'border-slate-200'}`}>
            <p className={`text-3xl font-semibold ${c.warn ? 'text-red-700' : 'text-slate-900'}`}>{c.value}</p>
            <p className="mt-1 text-xs font-medium leading-snug text-slate-600">{c.label}</p>
          </Link>
        ))}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <JobList title="New jobs to review" jobs={newJobs} empty="Nothing waiting for review." href="/admin/jobs?status=submitted" />
        <JobList title="Overdue" jobs={lateJobs} empty="No overdue jobs." href="/admin/jobs?overdue=1" />
      </div>
    </div>
  );
}

function JobList({ title, jobs, empty, href }: { title: string; jobs: StaffJobRow[]; empty: string; href: string }) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <Link href={href} className="text-sm font-medium text-brand hover:underline">See all</Link>
      </div>
      {jobs.length === 0 ? (
        <EmptyState title={empty} body="This list updates as work comes in." />
      ) : (
        <Card className="divide-y divide-slate-100">
          {jobs.map((j) => (
            <Link key={j.id} href={`/admin/jobs/${j.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-900">{j.title}</p>
                <p className="truncate text-xs text-slate-500">{j.job_ref} · {j.company_name || j.customer_name}{j.due_date ? ` · due ${formatDate(j.due_date)}` : ''}</p>
              </div>
              <Badge tone={statusTone(j.status)}>{j.status_label}</Badge>
            </Link>
          ))}
        </Card>
      )}
    </section>
  );
}
