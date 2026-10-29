// Shared by the server page (app/portal/jobs/new/page.tsx) and the client wizard.
// Keep this file free of 'use client': functions in a client file cannot be called from the server.
import { emptyItem, type JobDraftInput, type JobItemInput } from '@/lib/job';

export type WizardCategory = { id: string; name: string; description: string | null };
export type WizardFile = { id: string; filename: string; size_bytes: number; storage_path: string; previewUrl?: string };
export type FormItem = Omit<JobItemInput, 'quantity'> & { quantity: string };
export type FormState = Omit<JobDraftInput, 'items'> & { items: FormItem[] };

export function toFormState(d: JobDraftInput): FormState {
  return { ...d, items: d.items.map((i) => ({ ...i, quantity: String(i.quantity) })) };
}

export function blankForm(): FormState {
  return {
    category_id: '', title: '', description: '', due_date: '', priority: 'normal', delivery_method: 'collection',
    delivery_address: '', instructions: '', items: [{ ...emptyItem(), quantity: '1' }],
  };
}
