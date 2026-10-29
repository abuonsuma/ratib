// Row shapes returned by Supabase. Replace with generated types later (supabase gen types typescript).
export type Org = { id: string; name: string; slug: string; logo_url: string | null; primary_color: string };
export type CustomerRow = { id: string; org_id: string; name: string; email: string | null; phone: string | null; company_name: string | null };
export type CategoryRow = { id: string; name: string; description: string | null };
export type JobRow = {
  id: string; job_ref: string | null; title: string; description: string | null; status: string; priority: string;
  due_date: string | null; delivery_method: string; delivery_address: string | null; instructions: string | null;
  estimated_completion: string | null; submitted_at: string | null; created_at: string; category_id: string; workflow_id: string;
};
export type JobItemRow = {
  id: string; position: number; description: string; quantity: number; size: string | null; orientation: string;
  colour_mode: string; material: string | null; finishing: string | null;
};
export type JobFileRow = { id: string; storage_path: string; filename: string; mime_type: string | null; size_bytes: number; kind: string; created_at: string };
export type NotificationRow = { id: string; type: string; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string };

export type StaffNotification = NotificationRow;
