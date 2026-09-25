'use strict';

// The plain core router. The CMS this was ported from attaches a `view-tracker`
// middleware to `find` here, which increments `view_count` when it notices a
// response that looks like a single post fetched by slug. That middleware has
// not fired since WEDCRM-1881: it reads `filters[slug][$eq]` from the query,
// and the backend in front of it was changed that ticket to send
// `filters[slug][$eqi]` so a lowercase URL resolves a capitalised slug. Nothing
// failed, nothing logged — the counter simply stopped, while the storefront's
// blog card carried on rendering it.
//
// Counting views is not something to infer from the shape of somebody else's
// query string. `wgb-backend` calls `POST /api/blog-posts/increment-view`
// explicitly after a successful published read (see `routes/custom.js`), which
// is a thing that either happens or shows up in a log.

const { factories } = require('@strapi/strapi');

module.exports = factories.createCoreRouter('api::blog-post.blog-post');
