'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTenant, isStaffMember } from '@/lib/session';
import { safeNextPath, safeNextPathOrNull } from '@/lib/tenant';

function text(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}
function raw(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v : '';
}

async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export async function signIn(formData: FormData) {
  const email = text(formData, 'email').toLowerCase();
  const password = raw(formData, 'password');
  const requested = safeNextPathOrNull(text(formData, 'next'));
  const keep = requested ? `&next=${encodeURIComponent(requested)}` : '';
  if (!email || !password) redirect(`/login?error=missing${keep}`);

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  // one generic message for every failure so the form cannot be used to discover which emails have accounts
  if (error || !data.user) redirect(`/login?error=invalid${keep}`);
  if (requested) redirect(requested);

  // no page was asked for: staff land on their dashboard, clients on theirs
  const org = await getTenant();
  if (org && (await isStaffMember(supabase, data.user.id, org.id))) redirect('/admin/overview');
  redirect('/portal/dashboard');
}

export async function signUp(formData: FormData) {
  const full_name = text(formData, 'full_name');
  const email = text(formData, 'email').toLowerCase();
  const phone = text(formData, 'phone');
  const password = raw(formData, 'password');

  if (full_name.length < 2) redirect('/register?error=name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) redirect('/register?error=email');
  if (phone && !/^[+0-9 ()-]{7,20}$/.test(phone)) redirect('/register?error=phone');
  if (password.length < 8) redirect('/register?error=password');

  const org = await getTenant();
  if (!org) redirect('/register?error=tenant');

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      // org_slug comes from the server's own tenant lookup, never from the form
      data: { full_name, phone: phone || undefined, org_slug: org.slug },
      emailRedirectTo: `${await origin()}/auth/callback`,
    },
  });
  if (error) redirect('/register?error=failed');
  if (data.session) redirect('/portal/dashboard');
  redirect('/register?sent=1');
}

export async function requestPasswordReset(formData: FormData) {
  const email = text(formData, 'email').toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const supabase = await createClient();
    await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${await origin()}/auth/callback?next=/reset-password` });
  }
  // same answer whether or not the account exists
  redirect('/forgot-password?sent=1');
}

export async function updatePassword(formData: FormData) {
  const password = raw(formData, 'password');
  const confirm = raw(formData, 'confirm');
  if (password.length < 8) redirect('/reset-password?error=password');
  if (password !== confirm) redirect('/reset-password?error=mismatch');
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) redirect('/reset-password?error=failed');
  redirect('/portal/dashboard');
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
