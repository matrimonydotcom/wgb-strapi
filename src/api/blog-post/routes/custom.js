'use strict';

// Custom content-API routes. Neither is granted to the Public role in
// `src/index.js` — both are reached by `wgb-backend` with an API token, and
// nothing in a browser is meant to call this API at all.
//
// `preview-by-slug` in particular must never become public. It returns the
// **draft**, and in the CMS this was ported from the equivalent path is
// reachable by anyone who appends `?preview=1` to a storefront URL: the backend
// exposed `preview` as an unauthenticated query parameter on a route documented
// "public, no auth required", and the storefront page read the flag straight
// out of `searchParams` without ever checking the secret that `/api/draft`
// validates. Here the chain is token → shared secret → draft, with no public
// hop in it.

module.exports = {
  routes: [
    {
      // Called by wgb-backend after a successful published read. Replaces the
      // `view-tracker` middleware — see `routes/blog-post.js` for why that
      // mechanism was not carried over.
      method: 'POST',
      path: '/blog-posts/increment-view',
      handler: 'blog-post.incrementView',
      config: { policies: [], middlewares: [] },
    },
    {
      // REST findMany + status=draft does not reliably return a never-published
      // draft. The Document Service does, which is why this exists rather than
      // the backend just adding `status=draft` to its own query.
      method: 'GET',
      path: '/blog-posts/preview-by-slug/:slug',
      handler: 'blog-post.previewBySlug',
      config: { policies: [], middlewares: [] },
    },
  ],
};
