const pad = (n) => String(n).padStart(2, '0');

export const toMinutes = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
export const toTime = (mins) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const localTime = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + n);
  return localDate(d);
}

export function isValidDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00`);
  return !Number.isNaN(d.getTime()) && localDate(d) === date;
}

export const dayOfWeek = (date) => new Date(`${date}T00:00:00`).getDay();

export const openDays = (hospital) => hospital.days_open.split(',').filter(Boolean).map(Number);

export const isOpenOn = (hospital, date) => openDays(hospital).includes(dayOfWeek(date));

export function slotTimes(hospital) {
  const out = [];
  const end = toMinutes(hospital.close_time);
  for (let m = toMinutes(hospital.open_time); m + hospital.slot_minutes <= end; m += hospital.slot_minutes) {
    out.push(toTime(m));
  }
  return out;
}
