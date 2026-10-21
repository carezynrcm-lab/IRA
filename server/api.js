import { hashPassword, hashToken, newToken, verifyPassword } from './auth.js';
import { db, isUniqueViolation } from './db.js';
import { bad, HttpError, notFound, readParams, sendJson } from './http.js';
import { enqueue, kick } from './jobs.js';
import { addDays, isOpenOn, isValidDate, localDate, localTime, slotTimes } from './slots.js';
import { computeStats, readStats } from './stats.js';

export const SESSION_MS = 30 * 24 * 3600_000;
const SLOT_LENGTHS = [10, 15, 20, 30, 45, 60];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---------- input validation ----------
function text(v, label, { max = 200, required = true } = {}) {
  if (v == null || v === '') {
    if (required) throw bad(`${label} is required`);
    return '';
  }
  if (typeof v !== 'string') throw bad(`${label} must be text`);
  const t = v.trim();
  if (required && !t) throw bad(`${label} is required`);
  if (t.length > max) throw bad(`${label} is too long (max ${max} characters)`);
  return t;
}
export function email(v) {
  const e = text(v, 'Email', { max: 120 }).toLowerCase();
  if (!EMAIL_RE.test(e)) throw bad('Please enter a valid email address');
  return e;
}
function password(v) {
  if (typeof v !== 'string' || v.length < 6) throw bad('Password must be at least 6 characters');
  if (v.length > 200) throw bad('Password is too long');
  return v;
}
function date(v, label = 'Date') {
  if (!isValidDate(v)) throw bad(`${label} must be a valid date (YYYY-MM-DD)`);
  return v;
}
function time(v, label = 'Time') {
  if (typeof v !== 'string' || !TIME_RE.test(v)) throw bad(`${label} must be HH:MM`);
  return v;
}
function id(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw bad('Invalid id');
  return n;
}

export const publicUser = (u) => ({ id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone, hospital_id: u.hospital_id });

// ---------- shared data access (also used by OAuth) ----------
export async function getHospital(sql, hid) {
  const [h] = await sql`select * from hospitals where id = ${id(hid)}`;
  if (!h) throw notFound('Hospital not found');
  return h;
}

export async function createSession(sql, userId) {
  const token = newToken();
  await sql`insert into sessions (token_hash, user_id, expires_at) values (${hashToken(token)}, ${userId}, ${Date.now() + SESSION_MS})`;
  const [user] = await sql`select * from users where id = ${userId}`;
  return { token, user: publicUser(user), hospital: user.hospital_id ? await getHospital(sql, user.hospital_id) : null };
}

export async function checkCredentials(sql, rawEmail, rawPassword) {
  const mail = email(rawEmail);
  const [user] = await sql`select * from users where lower(email) = ${mail}`;
  const ok = user && typeof rawPassword === 'string' && (await verifyPassword(rawPassword, user.password_hash));
  if (!ok) throw new HttpError(401, 'Incorrect email or password');
  return user;
}

async function authUser(sql, req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  const [user] = await sql`
    select u.* from sessions s join users u on u.id = s.user_id
    where s.token_hash = ${hashToken(header.slice(7))} and s.expires_at > ${Date.now()}`;
  return user ?? null;
}

function checkBookable(h, d, t) {
  const today = localDate();
  if (d < today || (d === today && t <= localTime())) throw bad('That time has already passed');
  if (d > addDays(today, 60)) throw bad('You can book up to 60 days in advance');
  if (!isOpenOn(h, d)) throw bad(`${h.name} is closed on that day`);
  if (!slotTimes(h).includes(t)) throw bad('That is not a valid time slot');
}

const patientAppointment = async (sql, aid) => (await sql`
  select a.id, a.hospital_id, a.date, a.time, a.reason, a.status, a.created_at,
         h.name as hospital_name, h.city as hospital_city, h.address as hospital_address, h.phone as hospital_phone, h.slot_minutes
  from appointments a join hospitals h on h.id = a.hospital_id
  where a.id = ${aid}`)[0];

const patientsOfHospital = (sql, hid) => sql`
  select u.id, u.name, u.email, u.phone,
         count(*) as visits,
         max(a.date) as last_date,
         count(*) filter (where a.status = 'booked' and a.date >= ${localDate()}) as upcoming
  from appointments a join users u on u.id = a.patient_id
  where a.hospital_id = ${hid}
  group by u.id order by last_date desc, u.name`;

// ---------- routes ----------
const routes = [];
// roles: null = public, [] = any signed-in user, ['admin', ...] = those roles only.
const route = (method, pattern, roles, handler) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
  routes.push({ method, re, keys, roles, handler });
};

// ----- auth -----
route('POST', '/api/auth/register', null, async ({ sql, body }) => {
  const name = text(body.name, 'Name', { max: 80 });
  const mail = email(body.email);
  const phone = text(body.phone, 'Phone', { max: 20, required: false });
  const hash = await hashPassword(password(body.password));
  try {
    const [u] = await sql`insert into users (role, name, email, phone, password_hash) values ('patient', ${name}, ${mail}, ${phone}, ${hash}) returning id`;
    return createSession(sql, u.id);
  } catch (err) {
    if (isUniqueViolation(err, 'users_email_key')) throw new HttpError(409, 'An account with this email already exists');
    throw err;
  }
});

route('POST', '/api/auth/login', null, async ({ sql, body }) => {
  const user = await checkCredentials(sql, body.email, body.password);
  return createSession(sql, user.id);
});

route('POST', '/api/auth/logout', [], async ({ sql, req }) => {
  await sql`delete from sessions where token_hash = ${hashToken(req.headers.authorization.slice(7))}`;
});

route('GET', '/api/me', [], async ({ sql, user }) => ({
  user: publicUser(user),
  hospital: user.hospital_id ? await getHospital(sql, user.hospital_id) : null,
}));

route('PUT', '/api/me', [], async ({ sql, user, body }) => {
  const name = text(body.name, 'Name', { max: 80 });
  const phone = text(body.phone, 'Phone', { max: 20, required: false });
  await sql`update users set name = ${name}, phone = ${phone} where id = ${user.id}`;
  return publicUser({ ...user, name, phone });
});

// ----- hospitals (browsing) -----
route('GET', '/api/hospitals', [], ({ sql }) =>
  sql`select id, name, city, address, phone, specialties, open_time, close_time, slot_minutes, days_open from hospitals order by name`);

route('GET', '/api/hospitals/:id', [], ({ sql, params }) => getHospital(sql, params.id));

route('GET', '/api/hospitals/:id/slots', [], async ({ sql, user, params, query }) => {
  const h = await getHospital(sql, params.id);
  const d = date(query.date);
  const today = localDate();
  const open = isOpenOn(h, d);
  if (!open || d < today) return { date: d, open: open && d >= today, slots: [] };
  const taken = new Map(
    (await sql`select time, patient_id from appointments where hospital_id = ${h.id} and date = ${d} and status <> 'cancelled'`)
      .map((r) => [r.time, r.patient_id]),
  );
  const now = localTime();
  const slots = slotTimes(h).map((t) => {
    const pid = taken.get(t);
    let status = 'free';
    if (pid !== undefined) status = pid === user.id ? 'mine' : 'taken';
    else if (d === today && t <= now) status = 'past';
    return { time: t, status };
  });
  return { date: d, open: true, slots };
});

// ----- appointments -----
route('GET', '/api/appointments', [], async ({ sql, user, query }) => {
  if (user.role === 'patient') {
    return sql`
      select a.id, a.hospital_id, a.date, a.time, a.reason, a.status, a.created_at,
             h.name as hospital_name, h.city as hospital_city, h.address as hospital_address, h.phone as hospital_phone, h.slot_minutes
      from appointments a join hospitals h on h.id = a.hospital_id
      where a.patient_id = ${user.id} order by a.date desc, a.time desc limit 300`;
  }
  const hid = user.role === 'hospital' ? user.hospital_id : id(query.hospitalId);
  const from = query.from ? date(query.from, 'from') : localDate();
  const to = query.to ? date(query.to, 'to') : addDays(from, 31);
  return sql`
    select a.id, a.date, a.time, a.reason, a.status, a.created_at,
           u.id as patient_id, u.name as patient_name, u.phone as patient_phone, u.email as patient_email
    from appointments a join users u on u.id = a.patient_id
    where a.hospital_id = ${hid} and a.date between ${from} and ${to}
    order by a.date, a.time`;
});

route('POST', '/api/appointments', ['patient'], async ({ sql, user, body }) => {
  const h = await getHospital(sql, body.hospitalId);
  const d = date(body.date);
  const t = time(body.time);
  const reason = text(body.reason, 'Reason', { max: 500, required: false });
  checkBookable(h, d, t);
  const [clash] = await sql`select 1 from appointments where patient_id = ${user.id} and date = ${d} and time = ${t} and status <> 'cancelled'`;
  if (clash) throw new HttpError(409, 'You already have another appointment at that time');
  // The partial unique index guarantees nobody else holds this slot (see error handler).
  const [a] = await sql`insert into appointments (hospital_id, patient_id, date, time, reason) values (${h.id}, ${user.id}, ${d}, ${t}, ${reason}) returning id`;
  await enqueue(sql, 'appointment.booked', { id: a.id });
  return patientAppointment(sql, a.id);
});

route('PATCH', '/api/appointments/:id', [], async ({ sql, user, params, body }) => {
  const [a] = await sql`select * from appointments where id = ${id(params.id)}`;
  if (!a) throw notFound('Appointment not found');
  const status = body.status;
  if (user.role === 'patient') {
    if (a.patient_id !== user.id) throw notFound('Appointment not found');
    if (status !== 'cancelled') throw bad('Patients can only cancel appointments');
  } else {
    if (user.role === 'hospital' && a.hospital_id !== user.hospital_id) throw notFound('Appointment not found');
    if (!['completed', 'cancelled'].includes(status)) throw bad('Status must be completed or cancelled');
  }
  // Conditional update so two simultaneous changes can't both win.
  const updated = await sql`update appointments set status = ${status} where id = ${a.id} and status = 'booked' returning id`;
  if (!updated.length) throw new HttpError(409, `This appointment is already ${a.status === 'booked' ? 'updated' : a.status}`);
  await enqueue(sql, 'appointment.status', { id: a.id, status, byRole: user.role });
  return { id: a.id, status };
});

route('POST', '/api/appointments/:id/reschedule', ['patient'], async ({ sql, user, params, body }) => {
  const [a] = await sql`select * from appointments where id = ${id(params.id)}`;
  if (!a || a.patient_id !== user.id) throw notFound('Appointment not found');
  if (a.status !== 'booked') throw new HttpError(409, `This appointment is already ${a.status}`);
  const h = await getHospital(sql, a.hospital_id);
  const d = date(body.date);
  const t = time(body.time);
  if (d === a.date && t === a.time) throw bad('Pick a different time to reschedule');
  checkBookable(h, d, t);
  const [clash] = await sql`select 1 from appointments where patient_id = ${user.id} and date = ${d} and time = ${t} and status <> 'cancelled' and id <> ${a.id}`;
  if (clash) throw new HttpError(409, 'You already have another appointment at that time');
  await sql`update appointments set date = ${d}, time = ${t} where id = ${a.id}`;
  await enqueue(sql, 'appointment.rescheduled', { id: a.id, from: { date: a.date, time: a.time } });
  return patientAppointment(sql, a.id);
});

// ----- hospital staff -----
route('GET', '/api/hospital/patients', ['hospital'], ({ sql, user }) => patientsOfHospital(sql, user.hospital_id));

route('GET', '/api/hospital/settings', ['hospital'], ({ sql, user }) => getHospital(sql, user.hospital_id));

route('PUT', '/api/hospital/settings', ['hospital'], async ({ sql, user, body }) => {
  const open = time(body.open_time, 'Opening time');
  const close = time(body.close_time, 'Closing time');
  if (open >= close) throw bad('Closing time must be after opening time');
  const slot = Number(body.slot_minutes);
  if (!SLOT_LENGTHS.includes(slot)) throw bad(`Slot length must be one of ${SLOT_LENGTHS.join(', ')} minutes`);
  const days = Array.isArray(body.days_open) ? [...new Set(body.days_open.map(Number))].sort() : [];
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw bad('Choose at least one working day');
  await sql`
    update hospitals set
      phone = ${text(body.phone, 'Phone', { max: 30, required: false })},
      address = ${text(body.address, 'Address', { max: 200, required: false })},
      specialties = ${text(body.specialties, 'Specialties', { max: 300, required: false })},
      open_time = ${open}, close_time = ${close}, slot_minutes = ${slot}, days_open = ${days.join(',')}
    where id = ${user.hospital_id}`;
  return getHospital(sql, user.hospital_id);
});

// ----- admin -----
route('GET', '/api/admin/stats', ['admin'], async ({ sql }) => (await readStats(sql)) ?? computeStats(sql));

route('GET', '/api/admin/hospitals', ['admin'], ({ sql }) => sql`
  select h.*,
    (select email from users where hospital_id = h.id and role = 'hospital' limit 1) as login_email,
    (select count(distinct patient_id) from appointments where hospital_id = h.id) as patients,
    (select count(*) from appointments where hospital_id = h.id) as appointments,
    (select count(*) from appointments where hospital_id = h.id and status = 'booked' and date >= ${localDate()}) as upcoming
  from hospitals h order by h.name`);

route('POST', '/api/admin/hospitals', ['admin'], async ({ sql, body }) => {
  const h = {
    name: text(body.name, 'Hospital name', { max: 120 }),
    city: text(body.city, 'City', { max: 60 }),
    address: text(body.address, 'Address', { max: 200, required: false }),
    phone: text(body.phone, 'Phone', { max: 30, required: false }),
    specialties: text(body.specialties, 'Specialties', { max: 300, required: false }),
  };
  const mail = email(body.email);
  const hash = await hashPassword(password(body.password));
  let hid;
  try {
    hid = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into hospitals (name, city, address, phone, specialties)
        values (${h.name}, ${h.city}, ${h.address}, ${h.phone}, ${h.specialties}) returning id`;
      await tx`
        insert into users (role, name, email, phone, password_hash, hospital_id)
        values ('hospital', ${`${h.name} Desk`}, ${mail}, ${h.phone}, ${hash}, ${row.id})`;
      return row.id;
    });
  } catch (err) {
    if (isUniqueViolation(err, 'users_email_key')) throw new HttpError(409, 'That login email is already in use');
    throw err;
  }
  await enqueue(sql, 'hospital.created', { hospitalId: hid });
  return { ...(await getHospital(sql, hid)), login_email: mail, patients: 0, appointments: 0, upcoming: 0 };
});

route('DELETE', '/api/admin/hospitals/:id', ['admin'], async ({ sql, params }) => {
  const h = await getHospital(sql, params.id);
  await sql`delete from hospitals where id = ${h.id}`;
  await enqueue(sql, 'stats.refresh');
});

route('GET', '/api/admin/hospitals/:id', ['admin'], async ({ sql, params }) => {
  const h = await getHospital(sql, params.id);
  const [[login], patients, appointments] = await Promise.all([
    sql`select email from users where hospital_id = ${h.id} and role = 'hospital' limit 1`,
    patientsOfHospital(sql, h.id),
    sql`
      select a.id, a.date, a.time, a.reason, a.status, u.name as patient_name
      from appointments a join users u on u.id = a.patient_id
      where a.hospital_id = ${h.id} order by a.date desc, a.time desc limit 100`,
  ]);
  return { hospital: { ...h, login_email: login?.email ?? '' }, patients, appointments };
});

route('GET', '/api/admin/patients', ['admin'], async ({ sql }) => {
  const [patients, links] = await Promise.all([
    sql`
      select u.id, u.name, u.email, u.phone, u.created_at,
             count(a.id) as appointments,
             count(a.id) filter (where a.status = 'booked' and a.date >= ${localDate()}) as upcoming,
             max(a.date) as last_date
      from users u left join appointments a on a.patient_id = u.id
      where u.role = 'patient'
      group by u.id order by u.created_at desc, u.id desc`,
    // Which hospitals each patient belongs to, with visit counts per hospital.
    sql`
      select a.patient_id, h.id, h.name, count(*) as visits
      from appointments a join hospitals h on h.id = a.hospital_id
      group by a.patient_id, h.id order by visits desc, h.name`,
  ]);
  const byPatient = new Map();
  for (const l of links) {
    if (!byPatient.has(l.patient_id)) byPatient.set(l.patient_id, []);
    byPatient.get(l.patient_id).push({ id: l.id, name: l.name, visits: l.visits });
  }
  return patients.map((p) => ({ ...p, hospitals: byPatient.get(p.id) ?? [] }));
});

route('GET', '/api/admin/patients/:id', ['admin'], async ({ sql, params }) => {
  const [p] = await sql`select id, name, email, phone, created_at from users where id = ${id(params.id)} and role = 'patient'`;
  if (!p) throw notFound('Patient not found');
  const appointments = await sql`
    select a.id, a.date, a.time, a.reason, a.status, h.id as hospital_id, h.name as hospital_name, h.city as hospital_city
    from appointments a join hospitals h on h.id = a.hospital_id
    where a.patient_id = ${p.id} order by a.date desc, a.time desc`;
  return { patient: p, appointments };
});

// ----- notifications -----
route('GET', '/api/notifications', [], async ({ sql, user }) => {
  const [items, [{ c }]] = await Promise.all([
    sql`select id, message, read, created_at from notifications where user_id = ${user.id} order by id desc limit 20`,
    sql`select count(*) as c from notifications where user_id = ${user.id} and not read`,
  ]);
  return { items, unread: c };
});

route('POST', '/api/notifications/read', [], async ({ sql, user }) => {
  await sql`update notifications set read = true where user_id = ${user.id} and not read`;
});

// ----- scheduled maintenance (Vercel cron) -----
route('GET', '/api/cron', null, async ({ sql, req }) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) throw new HttpError(401, 'Unauthorized');
  await enqueue(sql, 'maintenance');
  await enqueue(sql, 'stats.refresh');
  return { ok: true };
});

// ---------- dispatcher ----------
export async function handleApi(req, res, url) {
  const sql = db();
  try {
    let match = null;
    let params = {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (m) {
        match = r;
        params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        break;
      }
    }
    if (!match) throw notFound();
    const user = match.roles ? await authUser(sql, req) : null;
    if (match.roles) {
      if (!user) throw new HttpError(401, 'Please sign in');
      if (match.roles.length && !match.roles.includes(user.role)) throw new HttpError(403, 'You do not have access to this');
    }
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readParams(req) : {};
    const result = await match.handler({ sql, req, user, params, query: Object.fromEntries(url.searchParams), body });
    sendJson(res, result === undefined ? 204 : 200, result);
  } catch (err) {
    if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
    else if (isUniqueViolation(err, 'uniq_active_slot')) {
      sendJson(res, 409, { error: 'Sorry, that slot was just booked by someone else. Please pick another time.' });
    } else {
      console.error(err);
      sendJson(res, 500, { error: 'Something went wrong. Please try again.' });
    }
  } finally {
    // Process any queued background work after the response has gone out.
    if (req.method !== 'GET' || url.pathname === '/api/cron') kick(sql);
  }
}
