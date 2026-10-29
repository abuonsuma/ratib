// Server-side validation of the job form. Mirrors save_job_draft() in the database, which re-checks everything.
// Prices and statuses are deliberately absent: the client never supplies them.

export const ORIENTATIONS = ['portrait', 'landscape', 'not_applicable'] as const;
export const COLOUR_MODES = ['full_colour', 'black_white'] as const;
export const DELIVERY_METHODS = ['collection', 'delivery'] as const;

export type JobItemInput = {
  description: string;
  quantity: number;
  size: string;
  orientation: (typeof ORIENTATIONS)[number];
  colour_mode: (typeof COLOUR_MODES)[number];
  material: string;
  finishing: string;
};

export type JobDraftInput = {
  category_id: string;
  title: string;
  description: string;
  due_date: string; // YYYY-MM-DD or ''
  priority: 'normal' | 'urgent';
  delivery_method: (typeof DELIVERY_METHODS)[number];
  delivery_address: string;
  instructions: string;
  items: JobItemInput[];
};

export type ParseResult =
  | { ok: true; value: JobDraftInput }
  | { ok: false; errors: Record<string, string> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export function emptyItem(): JobItemInput {
  return { description: '', quantity: 1, size: '', orientation: 'not_applicable', colour_mode: 'full_colour', material: '', finishing: '' };
}

export function parseJobDraft(input: unknown, today: Date = new Date()): ParseResult {
  const errors: Record<string, string> = {};
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

  const category_id = str(o.category_id, 40);
  if (!UUID.test(category_id)) errors.category_id = 'Please choose a service.';

  const title = str(o.title, 200);
  if (title.length < 3) errors.title = 'Give your job a short title (at least 3 characters).';

  const delivery_method = o.delivery_method === 'delivery' ? 'delivery' : 'collection';
  const delivery_address = str(o.delivery_address, 500);
  if (delivery_method === 'delivery' && delivery_address.length < 5) {
    errors.delivery_address = 'Enter the delivery address.';
  }

  const due_date = str(o.due_date, 10);
  if (due_date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due_date) || Number.isNaN(Date.parse(due_date))) {
      errors.due_date = 'Enter a valid date.';
    } else {
      const todayStr = today.toISOString().slice(0, 10);
      if (due_date < todayStr) errors.due_date = 'The date cannot be in the past.';
    }
  }

  const rawItems = Array.isArray(o.items) ? o.items : [];
  if (rawItems.length < 1) errors.items = 'Add at least one item.';
  if (rawItems.length > 20) errors.items = 'You can add up to 20 items per job.';

  const items: JobItemInput[] = rawItems.slice(0, 20).map((raw, i) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const description = str(r.description, 500);
    if (description.length < 3) errors[`items.${i}.description`] = 'Describe this item (at least 3 characters).';
    const quantity = typeof r.quantity === 'number' ? r.quantity : Number(r.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000_000) {
      errors[`items.${i}.quantity`] = 'Quantity must be a whole number from 1 to 10,000,000.';
    }
    const orientation = (ORIENTATIONS as readonly string[]).includes(r.orientation as string)
      ? (r.orientation as JobItemInput['orientation'])
      : 'not_applicable';
    const colour_mode = (COLOUR_MODES as readonly string[]).includes(r.colour_mode as string)
      ? (r.colour_mode as JobItemInput['colour_mode'])
      : 'full_colour';
    return {
      description,
      quantity: Number.isInteger(quantity) ? quantity : 1,
      size: str(r.size, 100),
      orientation,
      colour_mode,
      material: str(r.material, 200),
      finishing: str(r.finishing, 200),
    };
  });

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      category_id,
      title,
      description: str(o.description, 2000),
      due_date,
      priority: o.priority === 'urgent' ? 'urgent' : 'normal',
      delivery_method,
      delivery_address: delivery_method === 'delivery' ? delivery_address : '',
      instructions: str(o.instructions, 2000),
      items,
    },
  };
}

/** Friendly text for the error codes raised by the database functions. */
export function friendlyDbError(message: string): string {
  const map: Record<string, string> = {
    not_authenticated: 'Please sign in again.',
    not_a_customer: 'Your account is not set up for this business.',
    invalid_title: 'Give your job a short title.',
    invalid_category: 'That service is not available.',
    invalid_items: 'Add between 1 and 20 items.',
    invalid_quantity: 'Quantity must be between 1 and 10,000,000.',
    invalid_item_description: 'Each item needs a short description.',
    invalid_orientation: 'Choose portrait, landscape or not applicable.',
    invalid_colour_mode: 'Choose full colour or black and white.',
    invalid_delivery_method: 'Choose collection or delivery.',
    delivery_address_required: 'Enter the delivery address.',
    draft_not_found: 'This draft cannot be edited any more. It may already be submitted.',
    job_not_found: 'We could not find that job.',
    not_a_draft: 'This job has already been submitted.',
    no_items: 'Add at least one item before submitting.',
    due_date_in_past: 'The required date has already passed. Please choose a later date.',
    no_workflow: 'This business has not finished setting up. Please contact them.',
  };
  for (const code of Object.keys(map)) if (message.includes(code)) return map[code];
  return 'Something went wrong. Please try again.';
}
