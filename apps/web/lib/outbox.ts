// Works through a batch of claimed outbox rows. All outside effects are injected, so this is fully testable.

export type OutboxRow = {
  id: string;
  to_email: string;
  template: string;
  payload: Record<string, unknown>;
  dedupe_key: string;
  attempts: number;
};

export type OutboxDeps = {
  render(row: OutboxRow): { subject: string; html: string; text: string };
  send(email: { to: string; subject: string; html: string; text: string; idempotencyKey: string }): Promise<void>;
  markSent(id: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
};

export type OutboxResult = { sent: number; failed: number; warnings: string[] };

export async function processOutbox(rows: OutboxRow[], deps: OutboxDeps): Promise<OutboxResult> {
  const result: OutboxResult = { sent: 0, failed: 0, warnings: [] };

  for (const row of rows) {
    try {
      const built = deps.render(row);
      await deps.send({ to: row.to_email, ...built, idempotencyKey: row.dedupe_key });
    } catch (e) {
      result.failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      try {
        await deps.markFailed(row.id, message);
      } catch (e2) {
        result.warnings.push(`could not record failure for ${row.id}: ${e2 instanceof Error ? e2.message : String(e2)}`);
      }
      continue;
    }

    result.sent += 1;
    try {
      await deps.markSent(row.id);
    } catch (e) {
      // the email went out; the row will be reclaimed later and the provider's idempotency key guards against a repeat
      result.warnings.push(`sent but could not record ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}
