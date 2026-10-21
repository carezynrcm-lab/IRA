// Hospitals work in local time, but serverless machines run in UTC. Pin the process time zone
// (dates/times are stored as plain "YYYY-MM-DD" / "HH:MM" local values). Import this first.
process.env.TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';
