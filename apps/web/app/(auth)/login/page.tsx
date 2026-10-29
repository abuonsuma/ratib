import Link from 'next/link';
import { signIn } from '@/app/actions/auth';
import { SubmitButton } from '@/components/submit-button';
import { Alert, Field, inputClass } from '@/components/ui';
import { getTenant } from '@/lib/session';

const MESSAGES: Record<string, string> = {
  missing: 'Enter your email and password.',
  invalid: 'The email or password is not correct.',
  link: 'That link has expired or was already used. Please try again.',
  not_a_member: 'This account is not registered with this business. Create an account to continue.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? MESSAGES[sp.error] : undefined;
  const next = typeof sp.next === 'string' ? sp.next : '';
  const org = await getTenant();

  return (
    <>
      <h1 className="mb-6 text-xl font-semibold text-slate-900">Sign in</h1>
      {!org && <Alert tone="warning">This website address is not linked to a business yet.</Alert>}
      {error && <div className="mb-4"><Alert tone="error">{error}</Alert></div>}
      <form action={signIn} className="space-y-4">
        <input type="hidden" name="next" value={next} />
        <Field label="Email" htmlFor="email">
          <input id="email" name="email" type="email" autoComplete="email" required className={inputClass} />
        </Field>
        <Field label="Password" htmlFor="password">
          <input id="password" name="password" type="password" autoComplete="current-password" required className={inputClass} />
        </Field>
        <SubmitButton pendingText="Signing in…">Sign in</SubmitButton>
      </form>
      <div className="mt-5 flex items-center justify-between text-sm">
        <Link href="/forgot-password" className="font-medium text-brand hover:underline">Forgot password?</Link>
        <Link href="/register" className="font-medium text-brand hover:underline">Create an account</Link>
      </div>
    </>
  );
}
