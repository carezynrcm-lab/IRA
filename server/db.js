import postgres from 'postgres';

// Supabase Postgres through the transaction pooler (port 6543). Prepared statements must be
// off in transaction mode. One small pool per serverless instance is plenty.
let sql = null;

export function db() {
  if (sql) return sql;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (see .env.example)');
  sql = postgres(url, {
    prepare: false,
    max: Number(process.env.DB_POOL_SIZE || 3),
    idle_timeout: 20,
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
