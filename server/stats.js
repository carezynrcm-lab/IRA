import { addDays, localDate } from './slots.js';

// The "heavy" admin aggregation. Runs as a background job and is cached in the stats
// table, so the admin dashboard reads a single row.
export async function computeStats(sql) {
  const today = localDate();
  const end = addDays(today, 13);
  const [[totals], perDay, top] = await Promise.all([
    sql`
      select
        (select count(*) from hospitals) as hospitals,
        (select count(*) from users where role = 'patient') as patients,
        (select count(*) from appointments) as appointments,
        (select count(*) from appointments where status = 'booked' and date >= ${today}) as upcoming,
        (select count(*) from appointments where status = 'completed') as completed,
        (select count(*) from appointments where status = 'cancelled') as cancelled,
        (select count(*) from appointments where date = ${today} and status <> 'cancelled') as today`,
    sql`
      select date, count(*) as c from appointments
      where status <> 'cancelled' and date between ${today} and ${end}
      group by date`,
    sql`
      select h.id, h.name, h.city, count(a.id) as bookings
      from hospitals h
      left join appointments a on a.hospital_id = h.id and a.status <> 'cancelled'
      group by h.id order by bookings desc, h.name limit 5`,
  ]);
  const counts = new Map(perDay.map((r) => [r.date, r.c]));
  const next14 = Array.from({ length: 14 }, (_, i) => {
    const date = addDays(today, i);
    return { date, count: counts.get(date) ?? 0 };
  });
  const value = { totals, next14, top: [...top], generatedAt: Date.now() };
  await sql`
    insert into stats (key, value, updated_at) values ('admin', ${sql.json(value)}, ${value.generatedAt})
    on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`;
  return value;
}

export async function readStats(sql) {
  const [row] = await sql`select value from stats where key = 'admin'`;
  return row?.value ?? null;
}
