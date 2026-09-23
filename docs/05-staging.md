# Staging: setup, CI/CD and deploys

Staging is switch-server-v2 on the internet, on its own Google Cloud project and its own database,
so the apps and dashboards can be tested for real without touching production. This guide sets it
up once (steps 1 to 11), then covers everyday use, rollback and troubleshooting.

Nothing here deploys to production. No workflow can: the deploy identity only exists in the staging
project.

---

## 1. How it works

```mermaid
flowchart LR
  PR[Pull request] --> CI["ci: typecheck · lint · format · tests · build · audit · gitleaks"]
  M[Push to stg<br/>or manual run] --> CI2[the same ci] --> D[deploy dist/ as a new<br/>App Engine version, no traffic]
  D --> S[smoke test that version:<br/>/health and /config] --> T[move 100% traffic to it] --> C[delete old versions,<br/>keep the newest 5]
```

- `.github/workflows/ci.yml` runs on every pull request.
- `.github/workflows/deploy-staging.yml` runs on every push to `stg` (and on demand from `stg`). It runs the
  same checks, then deploys **the exact `dist/` they built and tested**. A version that fails its
  smoke test never gets traffic: staging keeps serving the previous one.
- GitHub holds no Google key. The deploy job signs in with Workload Identity Federation, which Google
  only accepts from this repository's `stg` branch. `main` is kept for production later; nothing
  deploys from it today.
- Before deploying, `tools/deploy/staging-preflight.ts` checks that `.env.staging` matches the
  staging project (URL, secret version, Pusher ids). A half-finished setup fails there with the
  value to set, not with a crash on App Engine.

### What staging uses

| Service | Staging | Shared with production? |
|---|---|---|
| Google Cloud project, App Engine | new project, e.g. `switch-staging` | no |
| MongoDB | new Atlas cluster (free M0) | no |
| Push (Firebase) | new Firebase project | no |
| Realtime (Pusher) | new Pusher app | no |
| Email (SendGrid) | production account | **yes**, but only addresses in `MAIL_ALLOWLIST` get a real email |
| SMS (SMS Algérie) | production account | **yes**, but only numbers in `SMS_PHONE_ALLOWLIST` get a real SMS |
| Distance (Google Maps) | production key | **yes**: read-only lookups, billed to production |
| Files (DigitalOcean Spaces) | production account, **new bucket** `switchfood-staging` | the account, never the bucket |

The borrowed accounts are listed in `.env.staging` (`SHARED_PROD_CREDENTIALS=mail,sms,maps,s3`).
The server refuses to boot if one of them loses its fence (a real mail or SMS driver instead of the
allowlist, the production bucket), or if anything else points at production: the database, the
`switchfood.net` URL, the production master key or Firebase project (`src/config/guards.ts`).
When staging gets its own account for one of them, remove that name from the list.

---

## 2. Before you start

- Google Cloud CLI: `brew install --cask google-cloud-sdk`, then `gcloud auth login`.
- GitHub CLI (`gh auth login`), Node 24 and pnpm (already set up for local dev).
- Access to: a Google Cloud billing account, MongoDB Atlas, the production DigitalOcean account,
  Pusher, Firebase, GitHub.
- The production keys staging borrows are in legacy `switch-server/configs.js` (see step 7).

Set these once per terminal, in `switch-server-v2/`. Every command below runs there and uses them.

```bash
cd switch-server-v2
export PROJECT_ID=switch-staging              # globally unique: pick another if it is taken
export GITHUB_REPO=switchdevv/switch-server-v2
export REGION=$(gcloud app describe --project=switch-proj --format='value(locationId)')
echo "$REGION"                                # production's App Engine region (read-only call)
```

---

## Step 1. Google Cloud project and App Engine

```bash
gcloud projects create "$PROJECT_ID" --name="Switch staging"
gcloud billing accounts list
gcloud billing projects link "$PROJECT_ID" --billing-account=XXXXXX-XXXXXX-XXXXXX

gcloud services enable appengine.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com --project="$PROJECT_ID"

gcloud app create --region="$REGION" --project="$PROJECT_ID"   # the region can never change
gcloud app describe --project="$PROJECT_ID" --format='value(defaultHostname)'
```

The last command prints the staging host, e.g. `switch-staging.ew.r.appspot.com`. Keep it:

```bash
export HOST=$(gcloud app describe --project="$PROJECT_ID" --format='value(defaultHostname)')
export APPENGINE_SA="$PROJECT_ID@appspot.gserviceaccount.com"
```

App Engine builds and runs the app as `$APPENGINE_SA`. It needs the Editor role, which Google
normally grants it automatically. Check:

```bash
gcloud projects get-iam-policy "$PROJECT_ID" --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:$APPENGINE_SA" --format='value(bindings.role)'
```

If `roles/editor` isn't listed (some organizations block the automatic grant):

```bash
gcloud projects add-iam-policy-binding "$PROJECT_ID" --condition=None \
  --member="serviceAccount:$APPENGINE_SA" --role=roles/editor
```

Optional: Billing → Budgets & alerts → a small monthly budget on this project.

## Step 2. MongoDB Atlas

In the Atlas UI:

1. New project `Switch staging`.
2. Create a cluster: **Free (M0)**, provider **Google Cloud**, the region closest to `$REGION`
   (App Engine `europe-west` is Belgium, `europe-west1`). Name it `switch-staging`.
3. Database Access → Add user `switch-staging-server`, password: *Autogenerate* (letters and digits
   only, so nothing to escape), role *Read and write to any database*.
4. Network Access → Add IP address `0.0.0.0/0`. App Engine has no fixed outgoing address; the
   generated password and Atlas's TLS protect the cluster.
5. Connect → Drivers → copy the URI and put the database name `switch_staging` after the host:

```text
mongodb+srv://switch-staging-server:PASSWORD@switch-staging.xxxxx.mongodb.net/switch_staging?retryWrites=true&w=majority
```

M0 runs MongoDB 8.0 (Parse 9 needs 7.0.16 or later) and supports the change streams Parse's schema
hooks use. It is limited to 100 operations per second and 512 MB: enough for testing by hand, not
for the load test (plan P4-5, which needs M10 or more).

## Step 3. Spaces bucket (production account)

DigitalOcean → Spaces Object Storage → Create bucket:

- Region **FRA1** (same as production), name **`switchfood-staging`**, the same project.
- Enable the **CDN** (file URLs are `https://switchfood-staging.fra1.cdn.digitaloceanspaces.com/…`).
- File listing: restricted. Uploaded files are public-read one by one, as in production.

The production Spaces key is reused (step 7). A full-access key works on every bucket of the
account. If uploads on staging later fail with `AccessDenied`, the key is limited to some buckets:
Spaces Keys → edit it → add `switchfood-staging` with read/write/delete.

## Step 4. Pusher app

Pusher → Channels → Create app: name `switch-staging`, cluster **eu** (same as production). From
App Keys, `app_id`, `key` and `cluster` go in `.env.staging` (step 6); keep `secret` for step 7.

## Step 5. Firebase project

Firebase console → Add project → choose the existing Google Cloud project `$PROJECT_ID` (or create a
separate one). Then Project settings → Service accounts → **Generate new private key**. It downloads
a JSON file: leave it where it is until step 7, then delete it.

Pushes from staging only reach app builds registered with this Firebase project. Production builds
pointed at staging register production tokens, which staging's key can't use: their sends fail
silently, as legacy failures always did. Staging app builds (with this project's
`google-services.json` / `GoogleService-Info.plist`) are a separate step, like the `:local` scripts.

## Step 6. Fill in `.env.staging`

Edit `switch-server-v2/.env.staging`:

| Line | Value |
|---|---|
| `PARSE_PUBLIC_SERVER_URL` | `https://` + `$HOST` from step 1, e.g. `https://switch-staging.ew.r.appspot.com` |
| `SECRETS_PROJECT` | `$PROJECT_ID` |
| `PUSHER_APP_ID`, `PUSHER_KEY`, `PUSHER_CLUSTER` | step 4 |
| `MAIL_ALLOWLIST` | testers' email addresses, comma-separated. Others are only logged. |
| `SMS_PHONE_ALLOWLIST` | testers' numbers as the apps send them: `+213555123456`, comma-separated, no spaces. Others get no SMS. |

Leave `SECRETS_VERSION` empty: step 7 fills it. Check what is still missing:

```bash
pnpm staging:preflight --project "$PROJECT_ID"
```

At this point it should only complain about `SECRETS_VERSION`.

## Step 7. Secret Manager

All staging secrets live in one Secret Manager secret, `switch-server-env`, as JSON. The server
reads the version pinned in `.env.staging` at boot. Create it and let App Engine read it:

```bash
gcloud secrets create switch-server-env --replication-policy=automatic --project="$PROJECT_ID"
gcloud secrets add-iam-policy-binding switch-server-env --project="$PROJECT_ID" \
  --member="serviceAccount:$APPENGINE_SA" --role=roles/secretmanager.secretAccessor
```

Then add the first version:

```bash
pnpm staging:secret
```

It asks for each value the drivers in `.env.staging` need. Secrets are typed hidden and only ever
go to `gcloud` on its standard input:

| Asked | Where to find it |
|---|---|
| `PARSE_MASTER_KEY`, `PARSE_MAINTENANCE_KEY` | not asked: generated, staging-only |
| `DATABASE_URI` | step 2 |
| `SENDGRID_API_KEY` | production: `configs.js` → `sendgrid.apiKey` |
| `FIREBASE_SERVICE_ACCOUNT` | the path of the JSON file from step 5 |
| `PUSHER_SECRET` | step 4 |
| `SMS_API_KEY`, `SMS_USER_KEY` | production: `configs.js` → `sms.apiKey`, `sms.userKey` |
| `GOOGLE_MAPS_API_KEY` | production: `configs.js` → `google.mapKey` |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | production: `configs.js` → `spaces.s3overrides.accessKeyId`, `.secretAccessKey` |

Before sending anything it runs the server's own boot checks on the result (every value valid, the
prod-leak guard passes, the database has a name) and shows a summary without values. On `y` it adds
the version and writes `SECRETS_VERSION=1` into `.env.staging`. Delete the Firebase JSON file now.

## Step 8. Deploy identity (Workload Identity Federation)

A service account for GitHub, which Google only lets this repository's `stg` branch use:

```bash
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
export DEPLOY_SA="github-deployer@$PROJECT_ID.iam.gserviceaccount.com"

gcloud iam workload-identity-pools create github --project="$PROJECT_ID" \
  --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc switch-server-v2 \
  --project="$PROJECT_ID" --location=global --workload-identity-pool=github \
  --display-name="switch-server-v2" --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository == '$GITHUB_REPO' && assertion.ref == 'refs/heads/stg'"

gcloud iam service-accounts create github-deployer --project="$PROJECT_ID" \
  --display-name="GitHub deploys (switch-server-v2)"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --project="$PROJECT_ID" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$GITHUB_REPO"
```

What it may do: deploy App Engine versions and move traffic (App Engine Admin), run the build
(Cloud Build, Storage, Artifact Registry), act as the App Engine account, and see (not read) the
secret's versions for the preflight:

```bash
for role in roles/appengine.appAdmin roles/cloudbuild.builds.editor roles/storage.admin \
  roles/artifactregistry.reader; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --condition=None \
    --member="serviceAccount:$DEPLOY_SA" --role="$role"
done
gcloud iam service-accounts add-iam-policy-binding "$APPENGINE_SA" --project="$PROJECT_ID" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/iam.serviceAccountUser
gcloud secrets add-iam-policy-binding switch-server-env --project="$PROJECT_ID" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/secretmanager.viewer
```

## Step 9. GitHub repository and variables

```bash
gh repo create "$GITHUB_REPO" --private --source=. --remote=origin   # creates it, pushes nothing
gh variable set GCP_PROJECT_ID --repo "$GITHUB_REPO" --body "$PROJECT_ID"
gh variable set GCP_DEPLOY_SA --repo "$GITHUB_REPO" --body "$DEPLOY_SA"
gh variable set GCP_WIF_PROVIDER --repo "$GITHUB_REPO" \
  --body "projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/switch-server-v2"
```

These are repository variables, not secrets: none of them grants anything without the federation of
step 8. They work on every GitHub plan (environments with protection rules would need GitHub Pro
for a private repository).

## Step 10. First push, first deploy

```bash
pnpm check && pnpm format:check    # what ci runs, locally
pnpm staging:preflight --project "$PROJECT_ID"
git add -A
git status                         # .env.local must NOT be listed; .env.staging must be
git commit -m "switch-server-v2 with CI and staging deploys"
git switch -c stg                  # the deploy workflow watches `stg`, not `main`
git push -u origin stg
gh run watch --repo "$GITHUB_REPO"
```

The first run takes about 10 minutes (App Engine builds the image from scratch). When it is green:

```bash
curl "https://$HOST/health"        # {"status":"ok"}
```

The run's summary page shows the version, its URL and the rollback command.

## Step 11. Seed the staging database

The database is empty: no schema, no permissions, no admin. The seed fills it with the same world
as local dev (production schema and class permissions, the Staff role, the Config, cities,
restaurants with menus, managers, drivers, customers, a month of orders). It runs a throwaway server
on your machine with the staging config, because staging's master key only works from the server
itself:

```bash
gcloud auth application-default login   # the seed reads the secret with this login
SEED_PASSWORD='a-long-password-only-testers-know' pnpm seed:staging
```

Every account (`admin`, `ops`, `manager.roma`, `driver.sara`, `customer`, …) gets that password;
the seed prints the list. It refuses a password under 12 characters, and does nothing on a database
that already has users.

### Check the master key is closed

Staging accepts the master key only from the server itself (`MASTER_KEY_IPS=127.0.0.1,::1`). On
App Engine every request reaches the server from the instance's own proxy on loopback, so the
server takes the client's address from App Engine's `X-AppEngine-User-IP` header
(`CLIENT_IP_HEADER`) and never from the connection. Check that your machine is refused, both
plainly and when it claims to be the server:

```bash
KEY=$(gcloud secrets versions access "$(grep '^SECRETS_VERSION=' .env.staging | cut -d= -f2)" \
  --secret="$(grep '^SECRETS_NAME=' .env.staging | cut -d= -f2)" --project="$PROJECT_ID" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).PARSE_MASTER_KEY')
curl -s -H 'X-Parse-Application-Id: switchApp' -H "X-Parse-Master-Key: $KEY" "https://$HOST/schemas"
curl -s -H 'X-Parse-Application-Id: switchApp' -H "X-Parse-Master-Key: $KEY" \
  -H 'X-AppEngine-User-IP: 127.0.0.1' -H 'X-Forwarded-For: 127.0.0.1' "https://$HOST/schemas"
unset KEY
```

Expected, twice: `{"error":"unauthorized"}`. The server log then says `Request using master key
rejected as the request IP address '…'` with **your own public address** in it. If you get the
schemas instead, **stop**: the master key is open to the internet. Check that the deployed
`.env.staging` has `CLIENT_IP_HEADER=x-appengine-user-ip` (the server refuses to boot in staging
without it). If only the second command gets through, App Engine passed the client's header on,
which it must not do: turn the master key off (`MASTER_KEY_IPS=` empty) until that is understood.

---

## Everyday use

| Task | How |
|---|---|
| Deploy | Merge or push to `stg` (pull requests into `stg`). |
| Redeploy without a change (e.g. after a secret) | Actions → deploy-staging → Run workflow on `stg`, or `gh workflow run deploy-staging --repo "$GITHUB_REPO" --ref stg`. |
| Change a secret | `pnpm staging:secret` (Enter keeps a value), commit `.env.staging`, push. Old versions stay enabled for rollback; disable them in Secret Manager once the new one is live. |
| New master/maintenance keys | `pnpm staging:secret --new-keys` |
| Roll back | `gcloud app versions list --service=default --project="$PROJECT_ID"`, then `gcloud app services set-traffic default --splits=<version>=1 --project="$PROJECT_ID"`. The 5 newest old versions are kept. Each version keeps its own pinned secret version. |
| Logs | `gcloud app logs tail --service=default --project="$PROJECT_ID"`, or Logs Explorer in the console. |
| Stop borrowing a production account | Create the staging account, remove its name from `SHARED_PROD_CREDENTIALS`, `pnpm staging:secret` with the new key, commit, push. |
| Test automatic dispatch rounds | Staging scales to zero when idle, and the dispatch worker only runs while an instance is up. Set `min_instances: 1` in `app.staging.yaml` for the session. |

Costs: App Engine (F2) scales to zero between sessions; Atlas M0 is free; builds and stored images
are small. SMS and map lookups are billed to the production accounts; the SMS allowlist keeps that
to testers' phones.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Set these repository variables` | Step 9. |
| auth step: `unauthorized_client` / rejected by the attribute condition | The run is not on `stg`, or `$GITHUB_REPO` in the provider condition doesn't match the repository name (step 8). |
| auth step: `iam.serviceAccounts.getAccessToken` denied | The `workloadIdentityUser` binding of step 8 is missing. New bindings can take a few minutes. |
| Preflight errors | Each message names the `.env.staging` line and the value to set. Commit and push again. |
| `gcloud app deploy`: permission denied, or Cloud Build fails at once | Deployer roles (step 8), the App Engine account's Editor role (step 1), or an API that isn't enabled (step 1). |
| Smoke test: never answered `/health` | The version failed to boot; the job prints the `gcloud app logs read … --version=…` command. `Invalid environment`: a value in `.env.staging` or the secret. `Refusing to boot APP_ENV=staging`: the prod-leak guard names what points at production. `PERMISSION_DENIED` on the secret: the accessor binding of step 7. MongoDB timeout: Atlas network access (step 2) or the URI. |
| Uploads fail on staging (`AccessDenied`) | The Spaces key is limited to some buckets (step 3). |
| No OTP SMS | The number is not in `SMS_PHONE_ALLOWLIST` exactly as the app sends it (`+213…`, no spaces). |
| No email | The address is not in `MAIL_ALLOWLIST`. |
| Boot: `CLIENT_IP_HEADER must be set in staging` | `.env.staging` lost `CLIENT_IP_HEADER=x-appengine-user-ip`. Without it every request looks like it comes from the server itself and gets the master key. |
| No push | Only app builds registered with the staging Firebase project receive them (step 5). |

## Not covered here

- **Production.** No workflow deploys it. The cutover runbook is plan §10: manual, `--no-promote`,
  traffic split, after staging sign-off.
- **Client builds for staging.** Each client has its own: ops and finance deploy from their `stg`
  branch (`docs/staging.md` in each repo). The Android apps build a signed `stg` APK
  (`<app>.stg` package, the staging Firebase and Pusher apps) with `npm run android:stg`
  (`docs/staging.md` in switch-food, switch-driver, switch-manager). Once those APKs are signed,
  `SMS_RETRIEVER_HASH_*` above should hold their hashes (the build prints them). iOS and the
  dashboard have no staging build yet.
- **Plan Phase 4 itself**: the parity suite against staging, `TRUST_PROXY` (P4-3), real logins
  (P4-4), the load test (P4-5) and the client checklist (Appendix A).
