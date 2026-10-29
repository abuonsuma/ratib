// Sends one email through Resend's HTTP API. The fetch function is injectable so the behaviour can be tested offline.

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type OutgoingEmail = { to: string; subject: string; html: string; text: string; idempotencyKey?: string };

export function createResendSender(opts: { apiKey: string; from: string; fetchImpl?: FetchLike }) {
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  return async function send(email: OutgoingEmail): Promise<void> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    };
    // lets the provider drop a repeat of the same message if we crash between sending and recording it
    if (email.idempotencyKey) headers['Idempotency-Key'] = email.idempotencyKey.slice(0, 256);

    const res = await doFetch('https://api.resend.com/emails', {
      method: 'POST',
      headers,
      body: JSON.stringify({ from: opts.from, to: [email.to], subject: email.subject, html: email.html, text: email.text }),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`Resend ${res.status}: ${body}`);
    }
  };
}
