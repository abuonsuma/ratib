'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireClient } from '@/lib/session';

function text(fd: FormData, key: string, max: number): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export async function updateProfile(formData: FormData) {
  const ctx = await requireClient();
  const name = text(formData, 'full_name', 120);
  const phone = text(formData, 'phone', 20);
  const company = text(formData, 'company_name', 120);

  if (name.length < 2) redirect('/portal/settings?error=name');
  if (phone && !/^[+0-9 ()-]{7,20}$/.test(phone)) redirect('/portal/settings?error=phone');

  // column-level grants in the database allow clients to change only these fields
  const p = await ctx.supabase.from('profiles').update({ full_name: name, phone: phone || null }).eq('user_id', ctx.userId);
  const c = await ctx.supabase
    .from('customers')
    .update({ name, phone: phone || null, company_name: company || null })
    .eq('id', ctx.customer.id);
  if (p.error || c.error) redirect('/portal/settings?error=failed');

  revalidatePath('/portal', 'layout');
  redirect('/portal/settings?saved=1');
}

export async function markAllNotificationsRead() {
  const ctx = await requireClient();
  await ctx.supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('user_id', ctx.userId).is('read_at', null);
  revalidatePath('/portal', 'layout');
}

export async function setEmailPreference(formData: FormData) {
  const ctx = await requireClient();
  const enabled = formData.get('email_enabled') === 'on';
  const { error } = await ctx.supabase
    .from('notification_preferences')
    .upsert({ user_id: ctx.userId, email_enabled: enabled, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) redirect('/portal/settings?error=failed');
  revalidatePath('/portal/settings');
  redirect('/portal/settings?saved=1');
}
