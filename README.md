# StartupTN staff portal (ERP, phase 1)

Attendance with a live selfie and automatic location tagging (head-office staff use the biometric machine
instead), leave, on-duty and permission requests with approvals, and an employee dashboard with records and
documents. Later phases (payslips, project tracking, note files, chat, fun zone) are not in this version.

| | |
|---|---|
| `apps/api` | NestJS 11 + PostgreSQL. All the rules live here. |
| `apps/web` | Next.js 16 + React 19 + Tailwind 4. A thin, phone-friendly front end over the API. |

Sign-in is Google Workspace only (`@startuptn.in`), and only for people HR has added as employees.

---

## 1. Run it on your computer

You need Node 22 and Docker (for PostgreSQL).

```bash
npm install
cp .env.example .env            # the defaults work for local use
docker compose up -d db         # PostgreSQL on localhost:5432
npm run db:migrate              # creates the tables and the starting rules
npm run db:seed                 # optional: a fictional 9-person organisation to click around in
npm run dev:api                 # http://localhost:4000
npm run dev:web                 # http://localhost:3000   (in a second terminal)
```

Open http://localhost:3000. With `AUTH_DEV_LOGIN=true` the sign-in page offers "Test sign-in": type a first
name from the demo data (`priya` is an employee, `mani` her manager, `hema` is HR, `meena` is the MD,
`sathya` is the system administrator). Dev sign-in is switched off automatically when `NODE_ENV=production`.

Checking in needs the browser's location and camera. That works on `localhost` and on any `https://` address,
not on a plain `http://` address. Without a camera, a selfie check-in cannot be made; the portal says so.

Tests (they need a throw-away database; by default `postgres://postgres@127.0.0.1:5433/erp_test`, or set
`TEST_DATABASE_URL`):

```bash
cd apps/api && npx jest --runInBand
```

---

## 2. Before real staff use it

**Everything below is a placeholder until HR confirms it.** The system starts with sensible guesses so it
works on day one; none of them came from StartupTN policy. HR can change all of them in the portal under
"HR and admin", with no code change.

| Decision | Starting value | Where HR changes it |
|---|---|---|
| Work starts / grace period | 09:30, 15 minutes | Working hours |
| Hours for a full / half day | 8 h / 4 h | Working hours |
| Weekly off | Saturday and Sunday (every one) | Working hours |
| Leave year | January to December | Working hours |
| How far back leave may be applied | 7 days | Working hours |
| Attendance correction window | 15 days back | Working hours |
| Permission (short time off) | 2 per month, up to 2 hours | Working hours |
| Weak GPS signal flagged above | 100 m (above 500 m is refused) | Working hours |
| Selfie with every check-in and check-out | On | Working hours |
| How long selfies are kept | 90 days (7 to 365). The photo is then deleted; the time and location stay | Working hours |
| How a person's attendance is taken | Selfie and location in the portal. Biometric machine only where HR sets it | Employees |
| Leave types and yearly amounts | Casual 12, Earned 15 (monthly, carry 15), Sick 12 (document after 3 days), Loss of Pay | Leave rules |
| Who may take which leave | Casual and Sick: permanent and contract. Earned: permanent only | Leave rules |
| Approval chain | Leave: reporting manager, then head of department if over 5 days. On duty, permission, corrections: reporting manager. 48 h to reply | Approval flows |
| Office location | None (check-ins are then not compared with any location) | Attendance setup |
| Holidays | None | Departments, holidays and notices |
| Document types | ID, address, education, experience, offer letter, contract, certificates, other | in the database (`document_categories`) |

Go-live order that avoids surprises:

1. **Start the installation.** Run the migration, then create the first administrator (section 3, step 4).
2. **Set the go-live date** under *Working hours → Attendance is tracked from*. Without it, every working day
   before the portal was used shows as Absent.
3. **Add departments and people** (Employees). Give each person a reporting manager. Give department heads
   the "Head of department" role, and the MD the "Managing director" role.
4. **Add the real office location(s)** under *Attendance setup*: latitude, longitude and a radius. A check-in
   outside every circle is still recorded but flagged for the manager and HR.
5. **Decide who is on the biometric machine.** Head-office (Chennai) staff punch on the machine; every hub
   uses the selfie in the portal. In *Employees*, set "How attendance is taken" to the biometric machine for
   each head-office person and enter the code the machine knows them by. Then see section 4 on connecting the
   machine. Until a punch source is connected, a head-office person has no attendance at all, so set the
   method and connect the machine (or import a file) together.
6. **Check the selfie rules** under *Working hours* (on by default; 90 days' retention). Photos of people are
   personal data: the first check-in asks for separate consent for the photo, and the retention period should
   be a decision HR and the management have made, not the default.
7. **Check leave rules and approval flows** against policy, then enter holidays.
8. **Opening leave balances.** People joining the portal mid-year already have some leave used. Post each
   person's opening balance as an adjustment on *Leave rules*.
9. **Pilot** with a few people for a week, then open it to everyone.

---

## 3. Deploying on AWS

This was built for the existing StartupTN AWS account, Mumbai region (`ap-south-1`). The pieces:

```
 browser ──HTTPS──▶ CloudFront (+ WAF) ──┬─ /api/*  ─▶ load balancer ─▶ API containers ─▶ RDS PostgreSQL
                                         └─ /*      ─▶ web container (or Amplify)         └▶ S3 documents, SES email
 EventBridge (schedules) ── POST /api/jobs/* with x-jobs-token ─▶ API
```

The Dockerfiles are in `apps/api` and `apps/web` and are built **from the repository root**:

```bash
docker build -f apps/api/Dockerfile -t startuptn-erp-api .
docker build -f apps/web/Dockerfile --build-arg API_ORIGIN=http://<api address> -t startuptn-erp-web .
```

If CloudFront sends `/api/*` straight to the API, the web server never forwards anything and `API_ORIGIN`
can be left alone. Either way the browser only talks to one address, so the session cookie is first-party
and no CORS setup is needed.

### Step by step

1. **Database.** RDS for PostgreSQL 15 or 16, in private subnets, reachable only from the API's security
   group. Turn on automated backups. Amazon RDS refuses unencrypted connections by default, so set
   `DATABASE_SSL=verify` (the API image includes the RDS certificate bundle) or `no-verify`.
2. **Documents bucket.** A private S3 bucket with Block Public Access on and default encryption. Add this CORS
   rule, with your real address in place of the example, because the browser uploads straight to S3:
   ```json
   [{ "AllowedMethods": ["PUT"], "AllowedOrigins": ["https://erp.startuptn.in"],
      "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3000 }]
   ```
   The API's IAM task role needs `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` on `bucket/*`. There are
   no access keys anywhere; the API uses the task role.
3. **Email.** Verify the sending address or domain in SES, give the task role `ses:SendEmail`, and set
   `EMAIL_DRIVER=ses`. A new SES account can only send to verified addresses until AWS grants production access.
4. **First start.** Run these as one-off tasks from the API image, with the same environment as the API:
   ```bash
   node dist/db/migrate-cli.js
   node dist/db/first-admin-cli.js --email hr@startuptn.in --name "Full Name" --code E001 --designation "HR Manager"
   ```
   Run the migration again before each release that adds one; it only applies what is new, and two at once
   cannot collide. The first-admin command refuses to run once anyone exists. (`db:seed` refuses to run in
   production by design.)
5. **Google sign-in.** In Google Cloud console create an OAuth client of type *Web application*, add the
   production address under *Authorised JavaScript origins*, and set `GOOGLE_CLIENT_ID` on the API.
   `ALLOWED_EMAIL_DOMAIN` defaults to `startuptn.in`.
6. **API environment** (put secrets in Secrets Manager and inject them into the task):

   | Variable | Value in production |
   |---|---|
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | RDS connection string (secret) |
   | `DATABASE_SSL` | `verify` or `no-verify` |
   | `JWT_SECRET` | long random value (secret) |
   | `GOOGLE_CLIENT_ID` | from step 5 |
   | `STORAGE_DRIVER` / `S3_BUCKET` / `AWS_REGION` | `s3` / bucket name / `ap-south-1` |
   | `EMAIL_DRIVER` / `EMAIL_FROM` | `ses` / verified sender |
   | `WEB_ORIGIN` | `https://erp.startuptn.in` (used for links in emails) |
   | `JOBS_TOKEN` | long random value (secret), at least 16 characters |
   | `TRUST_PROXY_HOPS` | `2` with CloudFront in front of a load balancer, `1` with a load balancer alone |
   | `BIOMETRIC_API_URL` | Optional. The machine software's Web API address (section 4). Leave empty to use file import only |
   | `BIOMETRIC_API_USER` / `BIOMETRIC_API_PASSWORD` | The API user from the machine software (secret). Required when the URL is set |
   | `BIOMETRIC_DEVICE_SERIALS` | Comma-separated serial numbers of the machines to ask. Required when the URL is set |
   | `BIOMETRIC_LOOKBACK_DAYS` | How many days back each pull asks for (1 to 31, default 2) |

   The API refuses to start in production if the secrets are still the example values, if
   `STORAGE_DRIVER` is not `s3`, or if there is no Google client ID.
7. **Schedules.** Several things only happen when something calls the API on a timer: reminders and escalation
   of unanswered approvals, sending queued emails, crediting monthly leave, bringing the attendance register
   up to date overnight, and clearing abandoned uploads. Send `POST` requests with the header
   `x-jobs-token: <JOBS_TOKEN>` (an EventBridge rule with an API destination does this):

   | Endpoint | How often |
   |---|---|
   | `/api/jobs/emails` | every minute |
   | `/api/jobs/approval-escalations` | every 15 minutes |
   | `/api/jobs/leave-accrual` | daily |
   | `/api/jobs/attendance-nightly` | daily, shortly after midnight India time |
   | `/api/jobs/documents-cleanup` | daily |
   | `/api/jobs/selfie-cleanup` | daily (deletes selfies older than the retention period) |
   | `/api/jobs/biometric-sync` | every 15 minutes (does nothing unless the machine API is configured) |

   Every job is safe to run more often than needed. Without these, nothing is lost, but approvals never
   escalate and no email goes out.
8. **Load balancer health check:** `GET /api/health` (returns `{"status":"ok"}`).
9. **HTTPS is required.** The session cookie is marked secure in production, and browsers only share location
   over HTTPS.

Everything uses India time (Asia/Kolkata) for what counts as "today" in the code, so the servers' own time zone
does not matter.

---

## 3a. Pilot on Netlify before AWS

Netlify hosts only the web app. The API (Docker, `apps/api/Dockerfile`) needs a container host such as Render,
Railway or Fly.io, plus a PostgreSQL database (Neon, Supabase or the host's own). Documents still need an S3
bucket, because the API refuses local storage in production. Off AWS, give the API `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` for an IAM user limited to that bucket.

1. Deploy the API with the variables in section 3, step 6 (`DATABASE_SSL=verify`, `EMAIL_DRIVER=log` for a pilot,
   `TRUST_PROXY_HOPS=1`, `WEB_ORIGIN` = the Netlify address), then run the migration and first-admin commands.
2. In Netlify, import this repository. `netlify.toml` sets the base directory (`apps/web`) and build command.
   Add the environment variable `API_ORIGIN=https://<api address>`; it is read at build time, so redeploy after
   changing it.
3. Add the Netlify address to the Google OAuth client's authorised origins and to the S3 bucket's CORS rule.
4. Call the `/api/jobs/*` endpoints on a timer (GitHub Actions cron or cron-job.org) with the `x-jobs-token` header.

Moving to AWS later changes only where things run: `DATABASE_URL` to RDS, a task role instead of access keys,
`EMAIL_DRIVER=ses`, EventBridge for the schedules.

---

## 4. Selfie, location and the biometric machine

**Hubs and everyone on duty: selfie and location.** Pressing *Check in* opens the camera and reads the
location at that moment; the selfie and the position are sent together and nothing is recorded before then.
There is no background tracking. The selfie is stored privately (S3 in production), shown only to the person,
their reporting line and HR, and every time someone else opens it that is written to the audit log. Photos are
deleted after the retention period by the `selfie-cleanup` job; the punch itself stays.

**Head office, Chennai: the biometric machine.** People set to "Biometric machine" have no check-in button.
Their day is worked out from the machine's punches: the first punch is the check-in, the last (at least 5
minutes later) is the check-out. Breaks in between are not deducted. A day HR has corrected by hand is left
alone. Punches reach the portal in one of two ways:

1. **File import** (works with no set-up): in *Attendance setup → Biometric machine at head office*, export
   the punch log from the machine's software and choose the file. Importing the same file twice does nothing.
2. **Automatic pull** from the eSSL eTimeTracklite Web API (the `GetTransactionsLog` call in the manual HR
   shared): set the four `BIOMETRIC_*` variables. The server must be reachable from where the API runs. A
   machine server inside the office is not reachable from AWS without a VPN or a firewall rule that allows the
   API's fixed address. The user name and password travel in the request body, so use https or a private
   network, never plain http over the internet.

Codes that no employee has yet are listed on the same screen; give each to the right person in *Employees*,
then use *Work days out again*.

**On duty: selfie for everyone.** On a day with an approved on-duty request, even a person on the machine gets
a *Check in* button and must use the selfie. The day shows as On duty either way; if the selfie was required
and none was taken, the day is marked "On duty, no selfie" for the manager and HR rather than turned into an
absence.

**One thing needs a real sample.** The manual does not show what the machine's server sends back, so the reader
accepts the usual shapes (CSV or text lines, JSON, XML) and refuses a file or answer it mostly cannot read
instead of guessing. It has not been tried against a real machine. Send HR's first real export (and, for the
automatic pull, the server's answer) and expect a small adjustment.

---

## 5. What has and has not been checked

Checked: 375 automated API tests against a real PostgreSQL (rules for attendance, selfie, biometric import, leave, approvals, OD,
documents, dashboard, jobs, config); the compiled API starting in production mode with production-only
dependencies; the migration, first-administrator and seed commands from a clean database; and walks through
the web app in a real browser (sign-in, consent, check-in with a live camera feed and location, selfie
viewing, month calendar, applying for leave, permission and on-duty, manager approval and rejection, document
upload and download, every HR screen, importing a punch file, an on-duty day for a head-office person, and a
phone-sized layout).

Not checked, because it needs your AWS account or your machine: the two Dockerfiles were written but not built
(no Docker daemon was available), nothing has run against real RDS, S3, SES, CloudFront or Google sign-in, and
nothing has run against the real biometric machine or its server. Expect a first-deploy round of small fixes
around those.

## 6. Known limits and open points

- **Withdrawing consent.** People agree to location capture and, separately, to the selfie on their first
  check-in. There is no screen yet for withdrawing either; under India's DPDP Act this should be added before
  wide rollout (for now HR would handle a withdrawal by hand).
- **A selfie is evidence, not proof.** The portal does not match the face to the person, so a photo of a photo,
  or someone else, would pass. What it gives a manager is a picture, a time and a place to look at. Whether to
  add face matching is a policy and privacy decision for later.
- **Biometric punches carry no place or photo.** They show as "Biometric machine, head office". Corrections
  to a biometric day go through the normal correction request.
- **The biometric reader is untested on the real machine** (section 4).
- **Approved attendance corrections are final.** A mistaken approval cannot be reversed from the portal.
- **Outside the office circle is flagged, not blocked.** Only a very weak GPS signal (over 500 m) is refused.
  Whether to block instead is a policy choice for HR.
- **Location accuracy.** Phones and laptops can report a position that is off by tens of metres indoors.
  Treat flags as a prompt for a conversation, not proof.
- **The API address is fixed when the web app is built** (`API_ORIGIN`). Rebuild the web image if it changes.
- **Local file storage is development only** and is refused in production.
- Web only; there is no mobile app. The layout works on a phone and checking in works from a phone browser,
  which needs permission for both the camera and the location.

## 7. Layout

```
apps/api/src
  attendance/   punches, selfies, biometric import, geofences,     leave/       types, balances (ledger), requests
                day status, corrections
  od/           on duty and permission                             approvals/   chains, escalation, stand-ins
  employees/    master data and roles                              documents/   upload, download, expiry
  dashboard/    the home screen's data                             org/         departments, holidays, notices, settings
  jobs/         scheduled entry points                             db/          migrations, seed, first-admin command
apps/web/src
  app/          pages (employee screens, then admin/*)             components/  shared interface pieces
  lib/          API client, India-time helpers, labels
```
