import { updatePassword } from '@/app/actions/auth';
import { SubmitButton } from '@/components/submit-button';
import { Alert, Field, inputClass } from '@/components/ui';

const MESSAGES: Record<string, string> = {
  password: 'Your password must be at least 8 characters.',
  mismatch: 'The two passwords do not match.',
  failed: 'We could not update your password. Request a new reset link and try again.',
};

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? MESSAGES[sp.error] : undefined;
  return (
    <>
      <h1 className="mb-6 text-xl font-semibold text-slate-900">Choose a new password</h1>
      {error && <div className="mb-4"><Alert tone="error">{error}</Alert></div>}
      <form action={updatePassword} className="space-y-4">
        <Field label="New password" htmlFor="password" hint="At least 8 characters.">
          <input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} className={inputClass} />
        </Field>
        <Field label="Confirm new password" htmlFor="confirm">
          <input id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={8} className={inputClass} />
        </Field>
        <SubmitButton pendingText="Saving…">Save password</SubmitButton>
      </form>
    </>
  );
}
