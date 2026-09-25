# wgb-strapi

Strapi 5 CMS for the **WeddingGiftBox** blog. Source of truth for the blog
content-type schemas, components and plugin configuration.

Read by [`wgb-backend`](https://github.com/matrimonydotcom/wgb-backend)
server-to-server with an API token; `wgb-backend` serves the storefront at
`/api/v1/blog/*`, and [`wedding-gift-box`](https://github.com/matrimonydotcom/wedding-gift-box)
renders it at `/blogs`. Nothing in a browser talks to this service directly.

```
wgb-strapi ──token──▶ wgb-backend ──▶ wedding-gift-box
```

## Why this exists separately

The WGB blog previously lived in `weddingservices-strapi`, one CMS serving three
brands — `mandap.com`, `weddingbazaar.com` and `weddinggiftbox.com` — kept apart
by a `website` relation on every entry and ~530 lines of per-brand access
control. This instance serves one brand, so none of that is here: no `website`
content type, no site-scope middleware, and no `?domain=` parameter on any read.

**This repo does not import from, call, or deploy alongside
`weddingservices-strapi` or `weddingservices-backend`.** They are reference
material for how the blog behaves, nothing more.

## Local development

```bash
docker compose -f docker/docker-compose.yml up -d   # Postgres on :5434
cp .env.example .env                                # fill in APP_KEYS and the salts
npm install
npm run develop
```

Open <http://localhost:1337/admin> and create the first administrator.

On the first boot the bootstrap logs three API tokens — `STRAPI_API_TOKEN`,
`STRAPI_PREVIEW_TOKEN` and `STRAPI_VIEW_TOKEN`. **Copy them then**: Strapi only
ever returns an access key at creation. If you lose one, regenerate it from
Settings → API Tokens.

Modelling work in the Content-Type Builder writes JSON files under `src/api/` and
`src/components/` — commit them.

## What the CMS does on its own

| Behaviour | Where |
| --- | --- |
| Snapshots the post into `blog-post-version` on every publish | `src/index.js` |
| Computes `readTimeMinutes` from the content | `src/index.js` |
| Discards any `viewCount` written through the admin or REST | `src/index.js` |
| Lowercases every slug, and records a 301 when a **published** slug changes | `src/index.js` |
| Shows an Author only the entries they created | `src/index.js` |
| Restores a version onto the current draft | `src/api/blog-post/controllers/blog-post.js` |
| Increments `view_count` when `wgb-backend` says a post was served | `src/api/blog-post/controllers/blog-post.js` |

Authors reach version history through the **Blog Versions** menu item, not the
Content Manager — the raw entry exposes the snapshot JSON, which is neither
readable nor safe to hand-edit.

## Roles

| Role | Code | Can |
| --- | --- | --- |
| Super Admin | `strapi-super-admin` | everything (Strapi built-in) |
| Admin | `strapi-admin-limited` | all blog content, media, SEO, roles and users. Not CTB, Marketplace, Webhooks, Tokens or Project Settings |
| WGB Author | `wgb-author` | create/edit/publish **their own** posts and authors; read-only version history |

Role permissions are reconciled on every boot from `src/index.js`, so the code is
the definition — an action removed from those lists is revoked on the next start.

## Deliberate differences from `weddingservices-strapi`

Every feature is carried over. These five behaviours are not, because each was a
defect rather than a design decision:

1. **Draft preview is not publicly reachable.** In the shared estate `preview` is
   an unauthenticated query parameter on a route documented "public, no auth
   required", and the storefront page reads the flag straight out of
   `searchParams` — so appending `?preview=1` to any URL returns the draft. Here
   the chain is API token → shared secret → draft, with no public hop.
2. **View counts actually increment.** The estate's `view-tracker` middleware
   matches `filters[slug][$eq]` while the backend in front of it sends `$eqi`, so
   the counter has not moved since WEDCRM-1881 while the storefront kept
   rendering it. That middleware is not ported; `wgb-backend` calls
   `POST /api/blog-posts/increment-view` explicitly instead.
3. **No committed secrets.** The estate hardcodes a 300-character
   `PREVIEW_SECRET` fallback in `config/admin.js` and a second, different one in
   `.env.example`; the storefront carries a third. None match. Here an unset
   secret disables the Preview button and logs why.
4. **One set of S3 variable names.** The estate's `config/plugins.js` reads
   `AWS_S3_BUCKET_NAME` / `S3_URL_PATH` while its README, `.env.example` and its
   Terraform module all set `AWS_BUCKET` / `AWS_UPLOAD_PATH` — so an environment
   configured from the docs falls through to that file's default, which is the
   shared **production** CDN bucket. Here the names match, and an unset bucket
   means local disk.
5. **`publishedAt` is served as ISO 8601.** The estate returns a formatted
   `en-GB` string that the storefront prints verbatim *and* emits as JSON-LD
   `datePublished`, where it is invalid. Formatting is the storefront's job.

Also not carried over, because it has nothing to act on in an empty CMS: the
legacy-blog migration tooling and its admin button, the icon font and
`blog-content.css` that preview a legacy "Book Trusted Vendors" widget, and the
publish webhook — its only job in the estate is to call a Next.js revalidation
URL that does not exist.

## Two bugs found while porting

Both exist in `weddingservices-strapi` today and were fixed rather than copied.
Recorded here because each presents as something other than what it is.

**1. The version Restore button cannot have worked.** The estate declares the
restore route in `src/api/blog-post/routes/admin.js` with `type: 'admin'`. But
`registerAPIRoutes` in `@strapi/core` does an unconditional
`router.type = 'content-api'` over every router under `src/api/**/routes/`, so
the declaration is overridden and the route mounts under `/api` with the
content-API auth strategy. `POST /admin/blog-posts/…/restore/…` answers **405**
(the admin SPA catch-all) and `POST /api/blog-posts/…/restore/…` answers **401**
(an admin JWT is not a content-API credential). Here the route is registered on
the admin router from `src/index.js`, which is the only shape that works — and is
the same conclusion that repo reached for its *migration* routes without
applying it to this one.

**2. Role permissions were reconciled against the wrong role.** The estate looks
up an existing permission row with

```js
strapi.db.query('admin::permission').findOne({
  where: { role: role.id, subject, action },   // role is a RELATION
})
```

A relation must be matched as `role: { id: role.id }`. Given a scalar, the role
half of the filter does not apply and `findOne` returns the lowest-id row for
that subject and action whichever role owns it — Editor's, on a fresh install.
The field-list diff is then computed against another role's row, is never empty,
and every boot logs `Added 11 blog-post field(s)` forever while writing the
result to the wrong row. Here the author role is reconciled with
`assignPermissions`, which has no lookup to get wrong; a `psql` diff of
`admin_permissions` across two consecutive boots is now identical.

## Known placeholder

`src/components/blog/blog-tag.json` carries the shared CMS's six tag values
verbatim, and they are Mandap's (`Mandap Decor`, `Venues`, …), not WGB's.
**Replace the enum before any content is authored** — changing an enum after
entries reference it means a data migration.
