import { requireClient } from '@/lib/session';
import { setEmailPreference, updateProfile } from '@/app/actions/account';
import { signOut } from '@/app/actions/auth';
import { SubmitButton } from '@/components/submit-button';
import { Alert, Card, Field, buttonSecondary, inputClass } from '@/components/ui';

const MESSAGES: Record<string, string> = {
  name: 'Enter your full name.',
  phone: 'Enter a valid phone number, for example 0244 000 000.',
  failed: 'We could not save your changes. Please try again.',
};

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { customer, email, supabase, userId } = await requireClient();
  const { data: pref } = await supabase.from('notification_preferences').select('email_enabled').eq('user_id', userId).maybeSingle();
  const emailOn = (pref as { email_enabled: boolean } | null)?.email_enabled ?? true;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? MESSAGES[sp.error] : undefined;

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <h1 className="text-2xl font-semibold text-slate-900">Your account</h1>
      {sp.saved && <Alert tone="success">Your details were saved.</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
      <Card className="p-5">
        <form action={updateProfile} className="space-y-4">
          <Field label="Full name" htmlFor="full_name">
            <input id="full_name" name="full_name" defaultValue={customer.name} required minLength={2} className={inputClass} />
          </Field>
          <Field label="Email" htmlFor="email" hint="To change your email, contact the business.">
            <input id="email" value={email} readOnly disabled className={`${inputClass} bg-slate-50 text-slate-500`} />
          </Field>
          <Field label="Phone number" htmlFor="phone">
            <input id="phone" name="phone" type="tel" inputMode="tel" defaultValue={customer.phone ?? ''} className={inputClass} />
          </Field>
          <Field label="Company (optional)" htmlFor="company_name">
            <input id="company_name" name="company_name" defaultValue={customer.company_name ?? ''} className={inputClass} />
          </Field>
          <SubmitButton pendingText="Saving…">Save changes</SubmitButton>
        </form>
      </Card>
      <Card className="p-5">
        <form action={setEmailPreference} className="space-y-3">
          <h2 className="text-base font-semibold text-slate-900">Email updates</h2>
          <label className="flex items-start gap-3 text-sm text-slate-800">
            <input type="checkbox" name="email_enabled" defaultChecked={emailOn} className="mt-0.5 h-4 w-4 rounded border-slate-300" />
            <span>Email me when my job changes status. You will always see every update in the portal.</span>
          </label>
          <SubmitButton pendingText="Saving…" className={buttonSecondary}>Save email choice</SubmitButton>
        </form>
      </Card>
      <form action={signOut}>
        <button className={`${buttonSecondary} w-full`}>Sign out</button>
      </form>
    </div>
  );
}
