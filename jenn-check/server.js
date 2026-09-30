// Jenn's check — a private page that shows today's insulin/carbs/notes
// as a checklist, reading from and writing to Nightscout (which xDrip syncs to).
// No dependencies: Node 18+ built-ins only.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const NS_URL = (process.env.NS_URL || "").replace(/\/$/, "");
const NS_SECRET = process.env.NS_API_SECRET || "";
const NS_HASH = crypto.createHash("sha1").update(NS_SECRET).digest("hex");
const APP_USER = process.env.APP_USER || "jenn";
const APP_PASS = process.env.APP_PASS || "";
const TZ = process.env.TZ || "America/Toronto";
const BASAGLAR_DEFAULT = Number(process.env.BASAGLAR_DEFAULT || 25);
const PORT = Number(process.env.PORT || 3000);
const BASAGLAR_TIME = process.env.BASAGLAR_TIME || "16:00";          // fallback HH:MM local
const CAL_ICS_URL = process.env.CALENDAR_ICS_URL || "";              // Google "secret address in iCal format"
const CAL_MATCH = (process.env.CALENDAR_MATCH || "basaglar").toLowerCase();

// Tags we write into the Nightscout "notes" field so the checklist can
// recognise its own entries. xDrip entries have no tag and are shown as-is.
const KINDS = {
  basaglar: { label: "Basaglar", unit: "u", eventType: "Note", field: "insulin", tag: "[basaglar]" },
  apidra:   { label: "Apidra",   unit: "u", eventType: "Correction Bolus", field: "insulin", tag: "[apidra]" },
  carbs:    { label: "Food",     unit: "g", eventType: "Carb Correction", field: "carbs", tag: "[carbs]" },
  bg:       { label: "Finger prick", unit: " mmol/L", eventType: "BG Check", field: "glucose", tag: "[bg]" },
  note:     { label: "Note",     unit: "",  eventType: "Note", field: null, tag: "[note]" },
};

// What "done for today" means. Edit freely.
const CHECKLIST = [
  { id: "basaglar", label: "Basaglar (long-acting)", need: 1, scheduled: true },
  { id: "apidra",   label: "Apidra with a meal",     need: 1 },
  { id: "carbs",    label: "Ate something",          need: 1 },
];

// ---------- helpers ----------
function localMidnightUTC(now = new Date()) {
  // Start of "today" in TZ, as a UTC Date.
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now).reduce((a, p) => (a[p.type] = p.value, a), {});
  const guess = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  // shift guess by the zone offset at that moment
  const offMin = tzOffsetMinutes(guess);
  return new Date(guess.getTime() - offMin * 60000);
}
function tzOffsetMinutes(d) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = f.formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return (asUTC - d.getTime()) / 60000;
}
function localTime(iso) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));
}
function localDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, weekday: "long", month: "long", day: "numeric" }).format(now);
}

// ---------- calendar: today's scheduled Basaglar time ----------
let calCache = { at: 0, time: null };
function icsTime(v) {
  // "20260930T160000" (local, TZID) or "...Z" (UTC) -> "HH:MM" local
  const m = v.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/); if (!m) return null;
  if (v.endsWith("Z")) {
    const d = new Date(Date.UTC(+m[1], m[2]-1, +m[3], +m[4], +m[5]));
    return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  }
  return `${m[4]}:${m[5]}`;
}
async function scheduledTime() {
  if (!CAL_ICS_URL) return BASAGLAR_TIME;
  if (Date.now() - calCache.at < 60 * 60000 && calCache.time) return calCache.time;
  try {
    const text = await (await fetch(CAL_ICS_URL)).text();
    const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).replace(/-/g, "");
    let series = null, instance = null;
    for (const ev of text.split("BEGIN:VEVENT").slice(1)) {
      const body = ev.split("END:VEVENT")[0].replace(/\r?\n[ \t]/g, "");
      const sum = (body.match(/^SUMMARY:(.*)$/m) || [])[1] || "";
      if (!sum.toLowerCase().includes(CAL_MATCH)) continue;
      const dt = (body.match(/^DTSTART[^:]*:(.*)$/m) || [])[1] || "";
      const rid = (body.match(/^RECURRENCE-ID[^:]*:(.*)$/m) || [])[1] || "";
      if (rid.startsWith(todayKey) || dt.startsWith(todayKey)) instance = icsTime(dt);
      else if (/^RRULE:/m.test(body)) series = icsTime(dt);
    }
    calCache = { at: Date.now(), time: instance || series || BASAGLAR_TIME };
  } catch { calCache = { at: Date.now(), time: calCache.time || BASAGLAR_TIME }; }
  return calCache.time;
}
function pretty(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

async function ns(pathname, opts = {}) {
  if (!NS_URL) throw new Error("NS_URL not set");
  const res = await fetch(NS_URL + pathname, {
    ...opts,
    headers: { "api-secret": NS_HASH, "Content-Type": "application/json", Accept: "application/json", ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`Nightscout ${res.status} on ${pathname}`);
  return res.json();
}

function classify(t) {
  const notes = t.notes || "";
  for (const [id, k] of Object.entries(KINDS)) if (notes.includes(k.tag)) return id;
  // Untagged entries came from xDrip
  if (t.eventType === "BG Check" || t.glucoseType === "Finger") return "bg";
  if (t.insulin > 0) return "apidra";       // assume fast-acting unless tagged
  if (t.carbs > 0) return "carbs";
  return "note";
}

async function today() {
  const since = localMidnightUTC();
  const sched = await scheduledTime();
  const nowHM = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const [treatments, sgv] = await Promise.all([
    ns(`/api/v1/treatments.json?find[created_at][$gte]=${since.toISOString()}&count=200`),
    ns(`/api/v1/entries/sgv.json?count=1`).catch(() => []),
  ]);
  const items = treatments
    .map((t) => {
      const kind = classify(t);
      const k = KINDS[kind];
      const value = k.field ? Number(t[k.field] || 0) : null;
      return {
        id: t._id, kind, label: k.label, value, unit: k.unit,
        note: (t.notes || "").replace(/\[\w+\]\s*/g, "").trim(),
        at: t.created_at, time: localTime(t.created_at),
        source: (t.notes || "").match(/\[\w+\]/) ? "page" : (t.enteredBy || "xDrip"),
      };
    })
    .sort((a, b) => new Date(b.at) - new Date(a.at));

  const checklist = CHECKLIST.map((c) => {
    const hits = items.filter((i) => i.kind === c.id && (i.value === null || i.value > 0));
    const last = hits[0];
    const done = hits.length >= c.need;
    const label = c.scheduled ? `${c.label} ${pretty(sched)}` : c.label;
    let detail = last ? `${last.value != null ? last.value + last.unit : ""} at ${last.time}`.trim() : "not yet";
    if (!done && c.scheduled) detail = nowHM >= sched ? "due" : "not yet";
    return { ...c, label, done, count: hits.length, detail, late: !done && c.scheduled && nowHM >= sched };
  });

  const g = sgv[0];
  let glucose = null;
  if (g) {
    const mmol = Math.round((g.sgv / 18.0182) * 10) / 10;
    const ageMin = Math.round((Date.now() - new Date(g.dateString || g.date).getTime()) / 60000);
    glucose = { mmol, direction: g.direction || "", ageMin, delta: g.delta != null ? Math.round((g.delta / 18.0182) * 10) / 10 : null };
  }
  return { date: localDate(), glucose, checklist, items, defaults: { basaglar: BASAGLAR_DEFAULT } };
}

async function addTreatment({ kind, value, note }) {
  const k = KINDS[kind];
  if (!k) throw new Error("unknown kind");
  const body = { eventType: k.eventType, enteredBy: "jenn-check", created_at: new Date().toISOString(),
    notes: `${k.tag} ${note || ""}`.trim() };
  if (k.field) {
    const n = Number(value);
    if (!(n > 0)) throw new Error("value must be above 0");
    body[k.field] = n;
  }
  if (kind === "bg") { body.glucoseType = "Finger"; body.units = "mmol"; }
  return ns("/api/v1/treatments", { method: "POST", body: JSON.stringify([body]) });
}

// ---------- server: cookie login ----------
const SESSION_KEY = crypto.createHmac("sha256", APP_PASS + "|" + APP_USER).update("jenn-check").digest("hex");
function token() { return crypto.createHmac("sha256", SESSION_KEY).update(APP_USER).digest("hex"); }
function authed(req) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)jc=([a-f0-9]+)/);
  return APP_PASS.length > 0 && m && m[1] === token();
}
function loginPage(res, err) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jenn — sign in</title>
<link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#16222C"><link rel="apple-touch-icon" href="/icon-192.png">
<style>body{margin:0;background:#16222C;color:#EEE9DF;font:18px/1.4 "Atkinson Hyperlegible",system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}
form{width:min(92vw,360px);display:grid;gap:12px}h1{font-size:24px;margin:0 0 8px}input{font:inherit;font-size:20px;padding:14px;border:0;border-radius:14px;background:#26394A;color:#EEE9DF}
button{font:inherit;font-size:20px;font-weight:700;padding:16px;border:0;border-radius:14px;background:#8FC49A;color:#12281A}.e{color:#E9604F}</style></head>
<body><form method="post" action="/login"><h1>Jenn — today</h1>${err ? '<div class="e">Wrong username or password</div>' : ""}
<input name="u" placeholder="Username" autocomplete="username" autocapitalize="none"><input name="p" type="password" placeholder="Password" autocomplete="current-password">
<button>Sign in</button></form></body></html>`);
}
function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => r(s)); });
}

const INDEX = fs.readFileSync(path.join(__dirname, "public", "index.html"));
const STATIC = { "/manifest.json": "application/manifest+json", "/sw.js": "application/javascript",
  "/icon-192.png": "image/png", "/icon-512.png": "image/png" };

http.createServer(async (req, res) => {
  if (req.url === "/health") return send(res, 200, { ok: true });
  if (STATIC[req.url]) {
    res.writeHead(200, { "Content-Type": STATIC[req.url], "Cache-Control": "public, max-age=3600" });
    return res.end(fs.readFileSync(path.join(__dirname, "public", req.url)));
  }
  if (req.method === "POST" && req.url === "/login") {
    const q = new URLSearchParams(await readBody(req));
    if (q.get("u") === APP_USER && q.get("p") === APP_PASS && APP_PASS) {
      res.writeHead(302, { "Set-Cookie": `jc=${token()}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`, Location: "/" });
      return res.end();
    }
    return loginPage(res, true);
  }
  if (req.url === "/logout") { res.writeHead(302, { "Set-Cookie": "jc=; Path=/; Max-Age=0", Location: "/" }); return res.end(); }
  if (!authed(req)) {
    if (req.url.startsWith("/api/")) return send(res, 401, { error: "login required" });
    return loginPage(res, false);
  }
  try {
    if (req.method === "GET" && req.url.startsWith("/api/today")) return send(res, 200, await today());
    if (req.method === "POST" && req.url === "/api/treat") {
      const data = JSON.parse((await readBody(req)) || "{}");
      await addTreatment(data);
      return send(res, 200, { ok: true });
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(INDEX);
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`jenn-check on :${PORT}, tz ${TZ}, nightscout ${NS_URL || "(unset)"}`));
