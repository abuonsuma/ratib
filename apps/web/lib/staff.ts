// Pure helpers for the staff screens (no framework imports, so they are easy to test).

export type NextOption = { status_key: string; label: string; allowed: boolean; reason: string | null };

export type Activity = {
  customer: { name: string; company_name: string | null; email: string | null; phone: string | null } | null;
  assignees: { user_id: string; full_name: string; role_on_job: string }[];
  history: { id: string; from_status: string | null; to_status: string; label: string; client_note: string | null; internal_note: string | null; actor_name: string; created_at: string }[];
  notes: { id: string; body: string; author_name: string; created_at: string }[];
  controls: { approved_at?: string | null; approval_note?: string | null; payment_cleared_at?: string | null; payment_note?: string | null };
};

export type StaffJobRow = {
  id: string; job_ref: string | null; title: string; status: string; status_label: string; priority: string;
  due_date: string | null; estimated_completion: string | null; submitted_at: string | null;
  customer_name: string; company_name: string | null; assignees: string | null; is_overdue: boolean; total_count: number;
};

/** Why a stage is greyed out, in plain words. */
const REASONS: Record<string, string> = {
  payment_required: 'payment not confirmed yet',
  approval_required: 'client approval not recorded yet',
  restricted_stage: 'needs a manager or accountant',
  reopen_forbidden: 'only a manager can reopen a finished job',
  forbidden: 'you cannot change this job',
  draft_not_allowed: 'not available',
};

export function reasonText(code: string | null | undefined): string {
  if (!code) return '';
  return REASONS[code] ?? 'not available right now';
}

export function splitOptions(options: NextOption[]): { allowed: NextOption[]; blocked: NextOption[] } {
  return { allowed: options.filter((o) => o.allowed), blocked: options.filter((o) => !o.allowed) };
}

/** Messages for the error codes raised by the database functions. Unknown codes get a safe generic message. */
const ERRORS: Record<string, string> = {
  forbidden: 'You do not have permission to do that.',
  job_not_found: 'That job was not found, or it is not assigned to you.',
  not_authenticated: 'Please sign in again.',
  same_status: 'The job is already at that step.',
  unknown_stage: 'That step does not exist in this job\'s workflow.',
  draft_not_allowed: 'Jobs cannot be moved back to draft.',
  payment_required: 'This step needs confirmed payment first. Ask someone with payment rights to use "Payment Confirmed".',
  approval_required: 'The client has not approved yet. Record their approval first.',
  restricted_stage: 'Only authorised staff can use this step.',
  reopen_forbidden: 'Only a manager can reopen a completed or cancelled job.',
  reason_required: 'Write a message to the client explaining why.',
  payment_note_required: 'Add an internal note saying how the payment was received.',
  note_too_long: 'That note is too long.',
  not_awaiting_approval: 'This job is not waiting for client approval.',
  approval_note_required: 'Say how the client approved (for example "approved by phone").',
  already_approved: 'Approval was already recorded.',
  date_in_past: 'The date cannot be in the past.',
  invalid_note: 'Write a note between 1 and 2000 characters.',
  invalid_role: 'Choose a valid role for this job.',
  not_staff_member: 'That person is not an active staff member of this business.',
  not_assigned: 'That person is not assigned to this job.',
  invalid_setting: 'Unknown setting.',
  invalid_value: 'Invalid value.',
};

export function staffErrorMessage(code: string | null | undefined): string {
  return (code && ERRORS[code]) || 'Something went wrong. Please try again.';
}

/** Pull the code out of a database error message like "ERROR: payment_required". */
export function errorCode(message: string | null | undefined): string {
  const m = message ?? '';
  for (const code of Object.keys(ERRORS)) if (m.includes(code)) return code;
  return 'unknown';
}

const OK: Record<string, string> = {
  status: 'The job was updated and the client has been notified.',
  assigned: 'Assignment saved.',
  unassigned: 'Assignment removed.',
  estimate: 'Estimated completion saved.',
  approval: 'Client approval recorded.',
  note: 'Note added.',
  setting: 'Setting saved.',
};

export function okMessage(code: string | null | undefined): string | null {
  return (code && OK[code]) || null;
}

export function isOverdue(dueDate: string | null, status: string, today: string): boolean {
  if (!dueDate) return false;
  if (['completed', 'cancelled', 'ready_for_collection', 'out_for_delivery'].includes(status)) return false;
  return dueDate < today;
}

export const ROLE_LABELS: Record<string, string> = {
  designer: 'Designer',
  operator: 'Production operator',
  delivery: 'Delivery',
  worker: 'Other',
};
