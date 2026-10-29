import { getTenant } from '@/lib/session';
import { hexToRgbTriplet } from '@/lib/format';

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const org = await getTenant();
  return (
    <div style={{ ['--brand' as string]: hexToRgbTriplet(org?.primary_color) }} className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-brand text-xl font-bold text-white">{(org?.name ?? 'P').charAt(0)}</span>
          <p className="text-lg font-semibold text-slate-900">{org?.name ?? 'Client Portal'}</p>
          <p className="text-sm text-slate-600">Submit jobs, upload files and track progress, without waiting on WhatsApp.</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">{children}</div>
      </div>
    </div>
  );
}
