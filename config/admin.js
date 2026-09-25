// Admin panel + the Content Manager "Preview" button.
//
// **`PREVIEW_SECRET` has no default, and that is the point.** The shared CMS this
// was ported from carries a hardcoded 300-character fallback here, a second,
// different one in its `.env.example`, and the storefront carries a third — so
// the Preview button produces a URL the storefront rejects unless someone has
// separately set all of them to the same value, and a committed secret is a
// secret only until someone reads the repository. Here an unset `PREVIEW_SECRET`
// makes the handler return `null`: Strapi hides the Preview button rather than
// linking somewhere that will bounce the editor to the homepage, and the reason
// is in the log instead of in a support ticket.

module.exports = ({ env }) => ({
  url: env('ADMIN_PATH', '/admin'),
  auth: {
    secret: env('ADMIN_JWT_SECRET'),
  },
  apiToken: {
    salt: env('API_TOKEN_SALT'),
  },
  transfer: {
    token: {
      salt: env('TRANSFER_TOKEN_SALT'),
    },
  },
  secrets: {
    encryptionKey: env('ENCRYPTION_KEY'),
  },
  preview: {
    enabled: true,
    config: {
      allowedOrigins: [env('NEXTJS_WGB_ORIGIN', 'http://localhost:3001')],

      async handler(uid, { documentId }) {
        if (uid !== 'api::blog-post.blog-post') return null;

        const secret = env('PREVIEW_SECRET');
        if (!secret) {
          global.strapi.log.warn(
            '[preview] PREVIEW_SECRET is not set — the Preview button is disabled. ' +
              'Set it here and to the same value as BLOG_PREVIEW_SECRET on wgb-backend ' +
              'and PREVIEW_SECRET on wedding-gift-box.',
          );
          return null;
        }

        // The draft, not the published row: an editor previews what they are
        // about to publish, and a post that has never been published has no
        // published row at all.
        const post = await global.strapi
          .documents('api::blog-post.blog-post')
          .findOne({ documentId, fields: ['slug'], status: 'draft' });

        if (!post?.slug) return null;

        // One origin. The shared CMS branched on `post.website.domain` across
        // three brands; this instance only ever serves WeddingGiftBox, so the
        // branch — and the class of bug where a preview URL points at the wrong
        // brand's storefront — does not exist here.
        const baseUrl = env('NEXTJS_WGB_ORIGIN', 'http://localhost:3001');

        return (
          `${baseUrl}/api/draft` +
          `?secret=${encodeURIComponent(secret)}` +
          `&slug=${encodeURIComponent(post.slug)}`
        );
      },
    },
  },
});
