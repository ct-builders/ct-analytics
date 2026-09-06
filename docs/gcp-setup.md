# Standing up ct-analytics on Google Cloud

ct-analytics needs a Postgres database and somewhere to run one Node process. On
Google Cloud that is Cloud SQL and Cloud Run, and the whole thing fits in a
handful of commands.

Any Postgres 14 or later works. Nothing in ct-analytics is Google-specific — if you
already run Postgres somewhere, set `DATABASE_URL` and skip to
[Deploy the collector](#deploy-the-collector).

## Before you start

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable sqladmin.googleapis.com run.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com
```

Pick one region and use it everywhere. A collector in a different region from
its database pays that round trip on every event.

```bash
export REGION=us-central1
export INSTANCE=clickstream-db
export DB=clickstream
```

## Create the database

```bash
gcloud sql instances create "$INSTANCE" \
  --database-version=POSTGRES_16 \
  --region="$REGION" \
  --tier=db-perf-optimized-N-2 \
  --storage-size=20GB \
  --storage-auto-increase
```

`--storage-auto-increase` matters more than the tier. Event volume grows with
traffic, and a full disk stops ingest — those events are gone, because the
browser deliberately does not retry.

Then the database and its user:

```bash
gcloud sql databases create "$DB" --instance="$INSTANCE"

# Generate the password locally; never type one into a shell you keep history for.
DB_PASSWORD="$(openssl rand -base64 32)"

gcloud sql users create clickstream_app \
  --instance="$INSTANCE" \
  --password="$DB_PASSWORD"

printf '%s' "$DB_PASSWORD" | gcloud secrets create clickstream-db-password --data-file=-
```

The password goes straight into Secret Manager and is read from there by the
deploy below. It never appears in a `.env`, a build log, or the Cloud Run
console's environment variables.

### Least privilege for the app user

`clickstream_app` needs to read and write the tables and nothing else. Connect as
the default `postgres` user once to grant that:

```bash
gcloud sql connect "$INSTANCE" --user=postgres --database="$DB"
```

```sql
-- The app owns its own schema, so migrations can create tables, and has no
-- rights over anything else in the database.
CREATE SCHEMA IF NOT EXISTS clickstream AUTHORIZATION clickstream_app;
ALTER ROLE clickstream_app SET search_path TO clickstream, public;

-- Revoke the default ability to create objects in `public`, which every new
-- Postgres role otherwise has.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

## Run the migrations

The collector applies pending migrations on boot, so a first deploy needs
nothing here. Running them deliberately first means a schema problem surfaces
now rather than as a failed deploy.

Run them as a Cloud Run job, which reaches the database over the same managed
socket the services use — no local binary, and no network path from a laptop to
the database:

```bash
gcloud run jobs create clickstream-migrate \
  --source . \
  --region="$REGION" \
  --add-cloudsql-instances="YOUR_PROJECT_ID:$REGION:$INSTANCE" \
  --set-env-vars="PGHOST=/cloudsql/YOUR_PROJECT_ID:$REGION:$INSTANCE,PGDATABASE=$DB,PGUSER=clickstream_app" \
  --set-secrets="PGPASSWORD=clickstream-db-password:latest" \
  --command=npm --args=run,migrate

gcloud run jobs execute clickstream-migrate --region="$REGION" --wait
```

Run migrations as `clickstream_app`, not as `postgres`. The tables belong in the
`clickstream` schema that role owns; created as `postgres` they land in
`public`, where `clickstream_app` cannot see them and every query fails with
*relation does not exist*.

To reach the database from a laptop instead — for an ad-hoc query, or to seed
example data — use the Cloud SQL Auth Proxy, which Google documents at
[Connecting using the Auth Proxy](https://cloud.google.com/sql/docs/postgres/connect-auth-proxy).
`gcloud sql connect` (used for the grants above) wraps the same thing for an
interactive `psql` session.

## Deploy the collector

The collector is the only part that faces the internet. Deploy it and the admin
as **two services from one image**, because their exposure is opposite: the
collector must be reachable by every shopper's browser, and the admin must not
be.

Ingest is authenticated, so mint the token first. The collector refuses to
start without a credential.

```bash
INGEST_KEY="$(openssl rand -hex 32)"
printf '%s' "$INGEST_KEY" | gcloud secrets create clickstream-ingest-key --data-file=-
```

```bash
gcloud run deploy clickstream-collector \
  --source . \
  --region="$REGION" \
  --allow-unauthenticated \
  --add-cloudsql-instances="YOUR_PROJECT_ID:$REGION:$INSTANCE" \
  --set-env-vars="MODE=collect,PGHOST=/cloudsql/YOUR_PROJECT_ID:$REGION:$INSTANCE,PGDATABASE=$DB,PGUSER=clickstream_app" \
  --set-secrets="PGPASSWORD=clickstream-db-password:latest,CLICKSTREAM_INGEST_KEY=clickstream-ingest-key:latest" \
  --min-instances=1
```

`--allow-unauthenticated` here means "no Google IAM in front"; the endpoint is
still closed, by the bearer token. Your site's proxy needs the same secret —
give its service account `roles/secretmanager.secretAccessor` on
`clickstream-ingest-key` rather than copying the value around.

Two flags are worth understanding rather than copying.

`PGHOST=/cloudsql/…` is a Unix socket, not a hostname. Cloud Run mounts the
Cloud SQL connection there when you pass `--add-cloudsql-instances`, so the
traffic never crosses a network you have to secure and there is no proxy to
run in production.

`--min-instances=1` is not about latency. A cold start on the collect endpoint
costs events: the browser sends with `keepalive` and does not retry, so a
request that times out during a cold start is a shopper journey you will never
see. One warm instance is the cheapest fix.

## Deploy the admin

```bash
ADMIN_TOKEN="$(openssl rand -hex 32)"
printf '%s' "$ADMIN_TOKEN" | gcloud secrets create clickstream-admin-token --data-file=-

gcloud run deploy clickstream-admin \
  --source . \
  --region="$REGION" \
  --no-allow-unauthenticated \
  --add-cloudsql-instances="YOUR_PROJECT_ID:$REGION:$INSTANCE" \
  --set-env-vars="MODE=admin,PGHOST=/cloudsql/YOUR_PROJECT_ID:$REGION:$INSTANCE,PGDATABASE=$DB,PGUSER=clickstream_app" \
  --set-secrets="PGPASSWORD=clickstream-db-password:latest,CLICKSTREAM_ADMIN_TOKEN=clickstream-admin-token:latest"
```

`--no-allow-unauthenticated` puts Google's own IAM in front of the admin, and
`CLICKSTREAM_ADMIN_TOKEN` sits behind that. Two layers, because the admin renders
every shopper's browsing history and the token alone is a shared secret that
tends to end up in a chat message.

For a nicer sign-in than `gcloud run services proxy`, put
[Identity-Aware Proxy](https://cloud.google.com/iap/docs/enabling-cloud-run)
in front of it and restrict access to your own domain.

## Point a site at it

Register the site first. The collector refuses events for an unknown slug,
because that is almost always a typo in a script tag and silently accepting it
produces an empty report with no explanation.

```bash
npm run site:add -- --slug acme --name "Acme Storefront" \
  --origins https://acme.example,https://www.acme.example
```

Then the script tag:

```html
<script src="https://clickstream-collector-xxxx.run.app/c.js?site=acme" defer></script>
```

## Before real traffic

Four settings, and the first two are the ones that matter.

**Keep ingest on the token, not on origins.** The token is the real control;
per-site origins only matter if you opt into browser-direct posting, where they
are required and enforced. See [security.md](security.md).

**Turn on retention.** `CLICKSTREAM_RETENTION_DAYS=180` on a scheduled job, with
`npm run retention`. A system that records shopper behaviour and never forgets
any of it is a liability rather than an asset, and how long is your decision,
not the module's.

Retention is a CLI command, not an HTTP endpoint, so it runs as a Cloud Run
job. Nothing that deletes data should be reachable over the network.

```bash
gcloud run jobs create clickstream-retention \
  --source . \
  --region="$REGION" \
  --add-cloudsql-instances="YOUR_PROJECT_ID:$REGION:$INSTANCE" \
  --set-env-vars="PGHOST=/cloudsql/YOUR_PROJECT_ID:$REGION:$INSTANCE,PGDATABASE=$DB,PGUSER=clickstream_app,CLICKSTREAM_RETENTION_DAYS=180" \
  --set-secrets="PGPASSWORD=clickstream-db-password:latest" \
  --command=npm --args=run,retention

gcloud scheduler jobs create http clickstream-retention-nightly \
  --location="$REGION" \
  --schedule="0 4 * * *" \
  --uri="https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/YOUR_PROJECT_ID/jobs/clickstream-retention:run" \
  --http-method=POST \
  --oauth-service-account-email="YOUR_SERVICE_ACCOUNT"
```

**Consider `hashCustomerRef`.** With it on, the client SHA-256s the shopper's
email in the browser and the collector never receives the address. Reports
still group by shopper.

```html
<script src="https://…/c.js?site=acme&hashCustomerRef=true" defer></script>
```

**Prefer a first-party path.** Proxy `/api/clickstream` on the site's own origin
through to the collector, and set `endpoint` to that path. The request is then
same-origin, unaffected by tracker-blocking extensions, and needs no CORS
configuration at all. `examples/storefront/server.js` is a working proxy in
about twenty lines.

## Cost

The database is the whole bill. One `db-perf-optimized-N-2` with 20 GB is
roughly $200/month at list; a low-traffic deployment is better served by
the smallest shared-core tier available in your region. Cloud Run with one warm
instance is a few dollars. Events are small — about 400 bytes a row — so 20 GB
holds tens of millions of them.

If volume outgrows a single Postgres, the shape to reach for is exporting
`events` to BigQuery on a schedule and repointing the heavier reports at it.
ct-analytics does not ship that, and the reports are written in one dialect on
purpose: writing every query twice to keep two backends in step costs more than
it saves until the volume is genuinely there.

## Troubleshooting

**Events return 404.** The site slug is not registered. `npm run site:add`.

**Events return 403 `origin not allowed`.** The site has an `origins` list that
does not include the origin the browser is on. Include the exact scheme and
host, and remember that `https://acme.example` and
`https://www.acme.example` are two origins.

**Reports are empty but the site looks instrumented.** Open **Install health**
in the admin. Events the collector refused are listed there with the reason,
which is the difference between a broken install and a site nobody visited.

**Zero-result searches is empty.** The site is not passing a result count.
A URL cannot know the total, so the automatic path deliberately omits it rather
than guessing — call `clickstream.search(term, count)` once the count is known.

**The collector cannot reach Postgres on Cloud Run.** Almost always a missing
`--add-cloudsql-instances`, or a `PGHOST` that is a hostname rather than the
`/cloudsql/…` socket path.
