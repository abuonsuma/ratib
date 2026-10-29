import { requireClient } from '@/lib/session';
import { JobWizard } from '@/components/job-wizard';
import { blankForm, toFormState, type WizardCategory, type WizardFile } from '@/lib/wizard';
import { isImage } from '@/lib/files';
import type { JobFileRow, JobItemRow, JobRow } from '@/lib/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NewJobPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { supabase, org } = await requireClient();
  const sp = await searchParams;

  const { data: cats } = await supabase.from('service_categories').select('id, name, description').eq('active', true).order('sort_order');
  const categories = (cats ?? []) as WizardCategory[];

  let jobId: string | null = null;
  let form = blankForm();
  let files: WizardFile[] = [];

  const draftId = typeof sp.draft === 'string' && UUID.test(sp.draft) ? sp.draft : null;
  if (draftId) {
    const { data: job } = await supabase.from('jobs').select('*').eq('id', draftId).eq('status', 'draft').maybeSingle();
    if (job) {
      const j = job as JobRow;
      const [{ data: items }, { data: fileRows }] = await Promise.all([
        supabase.from('job_items').select('*').eq('job_id', draftId).order('position'),
        supabase.from('job_files').select('id, storage_path, filename, mime_type, size_bytes, kind, created_at').eq('job_id', draftId).order('created_at'),
      ]);
      jobId = j.id;
      form = toFormState({
        category_id: j.category_id,
        title: j.title,
        description: j.description ?? '',
        due_date: j.due_date ?? '',
        priority: j.priority === 'urgent' ? 'urgent' : 'normal',
        delivery_method: j.delivery_method === 'delivery' ? 'delivery' : 'collection',
        delivery_address: j.delivery_address ?? '',
        instructions: j.instructions ?? '',
        items: ((items ?? []) as JobItemRow[]).map((i) => ({
          description: i.description,
          quantity: i.quantity,
          size: i.size ?? '',
          orientation: i.orientation as 'portrait' | 'landscape' | 'not_applicable',
          colour_mode: i.colour_mode as 'full_colour' | 'black_white',
          material: i.material ?? '',
          finishing: i.finishing ?? '',
        })),
      });
      const rows = (fileRows ?? []) as JobFileRow[];
      const imagePaths = rows.filter((f) => isImage(f.filename)).map((f) => f.storage_path);
      const previews = new Map<string, string>();
      if (imagePaths.length > 0) {
        const { data: signed } = await supabase.storage.from('job-files').createSignedUrls(imagePaths, 600);
        for (const s of signed ?? []) if (s.path && s.signedUrl) previews.set(s.path, s.signedUrl);
      }
      files = rows.map((f) => ({ id: f.id, filename: f.filename, size_bytes: f.size_bytes, storage_path: f.storage_path, previewUrl: previews.get(f.storage_path) }));
    }
  }

  return <JobWizard orgId={org.id} categories={categories} initialJobId={jobId} initialForm={form} initialFiles={files} />;
}
