// Persistent background job queue (stored in Postgres).
//
// API handlers only insert a job row and respond. The queue is then drained *after* the
// response is sent: on Vercel via waitUntil() (the function keeps running in the background),
// locally as a fire-and-forget promise. A daily cron also drains anything left over.
import { waitUntil } from '@vercel/functions';
import { computeStats } from './stats.js';

const MAX_ATTEMPTS = 5;
const DRAIN_BUDGET_MS = 8000;

export async function enqueue(sql, type, payload = {}) {
  await sql`insert into jobs (type, payload, run_at) values (${type}, ${sql.json(payload)}, ${Date.now()})`;
}

let draining = null;

// Start processing queued jobs in the background without delaying the response.
export function kick(sql) {
  // Chain onto any drain already running so a job queued at its tail isn't missed.
  const run = (draining || Promise.resolve())
    .then(() => drainJobs(sql))
    .catch((err) => console.error('[jobs]', err));
  draining = run;
  run.finally(() => { if (draining === run) draining = null; });
  if (process.env.VERCEL) waitUntil(run);
  return run;
}

export async function drainJobs(sql, budgetMs = DRAIN_BUDGET_MS) {
  const deadline = Date.now() + budgetMs;
  let processed = 0;
  while (Date.now() < deadline) {
    const [job] = await sql`
      update jobs set status = 'running', attempts = attempts + 1
      where id = (
        select id from jobs where status = 'pending' and run_at <= ${Date.now()}
        order by run_at, id limit 1 for update skip locked
      )
      returning *`;
    if (!job) break;
    try {
      const handler = handlers[job.type];
      if (!handler) throw new Error(`Unknown job type: ${job.type}`);
      await handler(sql, job.payload);
      await sql`update jobs set status = 'done', finished_at = ${Date.now()} where id = ${job.id}`;
    } catch (err) {
      const retry = job.attempts < MAX_ATTEMPTS;
      await sql`
        update jobs set status = ${retry ? 'pending' : 'failed'}, last_error = ${String(err?.stack || err)},
          run_at = ${Date.now() + 2 ** job.attempts * 1000}
        where id = ${job.id}`;
      console.error(`[jobs] ${job.id} (${job.type}) failed, attempt ${job.attempts}:`, err?.message || err);
    }
    processed += 1;
  }
  return processed;
}

// ---------- handlers ----------
const fmtWhen = (a) => new Date(`${a.date}T${a.time}:00`).toLocaleString('en-IN', {
  weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
});

async function notify(sql, userId, message) {
  await sql`insert into notifications (user_id, message, created_at) values (${userId}, ${message}, ${Date.now()})`;
}

const staffOf = (sql, hospitalId) => sql`select id from users where role = 'hospital' and hospital_id = ${hospitalId}`;

// Simulated email provider: records the message in the emails table.
async function sendEmail(sql, to, subject, body) {
  await sql`insert into emails (to_email, subject, body) values (${to}, ${subject}, ${body})`;
}

async function scheduleStatsRefresh(sql) {
  const [pending] = await sql`select 1 from jobs where type = 'stats.refresh' and status = 'pending' limit 1`;
  if (!pending) await enqueue(sql, 'stats.refresh');
}

async function loadAppointment(sql, id) {
  const [a] = await sql`
    select a.*, h.name as hospital_name, u.name as patient_name, u.email as patient_email
    from appointments a
    join hospitals h on h.id = a.hospital_id
    join users u on u.id = a.patient_id
    where a.id = ${id}`;
  return a;
}

const handlers = {
  async 'appointment.booked'(sql, { id }) {
    const a = await loadAppointment(sql, id);
    if (!a) return;
    const when = fmtWhen(a);
    await notify(sql, a.patient_id, `Confirmed: ${a.hospital_name} on ${when}.`);
    for (const s of await staffOf(sql, a.hospital_id)) await notify(sql, s.id, `New booking: ${a.patient_name} on ${when}.`);
    await sendEmail(sql, a.patient_email, 'Appointment confirmed', `Your appointment at ${a.hospital_name} on ${when} is confirmed.`);
    await scheduleStatsRefresh(sql);
  },

  async 'appointment.status'(sql, { id, status, byRole }) {
    const a = await loadAppointment(sql, id);
    if (!a) return;
    const when = fmtWhen(a);
    if (byRole === 'patient') {
      for (const s of await staffOf(sql, a.hospital_id)) await notify(sql, s.id, `${a.patient_name} cancelled their ${when} appointment.`);
    } else {
      const verb = status === 'completed' ? 'marked as completed' : 'cancelled by the hospital';
      await notify(sql, a.patient_id, `Your ${a.hospital_name} appointment on ${when} was ${verb}.`);
      if (status === 'cancelled') {
        await sendEmail(sql, a.patient_email, 'Appointment cancelled', `${a.hospital_name} cancelled your appointment on ${when}.`);
      }
    }
    await scheduleStatsRefresh(sql);
  },

  async 'appointment.rescheduled'(sql, { id, from }) {
    const a = await loadAppointment(sql, id);
    if (!a) return;
    const was = fmtWhen(from);
    const when = fmtWhen(a);
    await notify(sql, a.patient_id, `Rescheduled: ${a.hospital_name} moved to ${when}.`);
    for (const s of await staffOf(sql, a.hospital_id)) await notify(sql, s.id, `${a.patient_name} moved their appointment from ${was} to ${when}.`);
    await sendEmail(sql, a.patient_email, 'Appointment rescheduled', `Your appointment at ${a.hospital_name} is now on ${when} (was ${was}).`);
    await scheduleStatsRefresh(sql);
  },

  async 'hospital.created'(sql, { hospitalId }) {
    for (const s of await staffOf(sql, hospitalId)) await notify(sql, s.id, 'Welcome to CareSlot! Set your working hours in Settings.');
    await scheduleStatsRefresh(sql);
  },

  async 'stats.refresh'(sql) {
    await computeStats(sql);
  },

  async maintenance(sql) {
    const now = Date.now();
    await sql`delete from sessions where expires_at < ${now}`;
    await sql`delete from oauth_codes where expires_at < ${now}`;
    await sql`delete from oauth_refresh_tokens where expires_at < ${now}`;
    await sql`delete from jobs where status = 'done' and finished_at < ${now - 24 * 3600_000}`;
    await sql`delete from notifications where created_at < ${now - 30 * 24 * 3600_000}`;
    // Jobs stuck in "running" (an instance stopped mid-job) get another try.
    await sql`update jobs set status = 'pending' where status = 'running' and run_at < ${now - 10 * 60_000}`;
  },
};
