// Pure workflow helpers (no imports, so they are easy to test). Mirrors the workflow tables in the database.

export type Stage = {
  status_key: string;
  label: string;
  position: number;
  off_track: boolean;
  is_terminal: boolean;
  client_visible: boolean;
};

export type HistoryEntry = {
  to_status: string;
  label: string;
  client_note: string | null;
  created_at: string;
};

export type TimelineStep = {
  key: string;
  label: string;
  state: 'done' | 'current' | 'upcoming';
  at: string | null;
  note: string | null;
};

export type Timeline = {
  steps: TimelineStep[];
  percent: number;
  /** set when the job is on hold or cancelled */
  offTrack: { key: string; label: string; at: string | null; note: string | null } | null;
};

/**
 * Turn the configured stages plus the job's history into a progress line.
 * Stages that are off-track (on hold, cancelled) never appear in the main line.
 * "draft" is hidden: a submitted job has already left it.
 */
export function buildTimeline(stages: Stage[], history: HistoryEntry[], current: string): Timeline {
  const main = stages
    .filter((s) => !s.off_track && s.client_visible && s.status_key !== 'draft')
    .sort((a, b) => a.position - b.position);
  const offTrackStage = stages.find((s) => s.off_track && s.status_key === current) ?? null;

  const latest = (key: string) => {
    let found: HistoryEntry | null = null;
    for (const h of history) {
      if (h.to_status !== key) continue;
      if (!found || h.created_at > found.created_at) found = h;
    }
    return found;
  };

  // where the job was before it went off-track: the most recent history entry that sits on the main line
  let position = main.findIndex((s) => s.status_key === current);
  if (position === -1 && offTrackStage) {
    const sorted = [...history].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const lastOnTrack = sorted.find((h) => main.some((s) => s.status_key === h.to_status));
    position = lastOnTrack ? main.findIndex((s) => s.status_key === lastOnTrack.to_status) : -1;
  }

  const currentIsTerminal = main.find((s) => s.status_key === current)?.is_terminal ?? false;

  const steps: TimelineStep[] = main.map((s, i) => {
    const h = latest(s.status_key);
    let state: TimelineStep['state'];
    if (currentIsTerminal && i <= position) state = 'done';
    else if (i < position) state = 'done';
    else if (i === position) state = 'current'; // also the paused stage when the job is on hold
    else state = 'upcoming';
    return { key: s.status_key, label: s.label, state, at: h?.created_at ?? null, note: h?.client_note ?? null };
  });

  const doneCount = steps.filter((s) => s.state === 'done').length;
  const percent = main.length === 0 ? 0 : currentIsTerminal ? 100 : Math.round(((doneCount + (position >= 0 && !offTrackStage ? 0.5 : 0)) / main.length) * 100);

  const offTrack = offTrackStage
    ? { key: offTrackStage.status_key, label: offTrackStage.label, at: latest(offTrackStage.status_key)?.created_at ?? null, note: latest(offTrackStage.status_key)?.client_note ?? null }
    : null;

  return { steps, percent: Math.min(100, Math.max(0, percent)), offTrack };
}

/** Dashboard groups, in display order. A job is counted in exactly one group (or none for drafts and cancelled). */
export const DASHBOARD_GROUPS = [
  { id: 'awaiting_approval', label: 'Awaiting your approval', statuses: ['awaiting_client_approval'] },
  { id: 'awaiting_payment', label: 'Awaiting payment', statuses: ['awaiting_payment'] },
  { id: 'in_production', label: 'In production', statuses: ['payment_confirmed', 'queued_for_production', 'in_production', 'quality_check'] },
  { id: 'ready', label: 'Ready for collection or delivery', statuses: ['ready_for_collection', 'out_for_delivery'] },
  { id: 'completed', label: 'Completed', statuses: ['completed'] },
] as const;

export type GroupCounts = Record<(typeof DASHBOARD_GROUPS)[number]['id'], number> & { total: number; drafts: number; in_review: number };

export function countByGroup(statuses: string[]): GroupCounts {
  const counts: GroupCounts = { awaiting_approval: 0, awaiting_payment: 0, in_production: 0, ready: 0, completed: 0, total: 0, drafts: 0, in_review: 0 };
  for (const s of statuses) {
    if (s === 'draft') {
      counts.drafts += 1;
      continue;
    }
    counts.total += 1; // "total jobs submitted" excludes drafts
    const group = DASHBOARD_GROUPS.find((g) => (g.statuses as readonly string[]).includes(s));
    if (group) counts[group.id] += 1;
    else if (['submitted', 'under_review', 'awaiting_quotation'].includes(s)) counts.in_review += 1;
  }
  return counts;
}

export type Tone = 'slate' | 'blue' | 'amber' | 'violet' | 'green' | 'red';

export function statusTone(status: string): Tone {
  switch (status) {
    case 'draft':
      return 'slate';
    case 'submitted':
    case 'under_review':
    case 'awaiting_quotation':
      return 'blue';
    case 'awaiting_client_approval':
    case 'awaiting_payment':
    case 'on_hold':
      return 'amber';
    case 'payment_confirmed':
    case 'queued_for_production':
    case 'in_production':
    case 'quality_check':
      return 'violet';
    case 'ready_for_collection':
    case 'out_for_delivery':
    case 'completed':
      return 'green';
    case 'cancelled':
      return 'red';
    default:
      return 'slate';
  }
}

/** What the client needs to do next, in plain words. null means nothing is needed from them. */
export function clientAction(status: string): string | null {
  switch (status) {
    case 'draft':
      return 'Finish your details and submit the job.';
    case 'awaiting_client_approval':
      return 'Your approval is needed before we continue.';
    case 'awaiting_payment':
      return 'Payment is needed before production can start.';
    case 'ready_for_collection':
      return 'Your job is ready. Please come and collect it.';
    default:
      return null;
  }
}
