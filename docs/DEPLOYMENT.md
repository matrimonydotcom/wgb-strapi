# Deploying wgb-strapi to dev

## What is here, and what is not

This repository now carries everything the **app plane** owns:

| File | What it does |
| --- | --- |
| `docker/Dockerfile` | the runtime image |
| `.dockerignore` | keeps `.env`, local uploads and host `node_modules` out of it |
| `ecs/taskdef.dev.json` | the task definition, with env values and secret *references* |
| `.github/workflows/deploy-dev.yml` | build → push → render → deploy, on push to `main` |

**None of the infrastructure exists.** The workflow is committed so the app side
can be reviewed now; run it today and it fails at the first AWS call. That is
deliberate.

## Verified so far

The image was built and run against a real Postgres before any of this was
written down:

- builds, admin panel compiled in the image (~43s)
- boots and answers `/_health` with 204 in ~15 seconds
- runs as `nodeuser` (uid 1001), not root
- `/admin` serves, and `/api/blog-posts` answers with the backend's read token

One bug was found this way and fixed: excluding `public/uploads` from the build
context made the container exit 1 at boot whenever `AWS_BUCKET` is unset,
because the upload plugin falls back to the local provider and refuses to start
without that directory. The runtime stage now recreates it.

## The blocker: `modules/strapi` cannot be used

`platform-engineering/modules/strapi` exists, and calling it from `dev-wgb`
does not work, for two independent reasons:

1. **It hardcodes `service_name = "strapi"`** (`modules/strapi/main.tf:68,97,139`).
   Every derived name — ECR repo, task family, log group, security group, IAM
   roles, target group — keys off `environment` alone. A call in `dev-wgb`
   collides head-on with the existing `dev-weddingservice` Strapi in the same
   account and VPC.
2. **It requires a plaintext `db_password`**, but `environments/dev-wgb/rds.tf:18`
   sets `manage_master_user_password = true` on purpose, so there is no
   password in Terraform state to hand it.

`environments/dev-manyjobs/strapi-cms.tf` is the precedent for sidestepping the
module and wiring `modules/ecs-service` directly. **This is a
platform-engineering change, not an app one.**

## What must exist before the workflow can run

Named to match `wgb-backend`, which shares the cluster:

| Resource | Name |
| --- | --- |
| ECR repository | `dev-wgb-strapi` |
| ECS service (cluster `dev-wgb`) | `dev-wgb-strapi` |
| Task execution role | `dev-wgb-strapi-ecs-exec-role` |
| Task role | `dev-wgb-strapi-ecs-task-role` |
| GitHub OIDC role | `dev-wgb-strapi-github-actions-role` |
| Secrets Manager secret | `wgb-dev-wgb-strapi-secrets` |
| CloudWatch log group | `/ecs/dev-wgb-strapi` |
| ALB listener rule + hostname | see open question 1 |
| S3 bucket for uploads | see open question 2 |
| GitHub repository variable | `AWS_ACCOUNT_ID` (nonprod account id, not a secret) |

The task role needs `s3:PutObject`/`GetObject`/`DeleteObject` on the uploads
bucket. The execution role needs `secretsmanager:GetSecretValue` on the secret
above, and pull access to the ECR repo.

The ALB target group health check must point at **`/_health`** — it returns 204
with no database round trip. `/admin` redirects (302) and `/` is not a health
signal.

## Secret values to seed

Eight keys go into `wgb-dev-wgb-strapi-secrets`, set out-of-band with
`aws secretsmanager put-secret-value` — never by the workflow, never in
Terraform state.

| Key | Notes |
| --- | --- |
| `DATABASE_PASSWORD` | |
| `APP_KEYS` | comma-separated, four values |
| `API_TOKEN_SALT` | **changing this invalidates every API token** |
| `ADMIN_JWT_SECRET` | |
| `TRANSFER_TOKEN_SALT` | |
| `JWT_SECRET` | users-permissions plugin |
| `ENCRYPTION_KEY` | |
| `PREVIEW_SECRET` | must equal `BLOG_PREVIEW_SECRET` on `wgb-backend` **and** on `wedding-gift-box` |

Generate as `.env.example` documents:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log(Array.from({length:4},()=>require('crypto').randomBytes(16).toString('base64')).join(','))"
```

## First deploy, in order

The order is forced — the backend cannot be configured until Strapi exists to
mint its tokens.

1. Platform creates the resources above.
2. Seed the eight secret values.
3. Fill the seven `REPLACE_ME__` placeholders in `ecs/taskdef.dev.json`. The
   workflow refuses to deploy while any remain.
4. Merge to `main`. Strapi boots and creates its own schema from the
   content-type JSON in `src/`.
5. Create the first admin user at `https://<hostname>/admin`.
6. **Mint three API tokens** in the admin panel and hand them to `wgb-backend`:
   `STRAPI_READ_TOKEN`, `STRAPI_PREVIEW_TOKEN`, `STRAPI_VIEW_TOKEN`.
7. Only then deploy `wgb-backend`, then `wedding-gift-box`.

## Open questions

These block the deploy, not the code:

1. **The admin hostname** (e.g. `dev-wgb-blogs.weddinggiftbox.com`) — it goes
   into `PUBLIC_URL`, the CORS list, the CSP `frame-ancestors` list, the preview
   handler and the ALB listener rule.
2. **The uploads bucket and its CDN host.** `dev-wgb` exists as a bucket; is
   there a CloudFront/Akamai host in front? That host must also be added to
   `wedding-gift-box`'s `next.config.ts` `remotePatterns`, or every cover image
   and avatar 400s.
3. **Super-admin email(s)** for the first admin user.
4. **The database — decided, but DevOps has two things to create.** The dev
   RDS already exists and already serves `wgb-backend`: instance
   `wgb-postgres`, database `weddinggiftbox`, master user `wgbadmin`
   (`environments/dev-wgb/terraform.tfvars`). Strapi reuses the same instance
   and the same database, but needs:

   - **its own schema**, `strapi`, not the backend's `weddinggiftbox` schema.
     There are no table-name collisions — the backend prefixes everything
     `wgb_`/`mmw_` — but 51 Strapi tables do not belong mixed in with it.
     **Strapi will not create the schema**, only tables inside one, so it must
     exist before first boot.
   - **its own role**, `strapi`, not `wgbadmin`. Strapi needs CREATE/ALTER/DROP
     and the master user holds those over the backend's schema too. Its
     password goes into `wgb-dev-wgb-strapi-secrets` as `DATABASE_PASSWORD`,
     which also sidesteps the `manage_master_user_password = true` problem
     entirely — no master password has to leave its AWS-managed secret.

   ```sql
   CREATE ROLE strapi LOGIN PASSWORD '<generated>';
   CREATE SCHEMA strapi AUTHORIZATION strapi;
   ```

   Only `DATABASE_HOST` is still unknown — the instance endpoint, which is the
   `rds_info.address` Terraform output.

   Worth raising: the instance is **`db.t4g.micro`** — 2 burstable vCPU, 1 GiB
   RAM — and would then carry both services. Probably fine for dev; Strapi does
   a burst of DDL introspection on every boot, so it is the first thing to look
   at if deploys get slow.
5. **Storefront origin** for `NEXTJS_WGB_ORIGIN` — presumably
   `https://dev-wgb-app.weddinggiftbox.com`, worth confirming.

## Known characteristics, recorded rather than fixed

**The image is large — about 3 GB, of which `node_modules` is 2.2 GB**
(`@strapi` alone is 1.3 GB). Strapi ships its build toolchain — `@swc`,
`typescript`, the CKEditor sources — in `dependencies`, so a production install
cannot prune them, and the admin is already built into `build/` (18 MB) by the
time they stop being needed. Pruning is possible but fragile: Strapi resolves
plugins by walking `node_modules` at boot, so a wrong removal fails at runtime
rather than at build. Worth doing with measurement, as its own task. Until
then, expect slow ECS pulls and ECR storage cost on every deploy.

**Public read is enabled on the content API.** `GET /api/blog-posts` answers
200 with no token — the bootstrap grants the Public role `find`/`findOne` on
`blog-post`, `blog-author` and `redirect`. That is by design, and it is also
why self-registration was revoked. It does mean an internet-facing CMS serves
content directly, bypassing the backend's rate limiting. Fine for a public
blog; worth a deliberate decision before this fronts anything else.

**No migration step in the workflow**, unlike `wgb-backend`. Strapi applies its
own schema changes at boot. A separate migrate task would race the service for
the same DDL.

**TLS to the database is encrypted but not verified.**
`DATABASE_SSL_REJECT_UNAUTHORIZED` is `false`, matching how `wgb-backend`
connects (`sslmode=require`, which encrypts without checking the certificate).
Turning verification on is better and probably works — modern RDS certificates
chain to Amazon Root CA 1, which is in the base image's trust store — but
"probably" here means a crash loop on first deploy, so it wants confirming
against the actual instance rather than assuming.

**No otel-collector sidecar**, unlike `wgb-backend`. Strapi is not instrumented
for OTEL, so the sidecar would cost 128 MiB to collect nothing. Logs still go
to Loki through the firelens `log_router`.
