import Link from 'next/link';
import { signUp } from '@/app/actions/auth';
import { SubmitButton } from '@/components/submit-button';
import { Alert, Field, inputClass } from '@/components/ui';

const MESSAGES: Record<string, string> = {
  name: 'Enter your full name.',
  email: 'Enter a valid email address.',
  phone: 'Enter a valid phone number, for example 0244 000 000.',
  password: 'Your password must be at least 8 characters.',
  tenant: 'This website address is not linked to a business yet.',
  failed: 'We could not create your account. If you already have one, try signing in.',
};

export default async function RegisterPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? MESSAGES[sp.error] : undefined;

  if (sp.sent) {
    return (
      <>
        <h1 className="mb-3 text-xl font-semibold text-slate-900">Check your email</h1>
        <Alert tone="success">We sent you a link to confirm your email address. Open it, then sign in.</Alert>
        <p className="mt-5 text-sm"><Link href="/login" className="font-medium text-brand hover:underline">Go to sign in</Link></p>
      </>
    );
  }

  return (
    <>
      <h1 className="mb-6 text-xl font-semibold text-slate-900">Create your account</h1>
      {error && <div className="mb-4"><Alert tone="error">{error}</Alert></div>}
      <form action={signUp} className="space-y-4">
        <Field label="Full name" htmlFor="full_name">
          <input id="full_name" name="full_name" autoComplete="name" required minLength={2} className={inputClass} />
        </Field>
        <Field label="Email" htmlFor="email">
          <input id="email" name="email" type="email" autoComplete="email" required className={inputClass} />
        </Field>
        <Field label="Phone number" htmlFor="phone" hint="We use this to reach you about your jobs.">
          <input id="phone" name="phone" type="tel" autoComplete="tel" inputMode="tel" className={inputClass} />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 8 characters.">
          <input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} className={inputClass} />
        </Field>
        <p className="text-xs text-slate-500">By creating an account you agree that we store your name, contact details and job files to process your orders.</p>
        <SubmitButton pendingText="Creating account…">Create account</SubmitButton>
      </form>
      <p className="mt-5 text-sm text-slate-600">Already have an account? <Link href="/login" className="font-medium text-brand hover:underline">Sign in</Link></p>
    </>
  );
}
