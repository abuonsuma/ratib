'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type Item = { href: string; label: string; badge?: number };

function isActive(path: string, href: string) {
  return path === href || path.startsWith(`${href}/`);
}

export function AdminSidebar({ items }: { items: Item[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="hidden flex-col gap-1 md:flex">
      {items.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          aria-current={isActive(path, i.href) ? 'page' : undefined}
          className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium ${isActive(path, i.href) ? 'bg-brand text-white' : 'text-slate-700 hover:bg-slate-100'}`}
        >
          {i.label}
          {!!i.badge && <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${isActive(path, i.href) ? 'bg-white text-brand' : 'bg-brand text-white'}`}>{i.badge}</span>}
        </Link>
      ))}
    </nav>
  );
}

export function AdminTabs({ items }: { items: Item[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-2 py-2 md:hidden">
      {items.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          aria-current={isActive(path, i.href) ? 'page' : undefined}
          className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium ${isActive(path, i.href) ? 'bg-brand text-white' : 'text-slate-700'}`}
        >
          {i.label}
          {!!i.badge && <span className="ml-1.5 rounded-full bg-slate-900/80 px-1.5 text-[10px] font-semibold text-white">{i.badge}</span>}
        </Link>
      ))}
    </nav>
  );
}
