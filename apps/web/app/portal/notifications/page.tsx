import Link from 'next/link';
import { requireClient } from '@/lib/session';
import { markAllNotificationsRead } from '@/app/actions/account';
import { formatDateTime } from '@/lib/format';
import { Card, EmptyState, buttonSecondary } from '@/components/ui';
import type { NotificationRow } from '@/lib/types';

export default async function NotificationsPage() {
  const { supabase, userId } = await requireClient();
  const { data } = await supabase
    .from('notifications')
    .select('id, type, title, body, link, read_at, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);
  const notes = (data ?? []) as NotificationRow[];
  const unread = notes.filter((n) => !n.read_at).length;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-slate-900">Alerts</h1>
        {unread > 0 && (
          <form action={markAllNotificationsRead}>
            <button className={buttonSecondary}>Mark all as read</button>
          </form>
        )}
      </div>
      {notes.length === 0 ? (
        <EmptyState title="Nothing here yet" body="We will tell you here when a job is received, needs your approval, or is ready." />
      ) : (
        <Card className="divide-y divide-slate-100">
          {notes.map((n) => (
            <Link key={n.id} href={n.link ?? '/portal/dashboard'} className="flex items-start gap-3 px-4 py-3.5 hover:bg-slate-50">
              <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read_at ? 'bg-transparent' : 'bg-brand'}`} />
              <div className="min-w-0">
                <p className={`text-sm ${n.read_at ? 'text-slate-700' : 'font-semibold text-slate-900'}`}>
                  {n.title}
                  {!n.read_at && <span className="sr-only"> (unread)</span>}
                </p>
                {n.body && <p className="text-sm text-slate-600">{n.body}</p>}
                <p className="mt-0.5 text-xs text-slate-500">{formatDateTime(n.created_at)}</p>
              </div>
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}
