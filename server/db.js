import postgres from 'postgres';

// Supabase Postgres through the Supavisor *session* pooler (port 5432). Transaction mode
// (6543) intermittently lost query responses with this driver, hanging requests, so we use
// session mode with a small pool and a short idle timeout to release connections quickly.
let sql = null;

export function db() {
  if (sql) return sql;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (see .env.example)');
  sql = postgres(url, {
    prepare: false,
    max: Number(process.env.DB_POOL_SIZE || 3),
    idle_timeout: 10,
    connect_timeout: 10,
    connection: { search_path: 'careslot' },
    // COUNT/SUM come back as int8/numeric strings by default; the app wants plain numbers.
    types: {
      bigint: { to: 20, from: [20], parse: (x) => Number(x), serialize: (x) => String(x) },
      numeric: { to: 1700, from: [1700], parse: (x) => Number(x), serialize: (x) => String(x) },
    },
  });
  return sql;
}

export const isUniqueViolation = (err, constraint) =>
  err?.code === '23505' && (!constraint || err.constraint_name === constraint);
