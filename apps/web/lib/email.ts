// Builds the email for a queued message. Pure functions, so they can be tested without a mail server.

export type EmailPayload = {
  org_name?: string;
  job_ref?: string;
  title?: string;
  status_label?: string;
  note?: string | null;
  link?: string;
};

export type BuiltEmail = { subject: string; text: string; html: string };

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Subjects must be one line: a newline here is how header injection starts. */
export function singleLine(s: string, max = 200): string {
  return s.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

/** Links in emails must point at our own site, whatever the stored payload says. */
export function absoluteUrl(link: string | undefined, siteUrl: string): string {
  const base = new URL(siteUrl);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error('invalid_site_url');
  const fallback = new URL('/portal/dashboard', base).toString();
  if (!link) return fallback;
  try {
    const u = new URL(link, base);
    return u.origin === base.origin ? u.toString() : fallback;
  } catch {
    return fallback;
  }
}

export function buildEmail(template: string, payload: EmailPayload, siteUrl: string): BuiltEmail {
  const org = singleLine(payload.org_name || 'Our team', 120);
  const ref = singleLine(payload.job_ref || 'Your job', 40);
  const title = singleLine(payload.title || '', 200);
  const link = absoluteUrl(payload.link, siteUrl);
  const note = payload.note ? payload.note.trim().slice(0, 1000) : '';
  const footer = 'You can turn these emails off in your account settings. You will still see every update in the portal.';

  let subject: string;
  let lead: string;
  if (template === 'job_submitted') {
    subject = `${ref} received`;
    lead = `We have received your job "${title}" (${ref}). Our team will review it and tell you what happens next.`;
  } else if (template === 'job_status') {
    const label = singleLine(payload.status_label || 'Updated', 80);
    subject = `${ref}: ${label}`;
    lead = `Your job "${title}" (${ref}) is now: ${label}.`;
  } else {
    throw new Error(`unknown_template:${template}`);
  }

  const text = [lead, note && `Message from ${org}:\n${note}`, `See full progress: ${link}`, footer, `${org}`].filter(Boolean).join('\n\n');

  const html = `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px">
<tr><td style="padding:24px">
<p style="margin:0 0 4px;font-size:13px;color:#64748b">${escapeHtml(org)}</p>
<h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(subject)}</h1>
<p style="margin:0 0 16px;font-size:15px;line-height:1.5">${escapeHtml(lead)}</p>
${note ? `<p style="margin:0 0 16px;padding:12px;background:#f1f5f9;border-radius:8px;font-size:15px;line-height:1.5">${escapeHtml(note).replace(/\n/g, '<br>')}</p>` : ''}
<p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:15px;font-weight:bold">View my job</a></p>
<p style="margin:0;font-size:12px;color:#64748b;line-height:1.5">${escapeHtml(footer)}</p>
</td></tr></table></td></tr></table></body></html>`;

  return { subject: singleLine(subject), text, html };
}
