import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTenant } from '@/lib/session';
import type { Org } from '@/lib/types';

export type StaffContext = {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  fullName: string;
  org: Org;
  roleKey: string;
  roleName: string;
  perms: Set<string>;
};

/** The signed-in staff member for this business, or null. Permissions come from the database, never from the browser. */
export async function getStaffContext(): Promise<StaffContext | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const org = await getTenant();
  if (!org) return null;

  const { data: member } = await supabase
    .from('org_members')
    .select('role_id, status, roles(key, name, is_staff)')
    .eq('org_id', org.id)
    .eq('user_id', user.id)
    .maybeSingle();
  const m = member as { role_id: string; status: string; roles: { key: string; name: string; is_staff: boolean } | { key: string; name: string; is_staff: boolean }[] | null } | null;
  if (!m || m.status !== 'active') return null;
  const role = Array.isArray(m.roles) ? m.roles[0] : m.roles;
  if (!role || !role.is_staff) return null;

  const [{ data: permRows }, { data: profile }] = await Promise.all([
    supabase.from('role_permissions').select('permission_key').eq('role_id', m.role_id),
    supabase.from('profiles').select('full_name').eq('user_id', user.id).maybeSingle(),
  ]);

  return {
    supabase,
    userId: user.id,
    fullName: (profile as { full_name: string } | null)?.full_name ?? '',
    org,
    roleKey: role.key,
    roleName: role.name,
    perms: new Set(((permRows ?? []) as { permission_key: string }[]).map((p) => p.permission_key)),
  };
}

export async function requireStaff(perm?: string): Promise<StaffContext> {
  const ctx = await getStaffContext();
  if (!ctx) redirect('/login?error=not_staff');
  if (perm && !ctx.perms.has(perm)) redirect('/admin/overview?err=forbidden');
  return ctx;
}
