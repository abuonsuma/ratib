import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { buildEmail, type EmailPayload } from '@/lib/email';
import { createResendSender } from '@/lib/resend';
import { processOutbox, type OutboxRow } from '@/lib/outbox';

export const dynamic = 'force-dynamic';

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false; // refuse to run with a missing or weak secret
  const given = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function run(request: Request) {
  if (!authorised(request)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (!apiKey || !from || !siteUrl || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    // checked before claiming anything, so nothing is left half-sent
    return NextResponse.json({ error: 'email_not_configured' }, { status: 503 });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc('claim_outbox', { p_limit: 25 });
  if (error) return NextResponse.json({ error: 'claim_failed' }, { status: 500 });
  const rows = (data ?? []) as OutboxRow[];

  const send = createResendSender({ apiKey, from });
  const result = await processOutbox(rows, {
    render: (row) => buildEmail(row.template, row.payload as EmailPayload, siteUrl),
    send,
    markSent: async (id) => {
      const { error: e } = await supabase.rpc('mark_outbox_sent', { p_id: id });
      if (e) throw new Error(e.message);
    },
    markFailed: async (id, message) => {
      const { error: e } = await supabase.rpc('mark_outbox_failed', { p_id: id, p_error: message });
      if (e) throw new Error(e.message);
    },
  });

  return NextResponse.json({ claimed: rows.length, ...result });
}

export const GET = run;
export const POST = run;
