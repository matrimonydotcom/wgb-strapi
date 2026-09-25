// CSP allows the CKEditor CDN assets the editor loads at runtime.
// img-src / media-src allow whatever host actually serves uploads.
//
// The bucket host below is built from **`AWS_BUCKET`**, the same variable
// `config/plugins.js` hands to the upload provider. In the shared CMS these two
// files read different variables, so the CSP allow-listed a bucket that was not
// the one being written to and uploaded images were blocked in the admin
// preview. One name, used in both places.
//
// There are no legacy CDN hosts here (`img.weddingbazaar.com`, `img.mandap.com`).
// This instance starts empty, so no migrated post carries an inline `<img>`
// pointing at the old estate's buckets, and allow-listing a host for content
// that does not exist only widens the policy.

module.exports = ({ env }) => {
  const bucket = env('AWS_BUCKET', '');
  const bucketHost = bucket
    ? `https://${bucket}.s3.${env('AWS_REGION', 'ap-south-1')}.amazonaws.com`
    : '';
  const storefront = env('NEXTJS_WGB_ORIGIN', 'http://localhost:3001');

  return [
    'strapi::logger',
    'strapi::errors',
    {
      name: 'strapi::security',
      config: {
        contentSecurityPolicy: {
          useDefaults: true,
          directives: {
            'connect-src': ["'self'", 'https:', 'https://cdn.ckeditor.com'],
            'script-src': ["'self'", "'unsafe-inline'", 'https://cdn.ckeditor.com'],
            'frame-ancestors': ["'self'", storefront].filter(Boolean),
            'img-src': [
              "'self'",
              'data:',
              'blob:',
              'market-assets.strapi.io',
              'https://cdn.ckeditor.com',
              env('AWS_CDN_URL', ''),
              bucketHost,
            ].filter(Boolean),
            'media-src': [
              "'self'",
              'data:',
              'blob:',
              env('AWS_CDN_URL', ''),
              bucketHost,
            ].filter(Boolean),
            upgradeInsecureRequests: null,
          },
        },
      },
    },
    {
      name: 'strapi::cors',
      config: {
        // Nothing in a browser is meant to call this API — `wgb-backend` reaches
        // it server-to-server with an API token, and the storefront never talks
        // to it directly. The storefront origin is listed anyway because the
        // Preview flow renders it in an iframe served from this origin, and
        // `PUBLIC_URL` because the admin panel calls its own API.
        origin: [storefront, env('PUBLIC_URL', '')].filter(Boolean),
      },
    },
    'strapi::poweredBy',
    'strapi::query',
    'strapi::body',
    'strapi::session',
    'strapi::favicon',
    'strapi::public',
  ];
};
