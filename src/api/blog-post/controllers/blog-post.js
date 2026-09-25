'use strict';

const { factories } = require('@strapi/strapi');

// Roles that may restore any post's versions. An Author is restricted to posts
// they created (enforced below). The limited Admin role is a peer of Editor here.
const ELEVATED_RESTORE_CODES = ['strapi-editor', 'strapi-super-admin', 'strapi-admin-limited'];

// Convert the populated objects stored in a snapshot back into the shapes that
// `strapi.documents().update()` accepts:
//
//   media (single)          → numeric id   ({ id: 12, url, ... }  →  12)
//   relations (manyToOne)   → numeric id
//   components              → strip id (Strapi rejects inline component ids on update)
//   everything else         → passed through unchanged
//
// Without this normalisation the document service silently drops the populated
// objects and only plain scalars (title, excerpt, content, category) survive the
// round trip — which presents as "restore worked but the cover image and SEO
// came back empty".
const RELATION_FIELDS = ['author'];
const MEDIA_SINGLE_FIELDS = ['coverImage'];
const COMPONENT_REPEATABLE = ['tags', 'faqs'];
const COMPONENT_SINGLE = ['seo'];

function toId(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && typeof v.id === 'number') return v.id;
  return null;
}

function stripIds(obj) {
  if (Array.isArray(obj)) return obj.map(stripIds);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) {
      if (
        k === 'id' ||
        k === 'documentId' ||
        k === 'createdAt' ||
        k === 'updatedAt' ||
        k === 'publishedAt'
      ) {
        continue;
      }
      out[k] = stripIds(obj[k]);
    }
    return out;
  }
  return obj;
}

function snapshotToUpdatePayload(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return {};
  const data = { ...snapshot };

  // The slug is deliberately NOT restored. Restoring it would either be a no-op
  // or would silently move a published URL, and the redirect that protects such
  // a move belongs to a decision an editor makes on the form, not to a rollback.
  delete data.slug;

  for (const f of MEDIA_SINGLE_FIELDS) {
    if (f in data) data[f] = toId(data[f]);
  }
  for (const f of RELATION_FIELDS) {
    if (f in data) data[f] = toId(data[f]);
  }
  for (const f of COMPONENT_REPEATABLE) {
    if (f in data) data[f] = Array.isArray(data[f]) ? data[f].map(stripIds) : [];
  }
  for (const f of COMPONENT_SINGLE) {
    if (f in data) data[f] = data[f] ? stripIds(data[f]) : null;
  }
  return data;
}

module.exports = factories.createCoreController('api::blog-post.blog-post', ({ strapi }) => ({
  /**
   * POST /api/blog-posts/increment-view
   *
   * Called by `wgb-backend` after it has served a published post. A raw Knex
   * increment rather than a document-service update, because this is the one
   * write that must not create a new draft revision, must not fire the publish
   * snapshot middleware, and must not race an editor who is mid-edit.
   *
   * `whereNotNull('published_at')` is what keeps a draft's counter at zero.
   */
  async incrementView(ctx) {
    const { slug } = ctx.request.body ?? {};
    if (!slug) return ctx.badRequest('slug is required');

    const updated = await strapi.db
      .connection('blog_posts')
      .where('slug', String(slug).toLowerCase())
      .whereNotNull('published_at')
      .increment('view_count', 1);

    ctx.body = { ok: true, updated };
  },

  /**
   * GET /api/blog-posts/preview-by-slug/:slug
   *
   * REST findMany with `status=draft` does not reliably return a post that has
   * never been published; the Document Service does. Reached only by
   * `wgb-backend`, which reaches it only for a request that carried the preview
   * secret — see `routes/custom.js`.
   */
  async previewBySlug(ctx) {
    const { slug } = ctx.params;
    if (!slug) return ctx.badRequest('slug is required');

    const [post] = await strapi.documents('api::blog-post.blog-post').findMany({
      filters: { slug: String(slug).toLowerCase() },
      status: 'draft',
      populate: {
        coverImage: { fields: ['url', 'alternativeText'] },
        author: {
          fields: ['name', 'slug', 'bio', 'profileUrl'],
          populate: { avatar: { fields: ['url', 'alternativeText'] } },
        },
        tags: true,
        seo: {
          populate: {
            metaImage: { fields: ['url', 'alternativeText'] },
            openGraph: {
              populate: { ogImage: { fields: ['url', 'alternativeText'] } },
            },
          },
        },
        faqs: true,
      },
    });

    // Shaped like a REST list response so the backend's Strapi mapper has one
    // response shape to parse rather than two.
    ctx.body = {
      data: post ? [post] : [],
      meta: {
        pagination: { page: 1, pageSize: 1, pageCount: post ? 1 : 0, total: post ? 1 : 0 },
      },
    };
  },

  /**
   * POST /admin/blog-posts/:documentId/restore/:versionId
   *
   * Mounted via `routes/admin.js` with `type: 'admin'`, so the admin JWT
   * strategy runs and `ctx.state.user` is the populated admin user.
   *
   * The CMS this was ported from also checks the caller's website scope here.
   * This instance serves one brand, so the only question left is ownership:
   * an elevated role may restore anything, an Author only their own posts.
   */
  async restoreVersion(ctx) {
    const { documentId, versionId } = ctx.params;
    const adminUser = ctx.state.user;
    if (!adminUser) return ctx.unauthorized();
    if (!documentId) return ctx.badRequest('documentId is required');
    if (!versionId) return ctx.badRequest('versionId is required');

    const post = await strapi.db
      .query('api::blog-post.blog-post')
      .findOne({ where: { documentId }, populate: ['createdBy'] });
    if (!post) return ctx.notFound('Blog post not found');

    const version = await strapi.db
      .query('api::blog-post-version.blog-post-version')
      .findOne({ where: { id: versionId }, populate: ['blogPost'] });
    if (!version || String(version.blogPost?.id) !== String(post.id)) {
      return ctx.notFound('Version does not belong to this post');
    }

    const isElevated = adminUser.roles?.some((r) => ELEVATED_RESTORE_CODES.includes(r.code));
    if (!isElevated && String(post.createdBy?.id) !== String(adminUser.id)) {
      return ctx.forbidden('You can only restore versions of your own posts');
    }

    const data = snapshotToUpdatePayload(version.snapshot);
    try {
      await strapi.documents('api::blog-post.blog-post').update({ documentId, data });
    } catch (err) {
      strapi.log.error(
        { err, documentId, versionId, dataKeys: Object.keys(data) },
        '[restoreVersion] update failed',
      );
      return ctx.internalServerError(err?.message ?? 'Restore failed');
    }

    ctx.body = {
      ok: true,
      restoredVersion: version.versionNumber,
      restoredFields: Object.keys(data),
    };
  },
}));
