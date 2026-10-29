'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type Item = { href: string; label: string; badge?: number };

function active(path: string, href: string) {
  return path === href || (href !== '/portal/dashboard' && path.startsWith(href) && !(href === '/portal/jobs' && path.startsWith('/portal/jobs/new')));
}

export function TopNav({ items }: { items: Item[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="hidden gap-1 md:flex">
      {items.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          aria-current={active(path, i.href) ? 'page' : undefined}
          className={`relative rounded-lg px-3 py-2 text-sm font-medium ${active(path, i.href) ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}
        >
          {i.label}
          {!!i.badge && <span className="ml-1.5 rounded-full bg-brand px-1.5 py-0.5 text-[10px] font-semibold text-white">{i.badge}</span>}
        </Link>
      ))}
    </nav>
  );
}

export function BottomNav({ items }: { items: Item[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden">
      <ul className="grid grid-cols-5">
        {items.map((i) => (
          <li key={i.href}>
            <Link
              href={i.href}
              aria-current={active(path, i.href) ? 'page' : undefined}
              className={`relative flex min-h-14 flex-col items-center justify-center text-[11px] font-medium ${active(path, i.href) ? 'text-brand' : 'text-slate-500'}`}
            >
              {i.label}
              {!!i.badge && <span className="absolute right-4 top-1.5 rounded-full bg-brand px-1.5 text-[10px] font-semibold text-white">{i.badge}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
