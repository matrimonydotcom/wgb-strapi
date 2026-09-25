'use strict';

const qs = require('qs');
const readingTime = require('reading-time');
const striptags = require('striptags');

const { getFieldPaths } = require('./utils/field-paths');

const BLOG_POST_UID = 'api::blog-post.blog-post';
const BLOG_POST_VERSION_UID = 'api::blog-post-version.blog-post-version';
const BLOG_AUTHOR_UID = 'api::blog-author.blog-author';
const REDIRECT_UID = 'api::redirect.redirect';

const SUPER_ADMIN_CODE = 'strapi-super-admin';
const ADMIN_LIMITED_CODE = 'strapi-admin-limited';
const WGB_AUTHOR_CODE = 'wgb-author';

// Collections an Author only sees their own entries in.
//
// In the shared CMS this list is governed by a second, larger mechanism:
// `site-scope.js`, ~530 lines that answer "which brand's content may this role
// touch". That question does not exist here — this instance holds one brand —
// so own-entries scoping is the whole of it, and it applies unconditionally
// rather than being skipped for roles that were site-scoped instead.
const AUTHOR_SCOPED_UIDS = [BLOG_POST_UID, BLOG_AUTHOR_UID, BLOG_POST_VERSION_UID];

const SNAPSHOT_FIELDS = [
  'title',
  'slug',
  'excerpt',
  'content',
  'category',
  'tags',
  'h1',
  'readTimeMinutes',
  'coverImage',
  'author',
  'seo',
  'faqs',
];

// Populate every field that must survive a restore. Omitting `seo` and `faqs`
// here is the specific bug this list exists to prevent: the snapshot records
// what it was told to populate, so a field left out of the populate vanishes
// from the snapshot, and restore can never bring back what was never captured.
const SNAPSHOT_POPULATE = {
  coverImage: true,
  author: true,
  tags: true,
  faqs: true,
  seo: {
    populate: {
      metaImage: true,
      openGraph: { populate: { ogImage: true } },
    },
  },
};

function isAuthorRole(adminUser) {
  if (!adminUser?.roles?.length) return false;
  return adminUser.roles.some((r) => r.code === 'strapi-author' || r.code === WGB_AUTHOR_CODE);
}

async function snapshotPublishedBlogPost(strapi, documentId) {
  const current = await strapi.documents(BLOG_POST_UID).findOne({
    documentId,
    status: 'published',
    populate: SNAPSHOT_POPULATE,
  });
  if (!current) {
    strapi.log.warn(`[blog-post-version] No published entity for ${documentId} — snapshot skipped`);
    return null;
  }

  // The published document's internal id is the FK for blog-post-version.blogPost.
  const internalId = current.id;
  if (!internalId) {
    strapi.log.warn(`[blog-post-version] Published doc ${documentId} has no internal id`);
    return null;
  }

  const snapshot = {};
  for (const field of SNAPSHOT_FIELDS) {
    if (current[field] !== undefined) snapshot[field] = current[field];
  }

  const lastVersion = await strapi.db.query(BLOG_POST_VERSION_UID).findOne({
    where: { blogPost: internalId },
    orderBy: { versionNumber: 'desc' },
  });

  return strapi.db.query(BLOG_POST_VERSION_UID).create({
    data: {
      blogPost: internalId,
      versionNumber: (lastVersion?.versionNumber ?? 0) + 1,
      snapshot,
    },
  });
}

/**
 * Idempotent 301 upsert keyed on the unique `fromPath`. Used when a published
 * blog slug genuinely changes, so the previous URL keeps resolving.
 *
 * Worth knowing: in the estate these rows are written and then never read —
 * the content type's own description says they are "applied at the Next.js
 * middleware layer" and no middleware applies them. `wgb-backend` serves them
 * at `GET /api/v1/blog/redirects` and the storefront's middleware consumes
 * them, which is what makes writing them here mean something.
 */
async function ensureRedirect(strapi, fromPath, toPath) {
  if (!fromPath || !toPath || fromPath === toPath) return;
  try {
    const existing = await strapi.db.query(REDIRECT_UID).findOne({ where: { fromPath } });
    if (existing) {
      if (existing.toPath !== toPath || !existing.enabled) {
        await strapi.db.query(REDIRECT_UID).update({
          where: { id: existing.id },
          data: { toPath, statusCode: 'HTTP_301', enabled: true },
        });
      }
      return;
    }
    await strapi.db.query(REDIRECT_UID).create({
      data: {
        fromPath,
        toPath,
        statusCode: 'HTTP_301',
        enabled: true,
        note: 'Auto-created on published slug change',
      },
    });
  } catch (err) {
    strapi.log.warn({ err, fromPath, toPath }, '[slug-lock] redirect upsert failed');
  }
}

module.exports = {
  register({ strapi }) {
    // ─── The version-restore route, mounted on the admin router ────────────
    //
    // Registered here rather than as a `src/api/blog-post/routes/admin.js` file,
    // and that is not a style choice — a route object under `src/api/**/routes/`
    // **cannot** be an admin route. `registerAPIRoutes` in
    // `@strapi/core/dist/services/server/register-routes.js` does an
    // unconditional `router.type = 'content-api'` over every router it finds
    // there, so a file declaring `type: 'admin'` is silently overridden and
    // mounted under `/api` with the content-API auth strategy instead.
    //
    // The symptom is a pair of answers that each look like a different bug:
    // `POST /admin/blog-posts/:id/restore/:v` returns **405** (no such route, so
    // the admin SPA's catch-all answers first) and `POST /api/blog-posts/...`
    // returns **401** (an admin JWT is not a content-API credential). The
    // Restore button in the Blog Versions page fails either way.
    //
    // Registering on the admin router directly is the only shape that works.
    // The authorization itself — an elevated role, or the post's creator — is
    // in the controller.
    strapi.server.routes({
      type: 'admin',
      prefix: '/admin',
      routes: [
        {
          method: 'POST',
          path: '/blog-posts/:documentId/restore/:versionId',
          handler: 'api::blog-post.blog-post.restoreVersion',
          config: { policies: ['admin::isAuthenticatedAdmin'] },
        },
      ],
    });

    // ─── Auto-snapshot on publish ──────────────────────────────────────────
    //
    // Strapi 5 dispatches a publish through different verbs depending on the
    // entry point (the admin CM action, the document service, and some flows
    // that route via `update` with `status: 'published'`), so the action name
    // is logged on success — if snapshots ever stop appearing, the log says
    // whether the hook fired at all or fired and failed.
    strapi.documents.use(async (context, next) => {
      const result = await next();

      if (context.uid !== BLOG_POST_UID) return result;
      if (context.action !== 'publish') return result;

      const documentId = context.params?.documentId ?? result?.documentId;
      if (!documentId) {
        strapi.log.warn('[blog-post-version] publish event without documentId — skipping');
        return result;
      }

      try {
        const created = await snapshotPublishedBlogPost(strapi, documentId);
        if (created) {
          strapi.log.info(
            `[blog-post-version] Snapshot v${created.versionNumber} created for ${documentId}`,
          );
        }
      } catch (err) {
        strapi.log.error({ err, documentId }, '[blog-post-version] snapshot on publish failed');
      }

      return result;
    });

    // ─── viewCount is machine-written ──────────────────────────────────────
    //
    // The counter is incremented by `blog-post.incrementView` with raw SQL. Any
    // value arriving through the document service is human input — from the
    // admin form or a hand-made REST call — and is discarded rather than
    // trusted.
    strapi.documents.use(async (context, next) => {
      if (
        context.uid === BLOG_POST_UID &&
        (context.action === 'create' || context.action === 'update') &&
        context.params?.data &&
        'viewCount' in context.params.data
      ) {
        delete context.params.data.viewCount;
      }
      return next();
    });

    // ─── readTimeMinutes is derived, never typed ───────────────────────────
    strapi.documents.use(async (context, next) => {
      if (
        context.uid === BLOG_POST_UID &&
        (context.action === 'create' || context.action === 'update') &&
        typeof context.params?.data?.content === 'string'
      ) {
        const plain = striptags(context.params.data.content);
        const minutes = readingTime(plain).minutes;
        context.params.data.readTimeMinutes = Math.max(1, Math.ceil(minutes));
      }
      return next();
    });

    // ─── Slug normalisation, and a 301 when a published slug moves ─────────
    //
    //  - An incoming slug is always lowercased, so a capitalised one cannot be
    //    introduced and an existing one can be corrected.
    //  - Pure re-casing of a published slug (`…-Chennai` → `…-chennai`) is a
    //    no-op on the URL and needs no redirect.
    //  - A genuine change to a published slug is allowed, and records a 301
    //    from the old path so inbound links and search rankings survive it.
    strapi.documents.use(async (context, next) => {
      const isBlogWrite =
        context.uid === BLOG_POST_UID &&
        (context.action === 'create' || context.action === 'update') &&
        context.params?.data &&
        typeof context.params.data.slug === 'string';

      if (!isBlogWrite) return next();

      const incomingSlug = context.params.data.slug.toLowerCase();
      context.params.data.slug = incomingSlug;

      // A create, or a draft that has never been published, has no URL to
      // protect yet.
      if (context.action === 'create' || !context.params.documentId) {
        return next();
      }

      try {
        const existingPublished = await strapi.documents(BLOG_POST_UID).findOne({
          documentId: context.params.documentId,
          status: 'published',
          fields: ['slug'],
        });
        const oldSlug = existingPublished?.slug;
        if (oldSlug && oldSlug.toLowerCase() !== incomingSlug) {
          await ensureRedirect(strapi, `/blogs/${oldSlug}`, `/blogs/${incomingSlug}`);
        }
      } catch (err) {
        strapi.log.warn(
          { err, documentId: context.params.documentId },
          '[slug-lock] published-slug check failed',
        );
      }

      return next();
    });

    // ─── Author sees only their own entries: the homepage widgets ──────────
    //
    // The "recent documents" widgets query the database directly rather than
    // going through the document service, so they are filtered on the response.
    // Mounted on `strapi.server.router` and filtered after `await next()`,
    // because router `.use` handlers run *before* the route-level admin auth
    // strategy populates `ctx.state.user`.
    strapi.server.router.use('/content-manager/homepage', async (ctx, next) => {
      await next();

      const adminUser = ctx.state?.user;
      if (!adminUser || !isAuthorRole(adminUser)) return;

      const userId = adminUser.id;
      if (!userId || !ctx.body?.data) return;

      const data = ctx.body.data;
      for (const key of Object.keys(data)) {
        if (Array.isArray(data[key])) {
          data[key] = data[key].filter((entry) => entry?.createdBy?.id === userId);
        }
      }
      ctx.body = { ...ctx.body, data };
    });

    // ─── Author sees only their own entries: the Content Manager list ──────
    //
    // The filter is injected at the *query* layer rather than applied to the
    // response, so `pagination.total` and the page slicing both reflect only
    // the user's entries. Filtering after the fact leaves an author looking at
    // a page that says "1–10 of 47" and shows four rows.
    strapi.server.router.use('/content-manager/collection-types/:rest*', async (ctx, next) => {
      const adminUser = ctx.state?.user;
      if (!adminUser || ctx.request.method !== 'GET' || !isAuthorRole(adminUser)) {
        return next();
      }

      const url = ctx.request.url ?? '';
      if (!AUTHOR_SCOPED_UIDS.some((uid) => url.includes(uid))) return next();

      // Only the list endpoint. A single-entity URL has a documentId after the
      // uid, and injecting a `createdBy` filter there turns a 403 into a
      // confusing 404.
      //   List:   /content-manager/collection-types/api::blog-post.blog-post?...
      //   Detail: /content-manager/collection-types/api::blog-post.blog-post/abc123?...
      const afterUid = url.replace(/^.*api::[a-z0-9-]+\.[a-z0-9-]+/i, '');
      const isList = afterUid === '' || afterUid.startsWith('?');
      if (!isList) return next();

      const parsedQuery = qs.parse(ctx.request.querystring);
      ctx.request.querystring = qs.stringify(
        {
          ...parsedQuery,
          filters: {
            ...(parsedQuery.filters || {}),
            createdBy: { id: { $eq: adminUser.id } },
          },
        },
        { encodeValuesOnly: true },
      );

      return next();
    });

    // ─── Hide blog-post-version from the Content Manager sidebar ───────────
    //
    // Filtered at the response layer because the Strapi 5 admin-app menu API
    // surface moves between minor versions; filtering the source-of-truth list
    // the admin reads is stable across upgrades.
    //
    // Editors reach versions through the dedicated "Blog Versions" menu link.
    // The raw CM edit view exposes the snapshot JSON, which is neither readable
    // nor safe to hand-edit — versions are machine-written by the publish
    // middleware above.
    const HIDDEN_CM_UIDS = new Set([
      'plugin::users-permissions.user',
      BLOG_POST_VERSION_UID,
    ]);
    const filterHiddenContentTypes = (collection) =>
      Array.isArray(collection)
        ? collection.filter((ct) => !HIDDEN_CM_UIDS.has(ct?.uid))
        : collection;

    strapi.server.router.use('/content-manager/content-types', async (ctx, next) => {
      await next();
      if (ctx.body?.data) ctx.body.data = filterHiddenContentTypes(ctx.body.data);
    });
    strapi.server.router.use('/content-manager/init', async (ctx, next) => {
      await next();
      if (ctx.body?.data?.contentTypes) {
        ctx.body.data.contentTypes = filterHiddenContentTypes(ctx.body.data.contentTypes);
      }
    });

    // ─── Super Admins are not editable by non-super-admins ─────────────────
    //
    // Strapi core grants `admin::users.{create,update,delete}` as flat actions
    // with no built-in "cannot act on a super admin" condition. Without this
    // guard the limited Admin role below can promote itself: edit a super
    // admin's roles, or assign the Super Admin role on create.
    //
    // Mounted on `strapi.server.router` (not `strapi.server.use`) because router
    // middleware runs *after* admin auth has populated `ctx.state.user`. An
    // earlier `strapi.server.use` attempt fired before auth ran, so
    // `ctx.state.user` was always undefined and every request fell through the
    // guard — it looked installed and enforced nothing.
    const isSuperAdminUser = (user) => !!user?.roles?.some((r) => r?.code === SUPER_ADMIN_CODE);

    const targetIsSuperAdmin = async (id) => {
      if (!id) return false;
      const u = await strapi.db.query('admin::user').findOne({
        where: { id: Number(id) },
        populate: { roles: true },
      });
      return isSuperAdminUser(u);
    };

    const bodyAssignsSuperAdmin = async (roleRefs) => {
      if (!Array.isArray(roleRefs) || !roleRefs.length) return false;
      const ids = roleRefs.map((r) => (typeof r === 'number' ? r : r?.id)).filter(Boolean);
      if (!ids.length) return false;
      const roles = await strapi.db.query('admin::role').findMany({ where: { id: { $in: ids } } });
      return roles.some((r) => r?.code === SUPER_ADMIN_CODE);
    };

    const deny = (ctx, status, message) => {
      ctx.status = status;
      ctx.body = {
        error: {
          status,
          name: status === 401 ? 'UnauthorizedError' : 'ForbiddenError',
          message,
        },
      };
    };

    const guardUsers = async (ctx, next) => {
      const url = ctx.request.url || '';
      const method = ctx.request.method;
      if (method === 'GET' || method === 'OPTIONS' || method === 'HEAD') return next();

      const requester = ctx.state?.user;
      if (!requester) return next(); // let core reject the unauthenticated call
      if (isSuperAdminUser(requester)) return next(); // Super Admin: unrestricted

      // PUT/DELETE /admin/users/:id — refuse when the target is a Super Admin.
      const single = url.match(/^\/admin\/users\/(\d+)(?:\?|$|\/)/);
      const targetUserId = single ? single[1] : null;
      if ((method === 'PUT' || method === 'DELETE') && targetUserId) {
        if (await targetIsSuperAdmin(targetUserId)) {
          return deny(ctx, 403, 'Only Super Admins can modify Super Admin users.');
        }
      }

      // POST/PUT body — refuse create-as / promote-to Super Admin.
      if (method === 'POST' || method === 'PUT') {
        const reqRoles = ctx.request.body?.roles;
        if (reqRoles && (await bodyAssignsSuperAdmin(reqRoles))) {
          return deny(ctx, 403, 'Only Super Admins can assign the Super Admin role.');
        }
      }

      // Bulk delete: POST /admin/users/batch-delete { ids: [...] }
      if ((method === 'POST' || method === 'DELETE') && Array.isArray(ctx.request.body?.ids)) {
        for (const id of ctx.request.body.ids) {
          if (await targetIsSuperAdmin(id)) {
            return deny(ctx, 403, 'Only Super Admins can delete/modify Super Admin users.');
          }
        }
      }

      return next();
    };
    strapi.server.router.use('/admin/users', guardUsers);
    strapi.server.router.use('/admin/users/:rest*', guardUsers);

    const guardRoles = async (ctx, next) => {
      const url = ctx.request.url || '';
      const method = ctx.request.method;
      if (method === 'GET' || method === 'OPTIONS' || method === 'HEAD') return next();

      const requester = ctx.state?.user;
      if (!requester) return next();
      if (isSuperAdminUser(requester)) return next();

      const single = url.match(/^\/admin\/roles\/(\d+)(?:\?|$|\/)/);
      const targetRoleId = single ? single[1] : null;
      if ((method === 'PUT' || method === 'DELETE') && targetRoleId) {
        const role = await strapi.db
          .query('admin::role')
          .findOne({ where: { id: Number(targetRoleId) } });
        if (role?.code === SUPER_ADMIN_CODE) {
          return deny(ctx, 403, 'Only Super Admins can modify the Super Admin role.');
        }
      }
      return next();
    };
    strapi.server.router.use('/admin/roles', guardRoles);
    strapi.server.router.use('/admin/roles/:rest*', guardRoles);
  },

  async bootstrap({ strapi }) {
    // ─── Hide the machine-written fields from the edit form ────────────────
    //
    // Schema-level `visible: false` is only honoured when the content-manager
    // configuration is first generated. Once it is cached in `core_store` it
    // sticks until rewritten, so a field hidden in the schema after the first
    // boot stays on the form forever without this.
    try {
      const cmStore = strapi.store({
        type: 'plugin',
        name: 'content_manager',
        key: `configuration_content_types::${BLOG_POST_UID}`,
      });
      const cfg = await cmStore.get();
      const HIDDEN_FIELDS = ['viewCount', 'readTimeMinutes'];
      // Helper text under the Content (CKEditor) field. Kept to one short line
      // so it does not overlap the character counter CKEditor renders on the
      // same row. The desktop figure is the storefront's article container.
      const CONTENT_DESCRIPTION =
        'Recommended image widths — • Mobile: up to 360 px • Desktop: up to 1088 px';

      if (cfg) {
        let changed = false;
        for (const field of HIDDEN_FIELDS) {
          if (cfg.metadatas?.[field]?.edit?.visible !== false) {
            cfg.metadatas = cfg.metadatas || {};
            cfg.metadatas[field] = cfg.metadatas[field] || { edit: {}, list: {} };
            cfg.metadatas[field].edit = { ...(cfg.metadatas[field].edit || {}), visible: false };
            changed = true;
          }
        }
        if (cfg.metadatas?.content?.edit?.description !== CONTENT_DESCRIPTION) {
          cfg.metadatas = cfg.metadatas || {};
          cfg.metadatas.content = cfg.metadatas.content || { edit: {}, list: {} };
          cfg.metadatas.content.edit = {
            ...(cfg.metadatas.content.edit || {}),
            description: CONTENT_DESCRIPTION,
          };
          changed = true;
        }
        if (Array.isArray(cfg.layouts?.edit)) {
          const filtered = cfg.layouts.edit
            .map((row) =>
              Array.isArray(row) ? row.filter((f) => !HIDDEN_FIELDS.includes(f?.name)) : row,
            )
            .filter((row) => !Array.isArray(row) || row.length > 0);
          if (JSON.stringify(filtered) !== JSON.stringify(cfg.layouts.edit)) {
            cfg.layouts.edit = filtered;
            changed = true;
          }
        }
        if (changed) {
          await cmStore.set({ value: cfg });
          strapi.log.info(
            `[bootstrap] Stripped ${HIDDEN_FIELDS.join(', ')} from the content-manager config`,
          );
        }
      }
    } catch (err) {
      strapi.log.warn({ err }, '[bootstrap] Could not patch content-manager config');
    }

    // ─── The WGB Author role ───────────────────────────────────────────────
    //
    // Created before permissions are reconciled below, so a first boot lands a
    // usable role rather than an empty one. Idempotent, keyed on the code.
    try {
      const existing = await strapi.db
        .query('admin::role')
        .findOne({ where: { code: WGB_AUTHOR_CODE } });
      if (!existing) {
        await strapi.service('admin::role').create({
          name: 'WGB Author',
          code: WGB_AUTHOR_CODE,
          description:
            'Writes and manages their own WeddingGiftBox blog content. Sees only entries they created.',
        });
        strapi.log.info(`[bootstrap] Created admin role "${WGB_AUTHOR_CODE}"`);
      }
    } catch (err) {
      strapi.log.warn({ err }, '[bootstrap] Could not ensure the WGB Author role');
    }

    // ─── The WGB Author role's permissions ─────────────────────────────────
    //
    // Reconciled with `assignPermissions`, exactly like the limited Admin role
    // below, and for the same reason: it takes the whole intended set and makes
    // the stored rows match it, so this block is the role's definition and the
    // operation is idempotent by construction.
    //
    // The CMS this was ported from hand-rolls this instead — find the existing
    // row, diff its `properties.fields`, update in place — and that code is
    // broken in a way worth recording, because it looks like it works:
    //
    //   strapi.db.query('admin::permission').findOne({
    //     where: { role: role.id, subject, action },   // ← role is a RELATION
    //   })
    //
    // A relation has to be matched as `role: { id: role.id }`. Given a scalar,
    // the role half of the filter does not apply, so `findOne` answers with the
    // lowest-id row for that subject+action **belonging to whichever role owns
    // it** — in a fresh install, Editor's. The diff is then computed against
    // another role's field list and is never empty, so every boot logs
    // "Added 11 blog-post field(s)" forever, having compared the wrong row and
    // written the result to it. Nothing fails, and the log reads like progress.
    //
    // `assignPermissions` has no such lookup to get wrong.
    try {
      const role = await strapi.db
        .query('admin::role')
        .findOne({ where: { code: WGB_AUTHOR_CODE } });

      if (role) {
        // Full CRUD + publish on their own content. "Their own" is enforced in
        // `register()` by the Content Manager list filter, not here — a
        // permission grants the action, the filter decides which rows it can
        // reach.
        const AUTHOR_FULL_SUBJECTS = [BLOG_POST_UID, BLOG_AUTHOR_UID];
        const AUTHOR_FULL_ACTIONS = [
          'plugin::content-manager.explorer.create',
          'plugin::content-manager.explorer.read',
          'plugin::content-manager.explorer.update',
          'plugin::content-manager.explorer.delete',
          'plugin::content-manager.explorer.publish',
        ];
        // Read-only. Redirects are written by the slug middleware and versions
        // by the publish middleware; an author reads both and edits neither.
        const AUTHOR_READ_SUBJECTS = [REDIRECT_UID, BLOG_POST_VERSION_UID];
        // Cover images are required on a post, so the media library is not
        // optional for this role.
        const AUTHOR_PLUGIN_ACTIONS = [
          'plugin::upload.read',
          'plugin::upload.assets.create',
          'plugin::upload.assets.update',
          'plugin::upload.assets.download',
          'plugin::upload.assets.copy-link',
          'plugin::seo.read',
        ];

        const permissions = [];
        for (const subject of AUTHOR_FULL_SUBJECTS) {
          for (const action of AUTHOR_FULL_ACTIONS) {
            if (
              action === 'plugin::content-manager.explorer.publish' &&
              !strapi.contentTypes?.[subject]?.options?.draftAndPublish
            ) {
              continue; // blog-author has no draft/publish cycle
            }
            permissions.push({
              action,
              subject,
              properties: { fields: getFieldPaths(strapi, subject) },
              conditions: [],
            });
          }
        }
        for (const subject of AUTHOR_READ_SUBJECTS) {
          permissions.push({
            action: 'plugin::content-manager.explorer.read',
            subject,
            properties: { fields: getFieldPaths(strapi, subject) },
            conditions: [],
          });
        }
        for (const action of AUTHOR_PLUGIN_ACTIONS) {
          permissions.push({ action, subject: null, properties: {}, conditions: [] });
        }

        await strapi.service('admin::role').assignPermissions(role.id, permissions);
        strapi.log.info(
          `[bootstrap] Synced ${permissions.length} permissions for role "${WGB_AUTHOR_CODE}"`,
        );
      }
    } catch (err) {
      strapi.log.warn({ err }, '[bootstrap] Could not sync the WGB Author role');
    }

    // ─── Tighten Strapi's built-in Author and Editor roles ─────────────────
    //
    // These two ship with Strapi and are assignable whether or not anyone uses
    // them, so the menu items and the write actions that should not exist here
    // are revoked from them too:
    //
    //  - Content-Type Builder read and Marketplace read (hides the menu items)
    //  - every write on blog-post-version — versions are machine-written; read
    //    is granted in exchange, because without it the custom Blog Versions
    //    page fails with "Policy Failed", which reads like a bug in the page
    //    rather than a missing permission.
    //
    // A revoke only, never a redefinition: `assignPermissions` would replace
    // Strapi's own definition of these roles wholesale, and what they grant
    // beyond this is Strapi's business.
    try {
      const REVOKE_ACTIONS = ['plugin::content-type-builder.read', 'admin::marketplace.read'];
      const CM_WRITE_ACTIONS = [
        'plugin::content-manager.explorer.create',
        'plugin::content-manager.explorer.update',
        'plugin::content-manager.explorer.delete',
        'plugin::content-manager.explorer.publish',
      ];
      const CM_READ_ACTION = 'plugin::content-manager.explorer.read';

      for (const code of ['strapi-author', 'strapi-editor']) {
        const role = await strapi.db.query('admin::role').findOne({ where: { code } });
        if (!role) continue;

        // `role: { id }`, not `role: id` — see the note above.
        const toDelete = await strapi.db.query('admin::permission').findMany({
          where: {
            role: { id: role.id },
            $or: [
              { action: { $in: REVOKE_ACTIONS } },
              { subject: BLOG_POST_VERSION_UID, action: { $in: CM_WRITE_ACTIONS } },
            ],
          },
        });
        for (const perm of toDelete) {
          await strapi.db.query('admin::permission').delete({ where: { id: perm.id } });
        }
        if (toDelete.length) {
          strapi.log.info(
            `[bootstrap] Revoked ${toDelete.length} permission(s) from role "${code}" ` +
              '(CTB + marketplace + version writes)',
          );
        }

        const existingRead = await strapi.db.query('admin::permission').findOne({
          where: {
            role: { id: role.id },
            subject: BLOG_POST_VERSION_UID,
            action: CM_READ_ACTION,
          },
        });
        if (!existingRead) {
          await strapi.service('admin::role').addPermissions(role.id, [
            {
              action: CM_READ_ACTION,
              subject: BLOG_POST_VERSION_UID,
              properties: { fields: getFieldPaths(strapi, BLOG_POST_VERSION_UID) },
              conditions: [],
            },
          ]);
          strapi.log.info(`[bootstrap] Granted blog-post-version read to role "${code}"`);
        }
      }
    } catch (err) {
      strapi.log.warn({ err }, '[bootstrap] Could not tighten the built-in Author/Editor roles');
    }

    // ─── The limited "Admin" role ──────────────────────────────────────────
    //
    // Manages all blog content, the media library and roles/users, but not the
    // Content-Type Builder, the Marketplace, Webhooks, API Tokens, Transfer
    // Tokens or Project Settings.
    //
    // `assignPermissions` reconciles to exactly the listed set on every start,
    // so removing an action from these lists revokes it too — this block is the
    // role's definition, not a one-time seed.
    try {
      let adminRole = await strapi.db
        .query('admin::role')
        .findOne({ where: { code: ADMIN_LIMITED_CODE } });
      if (!adminRole) {
        adminRole = await strapi.service('admin::role').create({
          name: 'Admin',
          code: ADMIN_LIMITED_CODE,
          description:
            'Limited admin: blog content + media library + SEO + role/user management. No CTB, marketplace, webhooks, tokens, or project settings.',
        });
        strapi.log.info(`[bootstrap] Created admin role "${ADMIN_LIMITED_CODE}"`);
      }

      const CT_FULL_CRUD_SUBJECTS = [BLOG_AUTHOR_UID, BLOG_POST_UID, REDIRECT_UID];
      // Versions are written by the publish middleware and must never be
      // hand-edited. Read-only for everyone except Super Admin, which Strapi
      // never restricts.
      const CT_READ_ONLY_SUBJECTS = [BLOG_POST_VERSION_UID];
      const CT_FULL_ACTIONS = [
        'plugin::content-manager.explorer.create',
        'plugin::content-manager.explorer.read',
        'plugin::content-manager.explorer.update',
        'plugin::content-manager.explorer.delete',
        'plugin::content-manager.explorer.publish',
      ];
      const CT_READ_ACTIONS = ['plugin::content-manager.explorer.read'];
      const PLUGIN_ACTIONS = [
        'plugin::upload.read',
        'plugin::upload.configure-view',
        'plugin::upload.assets.create',
        'plugin::upload.assets.update',
        'plugin::upload.assets.download',
        'plugin::upload.assets.copy-link',
        'plugin::upload.settings.read',
        'plugin::seo.read',
      ];
      const SETTINGS_ACTIONS = [
        'admin::roles.create',
        'admin::roles.read',
        'admin::roles.update',
        'admin::roles.delete',
        'admin::users.create',
        'admin::users.read',
        'admin::users.update',
        'admin::users.delete',
      ];

      // Every content-type permission MUST carry an explicit `fields` array —
      // Strapi 5's ListViewPage calls `.filter()` on it and crashes on
      // null/undefined.
      const buildCtPermission = (subject, action) => ({
        action,
        subject,
        properties: { fields: getFieldPaths(strapi, subject) },
        conditions: [],
      });

      const permissions = [];
      for (const subject of CT_FULL_CRUD_SUBJECTS) {
        for (const action of CT_FULL_ACTIONS) permissions.push(buildCtPermission(subject, action));
      }
      for (const subject of CT_READ_ONLY_SUBJECTS) {
        for (const action of CT_READ_ACTIONS) permissions.push(buildCtPermission(subject, action));
      }
      for (const action of [...PLUGIN_ACTIONS, ...SETTINGS_ACTIONS]) {
        permissions.push({ action, subject: null, properties: {}, conditions: [] });
      }

      await strapi.service('admin::role').assignPermissions(adminRole.id, permissions);
      strapi.log.info(
        `[bootstrap] Synced ${permissions.length} permissions for role "${ADMIN_LIMITED_CODE}"`,
      );
    } catch (err) {
      strapi.log.warn({ err }, '[bootstrap] Could not create/refresh the limited Admin role');
    }

    // ─── What the Public role may do ───────────────────────────────────────
    //
    // Granted: `find`/`findOne` on the three collections the storefront's blog
    // renders. The custom routes are deliberately absent — `previewBySlug`
    // returns drafts and `incrementView` is a write, and both are reached with
    // an API token instead.
    //
    // **Revoked: every `users-permissions.auth.*` route.** Strapi enables these
    // on the Public role out of the box, which on a fresh install means
    // `POST /api/auth/local/register` answers an anonymous caller with a real
    // user row and a signed JWT. That default makes sense for a Strapi serving
    // an app with end-user accounts. This one has none: `wgb-backend` uses an
    // API token, the storefront never authenticates here, and `up_users` is
    // meant to stay empty — so the whole set is an open door onto a service
    // that has no use for it. Verified against a fresh boot of this repo before
    // the revoke was added: the register call returned 200 with a JWT.
    try {
      const publicRole = await strapi
        .query('plugin::users-permissions.role')
        .findOne({ where: { type: 'public' } });

      if (publicRole) {
        const publicRoutes = [
          { uid: BLOG_POST_UID, actions: ['find', 'findOne'] },
          { uid: BLOG_AUTHOR_UID, actions: ['find', 'findOne'] },
          { uid: REDIRECT_UID, actions: ['find'] },
        ];
        for (const { uid, actions } of publicRoutes) {
          for (const action of actions) {
            const key = `${uid}.${action}`;
            const exists = await strapi
              .query('plugin::users-permissions.permission')
              .findOne({ where: { role: publicRole.id, action: key } });
            if (!exists) {
              await strapi
                .query('plugin::users-permissions.permission')
                .create({ data: { role: publicRole.id, action: key, enabled: true } });
            }
          }
        }

        // A row existing IS the grant — Strapi 5 dropped the `enabled` column,
        // so revoking means deleting the row.
        const authPermissions = await strapi
          .query('plugin::users-permissions.permission')
          .findMany({
            where: {
              role: publicRole.id,
              action: { $startsWith: 'plugin::users-permissions.auth.' },
            },
          });
        for (const perm of authPermissions) {
          await strapi
            .query('plugin::users-permissions.permission')
            .delete({ where: { id: perm.id } });
        }
        if (authPermissions.length) {
          strapi.log.info(
            `[bootstrap] Revoked ${authPermissions.length} users-permissions auth route(s) ` +
              'from the Public role (self-registration, password reset, OAuth callbacks) — ' +
              'this CMS has no end-user accounts',
          );
        }
      }
    } catch (err) {
      strapi.log.warn({ err }, '[bootstrap] Could not reconcile the Public role permissions');
    }

    // ─── API tokens for wgb-backend ────────────────────────────────────────
    //
    // Three, scoped differently on purpose. The access key is only ever
    // returned at creation, so it is logged once, here, and cannot be recovered
    // afterwards — regenerate from Settings → API Tokens if it is lost.
    //
    // The view counter gets its own `custom` token rather than reusing the
    // preview token, because the preview token is full-access: it can read
    // every draft in the CMS, and it should be held by exactly the one code
    // path that has already checked the preview secret.
    const TOKENS = [
      {
        name: 'wgb-backend-reader',
        description: 'Read-only. Published blog content for the storefront.',
        type: 'read-only',
        envVar: 'STRAPI_API_TOKEN',
      },
      {
        name: 'wgb-backend-preview',
        description:
          'Full access — reads drafts. Used only behind wgb-backend\'s preview-secret check.',
        type: 'full-access',
        envVar: 'STRAPI_PREVIEW_TOKEN',
      },
      {
        name: 'wgb-backend-view-counter',
        description: 'Custom — may only increment a published post\'s view count.',
        type: 'custom',
        permissions: ['api::blog-post.blog-post.incrementView'],
        envVar: 'STRAPI_VIEW_TOKEN',
      },
    ];

    for (const { name, description, type, permissions, envVar } of TOKENS) {
      try {
        const exists = await strapi.query('admin::api-token').findOne({ where: { name } });
        if (exists) continue;
        const token = await strapi.service('admin::api-token').create({
          name,
          description,
          type,
          ...(permissions ? { permissions } : {}),
        });
        strapi.log.info(`[bootstrap] ${envVar}=${token.accessKey}  ← copy to wgb-backend .env`);
      } catch (err) {
        strapi.log.warn({ err, name }, '[bootstrap] Could not create API token');
      }
    }
  },
};
