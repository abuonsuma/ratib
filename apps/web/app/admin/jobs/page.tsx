import Link from 'next/link';
import { requireStaff } from '@/lib/staff-session';
import { statusTone } from '@/lib/workflow';
import { formatDate } from '@/lib/format';
import { Badge, Card, EmptyState, buttonSecondary, inputClass } from '@/components/ui';
import type { StaffJobRow } from '@/lib/staff';

const PAGE = 25;

export default async function AdminJobsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff('jobs.read');
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : '');
  const q = one('q').trim().slice(0, 60);
  const status = /^[a-z_]{2,40}$/.test(one('status')) ? one('status') : '';
  const assignee = /^[0-9a-f-]{36}$/i.test(one('assignee')) ? one('assignee') : '';
  const overdue = one('overdue') === '1';
  const page = Math.max(1, Math.min(1000, parseInt(one('page') || '1', 10) || 1));

  const canFilterByStaff = staff.perms.has('jobs.assign');
  const [{ data: rows }, { data: stageRows }, people] = await Promise.all([
    staff.supabase.rpc('staff_list_jobs', {
      p_org: staff.org.id, p_status: status ? [status] : null, p_q: q || null, p_assignee: assignee || null,
      p_overdue: overdue, p_limit: PAGE, p_offset: (page - 1) * PAGE,
    }),
    staff.supabase.from('workflow_stages').select('status_key, label, position').neq('status_key', 'draft').order('position'),
    canFilterByStaff ? staff.supabase.rpc('list_assignable_staff', { p_org: staff.org.id }) : Promise.resolve({ data: [] as unknown[] }),
  ]);
  const jobs = (rows ?? []) as StaffJobRow[];
  const total = jobs[0]?.total_count ?? 0;
  const stages = Array.from(new Map(((stageRows ?? []) as { status_key: string; label: string }[]).map((s) => [s.status_key, s.label])).entries());
  const staffList = (people.data ?? []) as { user_id: string; full_name: string }[];

  const qs = (p: number) => {
    const u = new URLSearchParams();
    if (q) u.set('q', q);
    if (status) u.set('status', status);
    if (assignee) u.set('assignee', assignee);
    if (overdue) u.set('overdue', '1');
    if (p > 1) u.set('page', String(p));
    const s = u.toString();
    return `/admin/jobs${s ? `?${s}` : ''}`;
  };
  const filtered = !!(q || status || assignee || overdue);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold text-slate-900">Jobs</h1>

      <form className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_200px_200px_auto_auto]" role="search">
        <label htmlFor="q" className="sr-only">Search</label>
        <input id="q" name="q" defaultValue={q} placeholder="Search job number, title or customer" className={inputClass} />
        <label htmlFor="status" className="sr-only">Stage</label>
        <select id="status" name="status" defaultValue={status} className={inputClass}>
          <option value="">All stages</option>
          {stages.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {canFilterByStaff ? (
          <>
            <label htmlFor="assignee" className="sr-only">Assigned to</label>
            <select id="assignee" name="assignee" defaultValue={assignee} className={inputClass}>
              <option value="">Anyone</option>
              {staffList.map((p) => <option key={p.user_id} value={p.user_id}>{p.full_name || 'Unnamed'}</option>)}
            </select>
          </>
        ) : <span />}
        <label className="flex items-center gap-2 px-1 text-sm text-slate-800">
          <input type="checkbox" name="overdue" value="1" defaultChecked={overdue} className="h-4 w-4 rounded border-slate-300" /> Overdue only
        </label>
        <button className={buttonSecondary}>Filter</button>
      </form>

      {jobs.length === 0 ? (
        <EmptyState title={filtered ? 'No jobs match' : 'No jobs yet'} body={filtered ? 'Try different filters.' : 'New jobs from clients will appear here.'} action={filtered ? <Link href="/admin/jobs" className="text-sm font-medium text-brand hover:underline">Clear filters</Link> : undefined} />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-2.5">Job</th>
                <th scope="col" className="px-4 py-2.5">Customer</th>
                <th scope="col" className="px-4 py-2.5">Stage</th>
                <th scope="col" className="px-4 py-2.5">Due</th>
                <th scope="col" className="px-4 py-2.5">Assigned to</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {jobs.map((j) => (
                <tr key={j.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link href={`/admin/jobs/${j.id}`} className="font-medium text-slate-900 hover:underline">{j.title}</Link>
                    <p className="text-xs text-slate-500">{j.job_ref}{j.priority === 'urgent' ? ' · URGENT' : ''}</p>
                  </td>
                  <td className="px-4 py-3">{j.customer_name}{j.company_name ? <span className="block text-xs text-slate-500">{j.company_name}</span> : null}</td>
                  <td className="px-4 py-3"><Badge tone={statusTone(j.status)}>{j.status_label}</Badge></td>
                  <td className={`px-4 py-3 ${j.is_overdue ? 'font-semibold text-red-700' : ''}`}>{j.due_date ? formatDate(j.due_date) : '—'}{j.is_overdue ? ' (overdue)' : ''}</td>
                  <td className="px-4 py-3 text-slate-700">{j.assignees || <span className="text-slate-400">Nobody yet</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {total > PAGE && (
        <nav aria-label="Pages" className="flex items-center justify-between text-sm">
          <span className="text-slate-600">Showing {(page - 1) * PAGE + 1}–{Math.min(page * PAGE, total)} of {total}</span>
          <span className="flex gap-2">
            {page > 1 && <Link href={qs(page - 1)} className={buttonSecondary}>Previous</Link>}
            {page * PAGE < total && <Link href={qs(page + 1)} className={buttonSecondary}>Next</Link>}
          </span>
        </nav>
      )}
    </div>
  );
}
