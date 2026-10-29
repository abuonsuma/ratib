import Link from 'next/link';
import { requireStaff } from '@/lib/staff-session';
import { hexToRgbTriplet } from '@/lib/format';
import { AdminSidebar, AdminTabs } from '@/components/admin-nav';
import { signOut } from '@/app/actions/auth';
import { buttonSecondary } from '@/components/ui';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const staff = await requireStaff();
  const { count } = await staff.supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', staff.userId).is('read_at', null);

  const items = [
    { href: '/admin/overview', label: 'Overview' },
    { href: '/admin/jobs', label: 'Jobs' },
    { href: '/admin/notifications', label: 'Alerts', badge: count || undefined },
    ...(staff.perms.has('settings.manage') ? [{ href: '/admin/settings', label: 'Settings' }] : []),
  ];

  return (
    <div style={{ ['--brand' as string]: hexToRgbTriplet(staff.org.primary_color) }} className="min-h-screen md:flex">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white p-4 md:flex">
        <Link href="/admin/overview" className="mb-6 flex items-center gap-2 font-semibold text-slate-900">
          <span className="flex h-8 w-8 items-center justify-center rounded bg-brand text-sm font-bold text-white">{staff.org.name.charAt(0)}</span>
          <span className="truncate">{staff.org.name}</span>
        </Link>
        <AdminSidebar items={items} />
        <div className="mt-auto space-y-2 border-t border-slate-200 pt-4">
          <p className="truncate text-sm font-medium text-slate-900">{staff.fullName || 'Staff'}</p>
          <p className="text-xs text-slate-500">{staff.roleName}</p>
          <form action={signOut}><button className={`${buttonSecondary} w-full !py-1.5`}>Sign out</button></form>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 md:hidden">
          <span className="truncate font-semibold text-slate-900">{staff.org.name}</span>
          <form action={signOut}><button className="text-sm font-medium text-brand">Sign out</button></form>
        </header>
        <AdminTabs items={items} />
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      </div>
    </div>
  );
}
