import { requireStaff } from '@/lib/staff-session';
import { okMessage, staffErrorMessage } from '@/lib/staff';
import { savePaymentGate } from '@/app/actions/staff';
import { SubmitButton } from '@/components/submit-button';
import { Alert, Card } from '@/components/ui';

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff('settings.manage');
  const sp = await searchParams;
  const { data } = await staff.supabase.from('business_settings').select('value').eq('org_id', staff.org.id).eq('key', 'enforce_payment_gate').maybeSingle();
  const gateOn = ((data as { value: boolean } | null)?.value ?? true) !== false;
  const ok = okMessage(typeof sp.ok === 'string' ? sp.ok : null);
  const err = typeof sp.err === 'string' ? staffErrorMessage(sp.err) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>
      {ok && <Alert tone="success">{ok}</Alert>}
      {err && <Alert tone="error">{err}</Alert>}
      <Card className="p-5">
        <form action={savePaymentGate} className="space-y-4">
          <h2 className="text-base font-semibold text-slate-900">Payment before production</h2>
          <p className="text-sm text-slate-600">
            When this is on, a job cannot enter Queued for Production, In Production, Quality Check, Ready, Out for Delivery or Completed until someone with payment rights has used
            &ldquo;Payment Confirmed&rdquo; on it. Turn it off only if your business starts work on credit.
          </p>
          <fieldset className="space-y-2 text-sm text-slate-800">
            <legend className="sr-only">Payment before production</legend>
            <label className="flex items-center gap-2"><input type="radio" name="enabled" value="true" defaultChecked={gateOn} /> Require confirmed payment (recommended)</label>
            <label className="flex items-center gap-2"><input type="radio" name="enabled" value="false" defaultChecked={!gateOn} /> Allow production without confirmed payment</label>
          </fieldset>
          <SubmitButton pendingText="Saving…" className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">Save</SubmitButton>
        </form>
      </Card>
    </div>
  );
}
