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
  { id: "basaglar", label: "Basaglar (long-acting)", need: 1 },
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
    return { ...c, done: hits.length >= c.need, count: hits.length,
      detail: last ? `${last.value != null ? last.value + last.unit : ""} at ${last.time}`.trim() : "not yet" };
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

// ---------- server ----------
function unauthorized(res) {
  res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Jenn"', "Content-Type": "text/plain" });
  res.end("Login required");
}
function authed(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  const [u, p] = Buffer.from(h.slice(6), "base64").toString().split(":");
  return u === APP_USER && p === APP_PASS && APP_PASS.length > 0;
}
function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => r(s)); });
}

const INDEX = fs.readFileSync(path.join(__dirname, "public", "index.html"));

http.createServer(async (req, res) => {
  if (req.url === "/health") return send(res, 200, { ok: true });
  if (!authed(req)) return unauthorized(res);
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
