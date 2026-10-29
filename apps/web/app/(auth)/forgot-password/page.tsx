import Link from 'next/link';
import { requestPasswordReset } from '@/app/actions/auth';
import { SubmitButton } from '@/components/submit-button';
import { Alert, Field, inputClass } from '@/components/ui';

export default async function ForgotPasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  return (
    <>
      <h1 className="mb-2 text-xl font-semibold text-slate-900">Reset your password</h1>
      <p className="mb-6 text-sm text-slate-600">Enter your email and we will send you a link to choose a new password.</p>
      {sp.sent ? (
        <Alert tone="success">If an account exists for that email, a reset link is on its way.</Alert>
      ) : (
        <form action={requestPasswordReset} className="space-y-4">
          <Field label="Email" htmlFor="email">
            <input id="email" name="email" type="email" autoComplete="email" required className={inputClass} />
          </Field>
          <SubmitButton pendingText="Sending…">Send reset link</SubmitButton>
        </form>
      )}
      <p className="mt-5 text-sm"><Link href="/login" className="font-medium text-brand hover:underline">Back to sign in</Link></p>
    </>
  );
}
