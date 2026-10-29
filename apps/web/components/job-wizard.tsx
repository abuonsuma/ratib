'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { discardDraft, registerFile, removeFile, saveDraft, submitJob } from '@/app/actions/jobs';
import { emptyItem, parseJobDraft } from '@/lib/job';
import type { FormItem, FormState, WizardCategory, WizardFile } from '@/lib/wizard';
import { ALLOWED_EXTENSIONS, MAX_FILES_PER_JOB, formatBytes, isImage, storagePath, validateFile } from '@/lib/files';
import { Alert, Card, Field, buttonDanger, buttonPrimary, buttonSecondary, inputClass } from '@/components/ui';

const STEPS = ['Service', 'Details', 'Files', 'Review'] as const;

export function JobWizard(props: {
  orgId: string;
  categories: WizardCategory[];
  initialJobId: string | null;
  initialForm: FormState;
  initialFiles: WizardFile[];
}) {
  const router = useRouter();
  const [step, setStep] = useState<number>(props.initialJobId ? 1 : 0);
  const [form, setForm] = useState<FormState>(props.initialForm);
  const [jobId, setJobId] = useState<string | null>(props.initialJobId);
  const [files, setFiles] = useState<WizardFile[]>(props.initialFiles);
  const [uploading, setUploading] = useState<string[]>([]);
  const [fileKind, setFileKind] = useState<'design' | 'reference'>('design');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const today = new Date().toISOString().slice(0, 10);
  const category = props.categories.find((c) => c.id === form.category_id);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  function setItem(i: number, patch: Partial<FormItem>) {
    setForm((f) => ({ ...f, items: f.items.map((it, n) => (n === i ? { ...it, ...patch } : it)) }));
  }

  /** Validate, then save the draft on the server. Returns the draft id, or null when something needs fixing. */
  async function persist(): Promise<string | null> {
    const parsed = parseJobDraft(form);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      setBanner('Please fix the highlighted fields.');
      return null;
    }
    const res = await saveDraft(parsed.value, jobId);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      setBanner(res.error);
      return null;
    }
    setErrors({});
    setBanner(null);
    setJobId(res.jobId);
    return res.jobId;
  }

  async function nextFromDetails() {
    setBusy(true);
    const id = await persist();
    setBusy(false);
    if (id) {
      setStep(2);
      window.scrollTo({ top: 0 });
    }
  }

  async function saveAndExit() {
    setBusy(true);
    const id = await persist();
    setBusy(false);
    if (id) router.push('/portal/jobs');
  }

  async function discard() {
    if (!jobId) {
      router.push('/portal/jobs');
      return;
    }
    if (!window.confirm('Delete this draft and its files? This cannot be undone.')) return;
    setBusy(true);
    const res = await discardDraft(jobId);
    setBusy(false);
    if (res.ok) router.push('/portal/jobs');
    else setBanner(res.error);
  }

  async function onFilesChosen(list: FileList | null) {
    if (!list || !jobId) return;
    const supabase = createClient();
    const errs: string[] = [];
    let count = files.length;

    for (const file of Array.from(list)) {
      const problem = validateFile(file);
      if (problem) {
        errs.push(problem);
        continue;
      }
      if (count >= MAX_FILES_PER_JOB) {
        errs.push(`You can attach up to ${MAX_FILES_PER_JOB} files to one job.`);
        break;
      }
      const uid = crypto.randomUUID();
      const path = storagePath(props.orgId, jobId, uid, file.name);
      setUploading((u) => [...u, file.name]);
      const up = await supabase.storage.from('job-files').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
      if (up.error) {
        errs.push(`"${file.name}" could not be uploaded. Please try again.`);
        setUploading((u) => u.filter((n) => n !== file.name));
        continue;
      }
      const res = await registerFile({ jobId, path, filename: file.name, mime: file.type, size: file.size, kind: fileKind });
      setUploading((u) => u.filter((n) => n !== file.name));
      if (!res.ok) {
        errs.push(res.error);
        continue;
      }
      count += 1;
      setFiles((f) => [...f, { ...res.file, previewUrl: isImage(file.name) ? URL.createObjectURL(file) : undefined }]);
    }
    setFileErrors(errs);
    if (fileInput.current) fileInput.current.value = '';
  }

  async function deleteFile(id: string) {
    const res = await removeFile(id);
    if (res.ok) setFiles((f) => f.filter((x) => x.id !== id));
    else setFileErrors([res.error]);
  }

  async function submit() {
    if (!jobId) return;
    setBusy(true);
    const res = await submitJob(jobId);
    if (!res.ok) {
      setBusy(false);
      setBanner(res.error);
      return;
    }
    router.push(`/portal/jobs/${jobId}?submitted=1`);
  }

  const itemError = (i: number, k: string) => errors[`items.${i}.${k}`];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">{jobId ? 'Continue your job' : 'Start a new job'}</h1>
        <ol className="mt-4 flex items-center gap-2" aria-label="Steps">
          {STEPS.map((label, i) => (
            <li key={label} aria-current={i === step ? 'step' : undefined} className="flex flex-1 flex-col gap-1.5">
              <span className={`h-1.5 rounded-full ${i <= step ? 'bg-brand' : 'bg-slate-200'}`} />
              <span className={`text-xs font-medium ${i === step ? 'text-slate-900' : 'text-slate-500'}`}>{i + 1}. {label}</span>
            </li>
          ))}
        </ol>
      </div>

      {banner && <Alert tone="error">{banner}</Alert>}

      {step === 0 && (
        <section aria-labelledby="s0">
          <h2 id="s0" className="mb-3 text-base font-semibold text-slate-900">What do you need?</h2>
          {errors.category_id && <p role="alert" className="mb-2 text-sm font-medium text-red-600">{errors.category_id}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            {props.categories.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { set('category_id', c.id); setStep(1); window.scrollTo({ top: 0 }); }}
                className={`rounded-xl border bg-white p-4 text-left shadow-sm transition hover:border-brand ${form.category_id === c.id ? 'border-brand ring-1 ring-brand' : 'border-slate-200'}`}
              >
                <span className="block text-sm font-semibold text-slate-900">{c.name}</span>
                {c.description && <span className="mt-1 block text-xs text-slate-600">{c.description}</span>}
              </button>
            ))}
          </div>
        </section>
      )}

      {step === 1 && (
        <section aria-labelledby="s1" className="space-y-5">
          <div className="flex items-center justify-between">
            <h2 id="s1" className="text-base font-semibold text-slate-900">Tell us about the job{category ? ` · ${category.name}` : ''}</h2>
            <button type="button" onClick={() => setStep(0)} className="text-sm font-medium text-brand hover:underline">Change service</button>
          </div>

          <Card className="space-y-4 p-5">
            <Field label="Job title" htmlFor="title" error={errors.title} hint="For example: Wedding programmes or Church banner.">
              <input id="title" value={form.title} onChange={(e) => set('title', e.target.value)} maxLength={200} aria-invalid={!!errors.title} className={inputClass} />
            </Field>
            <Field label="Description (optional)" htmlFor="description">
              <textarea id="description" value={form.description} onChange={(e) => set('description', e.target.value)} rows={3} maxLength={2000} className={inputClass} />
            </Field>
          </Card>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-900">Items</h3>
            {errors.items && <p role="alert" className="text-sm font-medium text-red-600">{errors.items}</p>}
            {form.items.map((it, i) => (
              <Card key={i} className="space-y-4 p-5">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-slate-900">Item {i + 1}</p>
                  {form.items.length > 1 && (
                    <button type="button" onClick={() => set('items', form.items.filter((_, n) => n !== i))} className="text-sm font-medium text-red-600 hover:underline">Remove</button>
                  )}
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="sm:col-span-2">
                    <Field label="What is it?" htmlFor={`desc-${i}`} error={itemError(i, 'description')}>
                      <input id={`desc-${i}`} value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} placeholder="Business cards, double sided" className={inputClass} />
                    </Field>
                  </div>
                  <Field label="Quantity" htmlFor={`qty-${i}`} error={itemError(i, 'quantity')}>
                    <input id={`qty-${i}`} type="number" inputMode="numeric" min={1} value={it.quantity} onChange={(e) => setItem(i, { quantity: e.target.value })} className={inputClass} />
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Size" htmlFor={`size-${i}`} hint="A4, 90x55mm, 2m x 1m…">
                    <input id={`size-${i}`} value={it.size} onChange={(e) => setItem(i, { size: e.target.value })} className={inputClass} />
                  </Field>
                  <Field label="Orientation" htmlFor={`orient-${i}`}>
                    <select id={`orient-${i}`} value={it.orientation} onChange={(e) => setItem(i, { orientation: e.target.value as FormItem['orientation'] })} className={inputClass}>
                      <option value="not_applicable">Not applicable</option>
                      <option value="portrait">Portrait</option>
                      <option value="landscape">Landscape</option>
                    </select>
                  </Field>
                  <Field label="Colour" htmlFor={`colour-${i}`}>
                    <select id={`colour-${i}`} value={it.colour_mode} onChange={(e) => setItem(i, { colour_mode: e.target.value as FormItem['colour_mode'] })} className={inputClass}>
                      <option value="full_colour">Full colour</option>
                      <option value="black_white">Black and white</option>
                    </select>
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Paper or material" htmlFor={`mat-${i}`} hint="350gsm matt, vinyl, PVC banner…">
                    <input id={`mat-${i}`} value={it.material} onChange={(e) => setItem(i, { material: e.target.value })} className={inputClass} />
                  </Field>
                  <Field label="Finishing" htmlFor={`fin-${i}`} hint="Lamination, binding, eyelets…">
                    <input id={`fin-${i}`} value={it.finishing} onChange={(e) => setItem(i, { finishing: e.target.value })} className={inputClass} />
                  </Field>
                </div>
              </Card>
            ))}
            {form.items.length < 20 && (
              <button type="button" onClick={() => set('items', [...form.items, { ...emptyItem(), quantity: '1' }])} className={buttonSecondary}>+ Add another item</button>
            )}
          </div>

          <Card className="space-y-4 p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Needed by (optional)" htmlFor="due" error={errors.due_date}>
                <input id="due" type="date" min={today} value={form.due_date} onChange={(e) => set('due_date', e.target.value)} className={inputClass} />
              </Field>
              <div className="flex items-end">
                <label className="flex items-center gap-2 pb-2.5 text-sm text-slate-800">
                  <input type="checkbox" checked={form.priority === 'urgent'} onChange={(e) => set('priority', e.target.checked ? 'urgent' : 'normal')} className="h-4 w-4 rounded border-slate-300" />
                  This is urgent
                </label>
              </div>
            </div>
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-slate-800">How will you get it?</legend>
              <div className="flex gap-4 text-sm">
                {(['collection', 'delivery'] as const).map((m) => (
                  <label key={m} className="flex items-center gap-2">
                    <input type="radio" name="delivery_method" checked={form.delivery_method === m} onChange={() => set('delivery_method', m)} />
                    {m === 'collection' ? 'I will collect it' : 'Deliver to me'}
                  </label>
                ))}
              </div>
            </fieldset>
            {form.delivery_method === 'delivery' && (
              <Field label="Delivery address" htmlFor="addr" error={errors.delivery_address}>
                <textarea id="addr" rows={2} value={form.delivery_address} onChange={(e) => set('delivery_address', e.target.value)} className={inputClass} />
              </Field>
            )}
            <Field label="Special instructions (optional)" htmlFor="instr">
              <textarea id="instr" rows={3} value={form.instructions} onChange={(e) => set('instructions', e.target.value)} maxLength={2000} className={inputClass} />
            </Field>
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <button type="button" onClick={discard} disabled={busy} className={buttonDanger}>{jobId ? 'Delete draft' : 'Cancel'}</button>
            <div className="flex gap-3">
              <button type="button" onClick={saveAndExit} disabled={busy} className={buttonSecondary}>Save and finish later</button>
              <button type="button" onClick={nextFromDetails} disabled={busy} className={buttonPrimary}>{busy ? 'Saving…' : 'Next: add files'}</button>
            </div>
          </div>
        </section>
      )}

      {step === 2 && (
        <section aria-labelledby="s2" className="space-y-5">
          <h2 id="s2" className="text-base font-semibold text-slate-900">Add your files</h2>
          <Card className="space-y-4 p-5">
            <p className="text-sm text-slate-600">
              Upload your artwork, logos or reference images. Up to {MAX_FILES_PER_JOB} files, {formatBytes(50 * 1024 * 1024)} each. Accepted: {ALLOWED_EXTENSIONS.join(', ')}. No files yet? You can skip this step and send them later through the job page.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="These files are" htmlFor="kind">
                <select id="kind" value={fileKind} onChange={(e) => setFileKind(e.target.value as 'design' | 'reference')} className={inputClass}>
                  <option value="design">My finished design or artwork</option>
                  <option value="reference">Reference or inspiration</option>
                </select>
              </Field>
              <Field label="Choose files" htmlFor="files">
                <input
                  id="files" ref={fileInput} type="file" multiple
                  accept={ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(',')}
                  onChange={(e) => onFilesChosen(e.target.files)}
                  disabled={uploading.length > 0}
                  className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-4 file:py-2.5 file:text-sm file:font-semibold file:text-slate-800 hover:file:bg-slate-200"
                />
              </Field>
            </div>
            {fileErrors.map((m, i) => <p key={i} role="alert" className="text-sm font-medium text-red-600">{m}</p>)}
            {uploading.map((n) => <p key={n} className="text-sm text-slate-600" role="status">Uploading {n}…</p>)}
            {files.length > 0 && (
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {files.map((f) => (
                  <li key={f.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                    {f.previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={f.previewUrl} alt="" className="h-10 w-10 rounded object-cover" />
                    ) : (
                      <span aria-hidden className="flex h-10 w-10 items-center justify-center rounded bg-slate-100 text-[10px] font-bold uppercase text-slate-500">{f.filename.split('.').pop()}</span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-slate-900">{f.filename}</span>
                    <span className="text-xs text-slate-500">{formatBytes(f.size_bytes)}</span>
                    <button type="button" onClick={() => deleteFile(f.id)} className="text-xs font-medium text-red-600 hover:underline" aria-label={`Remove ${f.filename}`}>Remove</button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <div className="flex items-center justify-between gap-3">
            <button type="button" onClick={() => setStep(1)} className={buttonSecondary}>Back</button>
            <div className="flex gap-3">
              <button type="button" onClick={saveAndExit} disabled={busy || uploading.length > 0} className={buttonSecondary}>Save and finish later</button>
              <button type="button" onClick={() => { setStep(3); window.scrollTo({ top: 0 }); }} disabled={uploading.length > 0} className={buttonPrimary}>Next: review</button>
            </div>
          </div>
        </section>
      )}

      {step === 3 && (
        <section aria-labelledby="s3" className="space-y-5">
          <h2 id="s3" className="text-base font-semibold text-slate-900">Check everything, then submit</h2>
          <Card className="space-y-4 p-5 text-sm">
            <Row label="Service" value={category?.name ?? ''} />
            <Row label="Title" value={form.title} />
            {form.description && <Row label="Description" value={form.description} />}
            <Row label="Needed by" value={form.due_date || 'No date set'} />
            <Row label="Priority" value={form.priority === 'urgent' ? 'Urgent' : 'Normal'} />
            <Row label="Collection or delivery" value={form.delivery_method === 'delivery' ? `Delivery to ${form.delivery_address}` : 'I will collect it'} />
            {form.instructions && <Row label="Instructions" value={form.instructions} />}
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Items</p>
              <ul className="space-y-1">
                {form.items.map((it, i) => (
                  <li key={i} className="text-slate-900">
                    {it.quantity} × {it.description}
                    <span className="text-slate-500">{[it.size, it.colour_mode === 'black_white' ? 'black and white' : 'full colour', it.material, it.finishing].filter(Boolean).map((x) => ` · ${x}`).join('')}</span>
                  </li>
                ))}
              </ul>
            </div>
            <Row label="Files" value={files.length === 0 ? 'None attached' : files.map((f) => f.filename).join(', ')} />
          </Card>
          <p className="text-sm text-slate-600">After you submit, our team reviews your job and sends a quotation if one is needed. You will get an alert at every step.</p>
          <div className="flex items-center justify-between gap-3">
            <button type="button" onClick={() => setStep(2)} className={buttonSecondary} disabled={busy}>Back</button>
            <button type="button" onClick={submit} disabled={busy} className={buttonPrimary}>{busy ? 'Submitting…' : 'Submit job'}</button>
          </div>
        </section>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 whitespace-pre-line text-slate-900">{value}</p>
    </div>
  );
}
