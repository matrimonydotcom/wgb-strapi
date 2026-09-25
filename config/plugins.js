// Plugin configuration.
//
// **One set of S3 variable names, and no bucket default.** The shared CMS this
// was ported from reads `AWS_S3_BUCKET_NAME` / `S3_URL_PATH` here while its
// README, its `.env.example` and the Terraform module that deploys it all set
// `AWS_BUCKET` / `AWS_UPLOAD_PATH` — so an environment configured from the
// documentation silently falls through to that file's default, which is
// `img-weddingbazaar-com`: the shared **production** CDN bucket, from every
// environment including a developer's laptop. Here the names match the module
// and the documentation, and an unset `AWS_BUCKET` means local disk rather than
// somebody else's production bucket.

module.exports = ({ env }) => {
  const bucket = env('AWS_BUCKET');

  return {
    ckeditor5: {
      enabled: true,
    },
    seo: {
      enabled: true,
    },
    // No bucket configured (a local run without AWS credentials) → the upload
    // block is omitted entirely and Strapi serves uploads from `public/uploads`
    // on its own origin. `wedding-gift-box`'s `next.config.ts` already allows
    // `http://localhost:1337/uploads/**`, so cover images and avatars render
    // through `next/image` locally with no frontend change.
    ...(bucket
      ? {
          upload: {
            config: {
              provider: 'aws-s3',
              providerOptions: {
                baseUrl: env('AWS_CDN_URL'),
                rootPath: env('AWS_UPLOAD_PATH', ''),
                s3Options: {
                  region: env('AWS_REGION', 'ap-south-1'),
                  params: { Bucket: bucket },
                },
              },
              actionOptions: {
                upload: { ACL: null },
                uploadStream: { ACL: null },
                delete: {},
              },
            },
          },
        }
      : {}),
  };
};
