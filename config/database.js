// Postgres only. There is no SQLite fallback on purpose: a CMS whose local
// shape differs from its deployed one produces bugs that only exist in one of
// them, and the whole content model here leans on Postgres behaviour (JSON
// snapshot columns, the unique index behind `redirect.fromPath`).
//
// Locally the database lives in `docker/docker-compose.yml` on port **5434** —
// 5432 belongs to the weddingservices estate and 5433 to `wgb-backend`, and a
// new joiner should not have to stop either to bring this up.

module.exports = ({ env }) => ({
  connection: {
    client: env('DATABASE_CLIENT', 'postgres'),
    connection: {
      host: env('DATABASE_HOST'),
      port: env.int('DATABASE_PORT', 5432),
      database: env('DATABASE_NAME'),
      user: env('DATABASE_USERNAME'),
      password: env('DATABASE_PASSWORD'),
      schema: env('DATABASE_SCHEMA', 'public'),
      ssl: env.bool('DATABASE_SSL', true) && {
        rejectUnauthorized: env.bool('DATABASE_SSL_REJECT_UNAUTHORIZED', false),
      },
    },
    pool: {
      min: env.int('DATABASE_POOL_MIN', 2),
      max: env.int('DATABASE_POOL_MAX', 10),
    },
    acquireConnectionTimeout: env.int('DATABASE_CONNECTION_TIMEOUT', 60000),
  },
});
