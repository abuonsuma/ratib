# Setup and deployment (Phases 1 and 2)

## What you need
- Node.js 22.6 or newer
- A Supabase project (free tier is fine to start)
- Optional for local database work: Docker and the Supabase CLI

## 1. Local development

```bash
# database (needs Docker + Supabase CLI)
cd ratib
supabase init            # once; keeps the existing migrations folder
supabase start
supabase db reset        # runs migrations/ and seed.sql

# web app
cd apps/web
cp .env.example .env.local      # fill in the URL and anon key printed by `supabase start`
npm install
npm run dev                     # http://localhost:3000
```

Seed logins (password for all is `Passw0rd!demo`, development only):

| Email | Role |
|---|---|
| client@demo.test | Client with 3 jobs: completed, in production, awaiting approval |
| client2@demo.test | Second client in the same business (proves clients cannot see each other) |
| admin@demo.test | Super Administrator (everything, including Settings) |
| manager@demo.test | Manager (all jobs, assigning, cancel, complete, reopen, confirm payment) |
| cs@demo.test | Customer Service (all jobs, move jobs through normal stages, see customer contacts) |
| designer@demo.test | Designer (sees only JOB-2026-0003, which is assigned to her) |
| operator@demo.test | Production Operator (sees only JOB-2026-0002, which is assigned to him) |
| accountant@demo.test | Accountant / Cashier (all jobs read-only, customer contacts, can confirm payment) |

Staff sign in at the same login page and land on `/admin/overview`. Clients land on `/portal/dashboard`.

In Supabase Studio, Authentication -> Providers -> Email, you can turn "Confirm email" off for local testing.

## 2. Tests

```bash
cd apps/web && npm test                  # 44 logic tests: workflow, uploads, validation, tenant, redirects, staff helpers, email, queue worker
```

Database and security tests need a PostgreSQL server (any 14+). They create a throwaway database, apply the stubs, migrations and seed, then run about 290 checks. Phase 1 (`01_rls_tests.sql`): tenant isolation, client isolation, write restrictions, validation, append-only history, private file storage. Phase 2 (`02_staff_tests.sql`): who sees which jobs, assignment, every workflow gate, restricted stages, approval and payment rules, notifications and email preferences, finished-file permissions, dashboard numbers, and the email queue (claiming, retries, crash recovery):

```bash
PGHOST=localhost PGPORT=5432 PGUSER=postgres supabase/tests/run_db_tests.sh
```

## 3. Production

1. Create the Supabase project. Settings -> API: copy the URL and anon key.
2. Authentication -> URL Configuration: set Site URL to your site, and add `https://YOUR-SITE/auth/callback` to Redirect URLs.
3. Authentication -> Providers -> Email: keep "Confirm email" ON. Configure your own SMTP (Resend, Postmark, etc.) before launch; the built-in mailer is rate limited.
4. Apply migrations only (never `seed.sql`, it creates users with a known password):
   ```bash
   supabase link --project-ref YOUR-REF
   supabase db push
   ```
5. Create the first business in the SQL editor:
   ```sql
   insert into organisations (name, slug) values ('Your Business Name', 'your-slug');
   select seed_org_defaults((select id from organisations where slug = 'your-slug'));
   ```
6. Invite the owner in Authentication -> Users, then make them Super Administrator:
   ```sql
   insert into org_members (org_id, user_id, role_id)
   select o.id, u.id, r.id
   from organisations o, auth.users u, roles r
   where o.slug = 'your-slug' and u.email = 'owner@example.com'
     and r.org_id = o.id and r.key = 'super_admin';
   ```
7. Vercel: import the repository, set Root Directory to `apps/web`, add the environment variables from `.env.example` (`NEXT_PUBLIC_DEFAULT_ORG_SLUG=your-slug` for a single business, or `NEXT_PUBLIC_ROOT_DOMAIN` for subdomains per business). Never add the service-role key to variables that start with `NEXT_PUBLIC_`.
8. Backups: Supabase takes daily backups on paid plans; enable point-in-time recovery before real customers use it, and practise one restore.

## Staff roles at a glance

| Role | Sees | Can do |
|---|---|---|
| Super Administrator | all jobs | everything, including Settings |
| Manager | all jobs | assign, move, cancel, complete, reopen, confirm payment, see customer contacts |
| Customer Service | all jobs | move jobs through normal stages, record client approval, set estimates, see customer contacts |
| Accountant / Cashier | all jobs (cannot move them) | confirm payment, see customer contacts |
| Designer, Production Operator | only jobs assigned to them | move their jobs through normal stages, add notes, attach finished files |
| Delivery Staff | only jobs assigned to them | the same, and mark jobs Completed |

Restricted stages: **Payment Confirmed** (needs payment rights), **Cancelled**, **Completed**. Reopening a finished job needs the reopen right (managers and administrators).

## Adding staff in production

There is no staff-management screen yet. Invite the person in Supabase (Authentication -> Users), then:

```sql
insert into org_members (org_id, user_id, role_id)
select o.id, u.id, r.id
from organisations o, auth.users u, roles r
where o.slug = 'your-slug' and u.email = 'person@example.com'
  and r.org_id = o.id and r.key = 'manager';   -- or customer_service, designer, operator, accountant, delivery
```
To remove access: `update org_members set status = 'disabled' where ...`.

Staff accounts must not be created through the public Register page. That page always creates a client.

## Email alerts (the outbox worker)

Every alert is written to the `outbox` table in the same database transaction as the job change, so an email is never lost and never sent twice for the same event. A worker then sends the queued emails.

1. Create a Resend account, verify your sending domain, create an API key.
2. In Vercel set `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`, `CRON_SECRET` (see `.env.example`).
3. Make something call the worker about once a minute. Pick one:
   - **Vercel Cron**: add to `apps/web/vercel.json` `{ "crons": [{ "path": "/api/cron/outbox", "schedule": "* * * * *" }] }`. Check your Vercel plan: some plans limit cron to a few runs per day. Vercel sends `Authorization: Bearer <CRON_SECRET>` automatically when `CRON_SECRET` is set.
   - **An outside pinger** (for example cron-job.org, free): GET `https://YOUR-SITE/api/cron/outbox` every minute with the header `Authorization: Bearer YOUR_CRON_SECRET`.
   - **Supabase pg_cron + pg_net**, if you prefer to keep it all in Supabase.
4. Test it:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR-SITE/api/cron/outbox
   # {"claimed":2,"sent":2,"failed":0,"warnings":[]}
   ```
   A wrong or missing secret returns 401. Missing configuration returns 503 without touching the queue.

Failed emails are retried after 1, 4, 9 and 16 minutes, then parked with status `failed` and the reason in `outbox.last_error`:
```sql
select created_at, to_email, template, attempts, last_error from outbox where status in ('retry','failed') order by created_at desc;
```
Clients can switch email off in Account. They still get every in-app alert.

## Known limits (after Phase 2)
- Quotations, online approval, Paystack payments and balances are Phase 3. Until then **staff record** that a client approved (phone, WhatsApp, in person) and **staff confirm** payment by hand. Both are logged with who, when and the note.
- No "your job is delayed" automatic alert yet. It needs a daily scheduler and a rule for what counts as delayed; it fits Phase 4 with reports.
- No staff-management or customer-list screens yet (staff are added in SQL, see above).
- Email preferences are one on/off switch per person, not per event type.
- Staff and clients share one login page and one `notifications` table; staff alerts link to `/admin/...`.
- Auth rate limiting relies on Supabase's built-in limits. Add edge rate limiting (Vercel Firewall or similar) before launch.
- Types are hand-written; generate them with `supabase gen types typescript` once the project is linked.
