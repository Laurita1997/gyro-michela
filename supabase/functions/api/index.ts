import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "content-type": "application/json" } });
const fail = (msg: string, s = 400) => json({ error: msg }, s);

const DUR: number[] = [];
for (let m = 60; m <= 180; m += 15) DUR.push(m);
const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const samePhone = (a: unknown, b: unknown) => !!digits(a) && digits(a) === digits(b);
const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);
const isTime = (s: unknown) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s));
const isDate = (s: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(s));
const widOf = (r: any) => r.wid || "home";

async function hash(code: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("michela:" + code));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function readRow() {
  const { data, error } = await sb.from("booking_state").select("*").eq("id", 1).single();
  if (error) throw new Error(error.message);
  return data;
}

// optimistic read-modify-write so two people saving at once never overwrite each other
async function mutate(fn: (row: any) => any) {
  for (let i = 0; i < 5; i++) {
    const row = await readRow();
    const out = await fn(row);
    if (out && out.abort) return out;
    const upd: any = { data: out.data, rev: row.rev + 1, updated_at: new Date().toISOString() };
    if (out.code_hash) upd.code_hash = out.code_hash;
    const { data, error } = await sb.from("booking_state").update(upd).eq("id", 1).eq("rev", row.rev).select("rev");
    if (error) throw new Error(error.message);
    if (data && data.length) return out;
  }
  throw new Error("busy, please try again");
}

function knownClient(d: any, phone: string) {
  if (!digits(phone)) return false;
  return (d.requests || []).some((r: any) => r.status === "accepted" && samePhone(r.phone, phone)) ||
    (d.standing || []).some((s: any) => s.phone && samePhone(s.phone, phone));
}

function publicView(d: any, phone: string) {
  const own = (r: any) => samePhone(r.phone, phone);
  return {
    rules: d.rules, open: d.open, skips: d.skips,
    blocks: (d.blocks || []).map((b: any) => ({ id: b.id, date: b.date, whole: b.whole, from: b.from, to: b.to })),
    standing: (d.standing || []).map((s: any) => ({ id: s.id, wid: s.wid, dow: s.dow, start: s.start, dur: s.dur })),
    requests: (d.requests || []).filter((r: any) => r.status !== "cancelled" || own(r)).map((r: any) =>
      own(r) ? r : { id: r.id, status: r.status, date: r.date, fdate: r.fdate, wid: r.wid, start: r.start, fdur: r.fdur, name: "", phone: "" }),
    regularFor: knownClient(d, phone) ? phone : "",
    usualDur: ((d.lengths || []).find((x: any) => samePhone(x.phone, phone)) || {}).dur || 0,
  };
}

async function checkCode(code: string) {
  const row = await readRow();
  if (row.locked_until && new Date(row.locked_until) > new Date()) return { ok: false, msg: "Too many tries. Please wait a few minutes." };
  const ok = !!code && (await hash(String(code))) === row.code_hash;
  if (ok) {
    if (row.fails) await sb.from("booking_state").update({ fails: 0, locked_until: null }).eq("id", 1);
    return { ok: true, row };
  }
  const fails = (row.fails || 0) + 1;
  const upd: any = { fails };
  if (fails >= 5) { upd.fails = 0; upd.locked_until = new Date(Date.now() + 10 * 60000).toISOString(); }
  await sb.from("booking_state").update(upd).eq("id", 1);
  return { ok: false, msg: "That code does not match." };
}

const toMin = (t: string) => { const p = String(t).split(":").map(Number); return p[0] * 60 + p[1]; };
const fromMin = (n: number) => String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");
const HOME_FROM = "08:00", HOME_TO = "20:00";

// the place (Michela's studio or one of her other places) a booking is for, or null when it is not open that day
function placeFor(d: any, wid: string, date: string): { from: string; to: string; cap: number; name: string } | null {
  if (wid === "home") return { from: HOME_FROM, to: HOME_TO, cap: 1, name: "Michela's studio" };
  const rule = (d.rules || []).find((x: any) => x.id === wid);
  if (!rule) return null;
  const dow = new Date(date + "T12:00:00Z").getUTCDay();
  if (!(rule.days || []).includes(dow)) return null;
  if (rule.since && date < rule.since) return null;
  if (rule.until && date > rule.until) return null;
  const h = (rule.hours && rule.hours[dow]) || { from: rule.from, to: rule.to };
  return { from: h.from, to: h.to, cap: Math.max(1, Math.min(10, Number(rule.cap) || 1)), name: rule.studio };
}

// returns a message when this place cannot take the booking, else ""
function placeConflict(d: any, wid: string, date: string, start: string, dur: number, phone: string): string {
  const pl = placeFor(d, wid, date);
  if (!pl) return "That place is not used on this day.";
  const s = toMin(start), e = s + dur;
  if (s < toMin(pl.from) || e > toMin(pl.to)) return "That is outside the hours (" + pl.from + " to " + pl.to + ").";
  const buf = pl.cap === 1 ? 15 : 0;
  const dow = new Date(date + "T12:00:00Z").getUTCDay();
  const sess: { a: number; z: number }[] = [];
  (d.requests || []).forEach((r: any) => {
    if (r.status === "accepted" && (r.fdate || r.date) === date && widOf(r) === wid) sess.push({ a: toMin(r.start), z: toMin(r.start) + Number(r.fdur) });
  });
  (d.standing || []).forEach((x: any) => {
    if (widOf(x) === wid && x.dow === dow && !(d.skips || {})[x.id + "|" + date]) sess.push({ a: toMin(x.start), z: toMin(x.start) + Number(x.dur) });
  });
  for (let t = s; t < e; t += 15) {
    const used = sess.filter((q) => t < q.z + buf && t + 15 > q.a - buf).length;
    if (used >= pl.cap) return pl.cap === 1 ? "That time was just taken. Please pick another time." : "That time is full. Please pick another time.";
  }
  const mine = (d.requests || []).some((r: any) => r.status === "accepted" && samePhone(r.phone, phone) && (r.fdate || r.date) === date &&
    s < toMin(r.start) + Number(r.fdur) && e > toMin(r.start));
  if (mine) return "You already have a session at that time.";
  for (const b of d.blocks || []) {
    if (b.date !== date) continue;
    const a = b.whole ? 0 : toMin(b.from), z = b.whole ? 1440 : toMin(b.to);
    if (s < z && e > a) return "That time is closed.";
  }
  return "";
}

const DAYN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtD = (s: string) => { const d = new Date(s + "T12:00:00Z"); return DAYN[d.getUTCDay()] + " " + d.getUTCDate() + " " + MON[d.getUTCMonth()]; };

// sends a push notification to every phone Michela turned notifications on for
async function notifyMichela(title: string, body: string, tag?: string) {
  try {
    const { data: k } = await sb.from("push_keys").select("*").eq("id", 1).single();
    const { data: subs } = await sb.from("push_subs").select("*");
    if (!k || !subs || !subs.length) return;
    const webpush = (await import("npm:web-push@3.6.7")).default;
    webpush.setVapidDetails("https://gyro-michela.vercel.app", k.pub, k.priv);
    const payload = JSON.stringify({ title, body, tag, url: "/" });
    await Promise.allSettled(subs.map(async (s: any) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400 });
      } catch (e: any) {
        if (e && (e.statusCode === 404 || e.statusCode === 410)) await sb.from("push_subs").delete().eq("endpoint", s.endpoint);
      }
    }));
  } catch (_e) { /* notifications are best effort */ }
}

function todayISO() {
  return new Date(Date.now() - 24 * 3600e3).toISOString().slice(0, 10);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return fail("POST only", 405);
  let b: any;
  try { b = await req.json(); } catch { return fail("Bad request"); }
  const action = b.action;
  try {
    if (action === "public") {
      const row = await readRow();
      return json(publicView(row.data, String(b.phone || "")));
    }

    if (action === "submit") {
      const r = b.request || {};
      const name = clip(r.name, 80).trim(), phone = clip(r.phone, 40).trim();
      if (!name) return fail("Please add your name.");
      if (digits(phone).length < 7) return fail("Please add a phone number Michela can reach you on.");
      if (!isDate(r.date) || r.date < todayISO()) return fail("Pick a day.");
      if (!isTime(r.reqStart)) return fail("Pick a start time.");
      if (!DUR.includes(Number(r.dur))) return fail("Pick a length.");
      const usual = (d0: any) => {
        const hit = (d0.lengths || []).find((x: any) => samePhone(x.phone, phone));
        return hit ? Number(hit.dur) : /kentaro/i.test(name) ? 120 : 90;
      };
      let created: any = null;
      const res = await mutate((row) => {
        const d = row.data;
        r.dur = usual(d);
        const wid = r.wid || "home";
        const pl = placeFor(d, wid, r.date);
        if (!pl) return { abort: true, err: wid === "home" ? "That day is not open to book yet." : "That place is not used on this day." };
        const last = new Date(Date.now() + 30 * 24 * 3600e3).toISOString().slice(0, 10);
        if (r.date < todayISO() || r.date > last) return { abort: true, err: "That day is not open to book yet." };
        if ((d.blocks || []).some((b: any) => b.date === r.date && b.whole)) return { abort: true, err: "That day is not available." };
        const bad = placeConflict(d, wid, r.date, r.reqStart, Number(r.dur), phone);
        if (bad) return { abort: true, err: bad };
        const loc = pl.name;
        const direct = true;
        created = {
          id: "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          name, phone, email: clip(r.email, 120).trim(), date: r.date, wid, loc,
          reqStart: r.reqStart, dur: Number(r.dur), note: clip(r.note, 500).trim(),
          status: "pending", created: Date.now(), upd: Date.now(),
        };
        Object.assign(created, { status: "accepted", direct: true, fdate: r.date, start: r.reqStart, fdur: Number(r.dur) });
        d.requests = [...(d.requests || []), created];
        return { data: d };
      });
      if (res.abort) return fail(res.err);
      const when = fmtD(created.fdate || created.date) + ", " + (created.start || created.reqStart);
      await notifyMichela("New booking", name + ", " + when + (created.loc && created.loc !== "Michela's studio" ? " (" + created.loc + ")" : ""), "req");
      return json({ ok: true, id: created.id, status: created.status });
    }

    if (action === "cancel" || action === "accept_proposal" || action === "decline_proposal") {
      const phone = String(b.phone || "");
      const res = await mutate((row) => {
        const d = row.data;
        const r = (d.requests || []).find((x: any) => x.id === b.id);
        if (!r || !samePhone(r.phone, phone)) return { abort: true, err: "Request not found." };
        if (action === "cancel") {
          if (!["pending", "proposed", "accepted"].includes(r.status)) return { abort: true, err: "Can't cancel this one." };
          if (r.status === "accepted") {
            const nowV = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Vienna" }));
            const [yy, mm, dd] = String(r.fdate || r.date).split("-").map(Number);
            const [hh, mi] = String(r.start).split(":").map(Number);
            r.late = (new Date(yy, mm - 1, dd, hh, mi).getTime() - nowV.getTime()) / 3600000 < 24;
          }
          r.cancelledBy = "client"; r.cancelAt = Date.now();
          r.status = "cancelled";
        } else {
          if (r.status !== "proposed" || !r.proposal) return { abort: true, err: "Nothing to answer here." };
          if (action === "accept_proposal") {
            const p = r.proposal;
            r.status = "accepted"; r.fdate = p.date; r.start = p.start; r.fdur = p.dur; r.wid = p.wid || "home"; r.loc = p.loc || "Michela's studio";
          } else r.status = "cancelled";
        }
        r.upd = Date.now();
        return { data: d };
      });
      if (res.abort) return fail(res.err);
      if (action === "cancel") {
        const row2 = await readRow();
        const r2 = (row2.data.requests || []).find((x: any) => x.id === b.id);
        if (r2) await notifyMichela(r2.late ? "Late cancellation" : "Cancellation", r2.name + ", " + fmtD(r2.fdate || r2.date) + ", " + (r2.start || r2.reqStart), "cancel");
      }
      return json({ ok: true });
    }

    if (action === "push_subscribe" || action === "push_unsubscribe" || action === "push_test") {
      const c = await checkCode(String(b.code || ""));
      if (!c.ok) return fail(c.msg!, 401);
      if (action === "push_subscribe") {
        const s = b.sub || {};
        if (!s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) return fail("Bad subscription.");
        const { error } = await sb.from("push_subs").upsert({ endpoint: String(s.endpoint), p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) });
        if (error) return fail(error.message, 500);
        return json({ ok: true });
      }
      if (action === "push_unsubscribe") {
        await sb.from("push_subs").delete().eq("endpoint", String(b.endpoint || ""));
        return json({ ok: true });
      }
      await notifyMichela("Test", "Notifications work on this phone.", "test");
      return json({ ok: true });
    }

    if (action === "login") {
      const c = await checkCode(String(b.code || ""));
      if (!c.ok) return fail(c.msg!, 401);
      return json({ data: c.row.data });
    }

    if (action === "save") {
      const c = await checkCode(String(b.code || ""));
      if (!c.ok) return fail(c.msg!, 401);
      const p = b.data || {};
      if (JSON.stringify(p).length > 800000) return fail("Too much data");
      let newHash: string | undefined;
      if (b.new_code !== undefined) {
        if (!/^\d{4,8}$/.test(String(b.new_code))) return fail("Use 4 to 8 digits.");
        newHash = await hash(String(b.new_code));
      }
      const res = await mutate((row) => {
        const cur = row.data;
        const byId: Record<string, any> = {};
        (cur.requests || []).forEach((r: any) => { byId[r.id] = r; });
        (p.requests || []).forEach((r: any) => {
          const old = byId[r.id];
          if (!old || (r.upd || 0) >= (old.upd || 0)) byId[r.id] = r;
        });
        const data = {
          rules: Array.isArray(p.rules) ? p.rules : cur.rules,
          open: p.open && typeof p.open === "object" ? p.open : cur.open,
          standing: Array.isArray(p.standing) ? p.standing : cur.standing,
          skips: p.skips && typeof p.skips === "object" ? p.skips : cur.skips,
          blocks: Array.isArray(p.blocks) ? p.blocks : cur.blocks,
          lengths: Array.isArray(p.lengths) ? p.lengths : (cur.lengths || []),
          requests: Object.values(byId),
        };
        return { data, code_hash: newHash };
      });
      return json({ data: res.data });
    }

    return fail("Unknown action");
  } catch (e) {
    return fail(String((e as Error).message || e), 500);
  }
});
