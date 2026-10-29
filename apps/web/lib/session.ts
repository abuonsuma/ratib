import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { resolveOrgSlug } from '@/lib/tenant';
import type { CustomerRow, Org } from '@/lib/types';

/** The business this request belongs to, decided from the host name on the server. */
export async function getTenant(): Promise<Org | null> {
  const host = (await headers()).get('host');
  const slug = resolveOrgSlug(host, {
    defaultSlug: process.env.NEXT_PUBLIC_DEFAULT_ORG_SLUG,
    rootDomain: process.env.NEXT_PUBLIC_ROOT_DOMAIN,
  });
  if (!slug) return null;
  const supabase = await createClient();
  const { data } = await supabase.rpc('get_org_public', { p_slug: slug });
  return ((data as Org[] | null)?.[0] ?? null) as Org | null;
}

export type ClientContext = {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  email: string;
  org: Org;
  customer: CustomerRow;
};

/** For server actions: returns null instead of redirecting when the session is missing or not a client of this business. */
export async function getClientContext(): Promise<ClientContext | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const org = await getTenant();
  if (!org) return null;
  const { data: customer } = await supabase
    .from('customers')
    .select('id, org_id, name, email, phone, company_name')
    .eq('org_id', org.id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!customer) return null;
  return { supabase, userId: user.id, email: user.email ?? '', org, customer: customer as CustomerRow };
}

/** Is this user an active staff member of the business? */
export async function isStaffMember(supabase: Awaited<ReturnType<typeof createClient>>, userId: string, orgId: string): Promise<boolean> {
  const { data } = await supabase
    .from('org_members')
    .select('status, roles(is_staff)')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  const row = data as { status: string; roles: { is_staff: boolean } | { is_staff: boolean }[] | null } | null;
  if (!row || row.status !== 'active') return false;
  const role = Array.isArray(row.roles) ? row.roles[0] : row.roles;
  return !!role?.is_staff;
}

/** For pages: redirects to sign-in when needed. Staff are sent to their own dashboard. */
export async function requireClient(): Promise<ClientContext> {
  const ctx = await getClientContext();
  if (ctx) return ctx;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const org = await getTenant();
  if (user && org && (await isStaffMember(supabase, user.id, org.id))) redirect('/admin/overview');
  redirect('/login?error=not_a_member');
}
