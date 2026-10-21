// One-time copy of the old local SQLite database (data/app.db) into Supabase Postgres.
//   node scripts/migrate-sqlite.js [path/to/app.db]
// Keeps ids and password hashes, so existing accounts keep working. Sessions are not copied
// (everyone signs in again), and stats are recomputed by the app.
import '../server/tz.js';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

try { process.loadEnvFile(path.resolve(import.meta.dirname, '..', '.env')); } catch { /* use real env */ }
const { db } = await import('../server/db.js');

const file = process.argv[2] || path.resolve(import.meta.dirname, '..', 'data', 'app.db');
const lite = new DatabaseSync(file, { readOnly: true });
const sql = db();
const ts = (s) => (s ? new Date(`${s.replace(' ', 'T')}Z`) : new Date());

const hospitals = lite.prepare('SELECT * FROM hospitals ORDER BY id').all();
const users = lite.prepare('SELECT * FROM users ORDER BY id').all();
const appointments = lite.prepare('SELECT * FROM appointments ORDER BY id').all();
const notifications = lite.prepare('SELECT * FROM notifications ORDER BY id').all();

const [{ n }] = await sql`select count(*) as n from users`;
if (n > 0) {
  console.error(`Target database already has ${n} users; refusing to overwrite. Empty it first if you really want to re-run.`);
  process.exit(1);
}

await sql.begin(async (tx) => {
  for (const h of hospitals) {
    await tx`
      insert into hospitals (id, name, city, address, phone, specialties, open_time, close_time, slot_minutes, days_open, created_at)
      overriding system value
      values (${h.id}, ${h.name}, ${h.city}, ${h.address}, ${h.phone}, ${h.specialties}, ${h.open_time}, ${h.close_time},
              ${h.slot_minutes}, ${h.days_open}, ${ts(h.created_at)})`;
  }
  for (const u of users) {
    await tx`
      insert into users (id, role, name, email, phone, password_hash, hospital_id, created_at)
      overriding system value
      values (${u.id}, ${u.role}, ${u.name}, ${u.email.toLowerCase()}, ${u.phone}, ${u.password_hash}, ${u.hospital_id}, ${ts(u.created_at)})`;
  }
  for (const a of appointments) {
    await tx`
      insert into appointments (id, hospital_id, patient_id, date, time, reason, status, created_at)
      overriding system value
      values (${a.id}, ${a.hospital_id}, ${a.patient_id}, ${a.date}, ${a.time}, ${a.reason}, ${a.status}, ${ts(a.created_at)})`;
  }
  for (const x of notifications) {
    await tx`
      insert into notifications (id, user_id, message, read, created_at)
      overriding system value
      values (${x.id}, ${x.user_id}, ${x.message}, ${Boolean(x.read)}, ${x.created_at})`;
  }
  await tx`insert into jobs (type, payload, run_at) values ('stats.refresh', '{}', ${Date.now()})`;
});

console.log(`Copied ${hospitals.length} hospitals, ${users.length} users, ${appointments.length} appointments, ${notifications.length} notifications.`);
console.log('Now reset the id sequences (see README) so new rows continue after the copied ids.');
await sql.end();
