import Link from 'next/link';
import { requireClient } from '@/lib/session';
import { hexToRgbTriplet } from '@/lib/format';
import { BottomNav, TopNav } from '@/components/nav';
import { signOut } from '@/app/actions/auth';
import { buttonSecondary } from '@/components/ui';

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const { supabase, userId, org } = await requireClient();
  const { count } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', userId).is('read_at', null);
  const unread = count ?? 0;

  const items = [
    { href: '/portal/dashboard', label: 'Home' },
    { href: '/portal/jobs', label: 'My jobs' },
    { href: '/portal/jobs/new', label: 'New job' },
    { href: '/portal/notifications', label: 'Alerts', badge: unread || undefined },
    { href: '/portal/settings', label: 'Account' },
  ];

  return (
    <div style={{ ['--brand' as string]: hexToRgbTriplet(org.primary_color) }} className="min-h-screen pb-20 md:pb-0">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
          <Link href="/portal/dashboard" className="flex items-center gap-2 font-semibold text-slate-900">
            {org.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={org.logo_url} alt="" className="h-7 w-7 rounded object-contain" />
            ) : (
              <span className="flex h-7 w-7 items-center justify-center rounded bg-brand text-sm font-bold text-white">{org.name.charAt(0)}</span>
            )}
            <span className="truncate">{org.name}</span>
          </Link>
          <TopNav items={items} />
          <form action={signOut} className="hidden md:block">
            <button className={`${buttonSecondary} !px-3 !py-1.5`}>Sign out</button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      <BottomNav items={items} />
    </div>
  );
}
