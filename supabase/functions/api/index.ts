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
const HOME_FROM = "09:00", HOME_TO = "21:00";

// returns a message when Michela's own studio cannot take this booking, else ""
function homeConflict(d: any, date: string, start: string, dur: number): string {
  const s = toMin(start), e = s + dur;
  if (s < toMin(HOME_FROM) || e > toMin(HOME_TO)) return "That is outside Michela's hours (09:00 to 21:00).";
  const buf = 15;
  const dow = new Date(date + "T12:00:00Z").getUTCDay();
  const sess: { a: number; z: number }[] = [];
  (d.requests || []).forEach((r: any) => {
    if (r.status === "accepted" && (r.fdate || r.date) === date && widOf(r) === "home") sess.push({ a: toMin(r.start), z: toMin(r.start) + Number(r.fdur) });
  });
  (d.standing || []).forEach((x: any) => {
    if (widOf(x) === "home" && x.dow === dow && !(d.skips || {})[x.id + "|" + date]) sess.push({ a: toMin(x.start), z: toMin(x.start) + Number(x.dur) });
  });
  for (let t = s; t < e; t += 15) {
    if (sess.some((q) => t < q.z + buf && t + 15 > q.a - buf)) return "That time was just taken. Please pick another time.";
  }
  for (const b of d.blocks || []) {
    if (b.date !== date) continue;
    const a = b.whole ? 0 : toMin(b.from), z = b.whole ? 1440 : toMin(b.to);
    if (s < z && e > a) return "That time is closed.";
  }
  return "";
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
        let loc = "Michela's studio";
        let direct = false;
        if (wid === "home") {
          const last = new Date(Date.now() + 30 * 24 * 3600e3).toISOString().slice(0, 10);
          if (r.date < todayISO() || r.date > last) return { abort: true, err: "That day is not open to book yet." };
          if ((d.blocks || []).some((b: any) => b.date === r.date && b.whole)) return { abort: true, err: "That day is not available." };
          const bad = homeConflict(d, r.date, r.reqStart, Number(r.dur));
          if (bad) return { abort: true, err: bad };
          direct = true;
        }
        if (wid !== "home") {
          const rule = (d.rules || []).find((x: any) => x.id === wid);
          if (!rule) return { abort: true, err: "That studio is not available." };
          loc = rule.studio;
          const dow = new Date(r.date + "T12:00:00Z").getUTCDay();
          if (!rule.days.includes(dow)) return { abort: true, err: "That studio is not used on this day." };
          if (!d.open[wid + "|" + r.date] && !knownClient(d, phone)) return { abort: true, err: "That day is not open to book yet." };
        }
        const pend = (d.requests || []).filter((x: any) => samePhone(x.phone, phone) && (x.status === "pending" || x.status === "proposed")).length;
        if (pend >= 6) return { abort: true, err: "You already have several open requests. Please wait for Michela's reply." };
        if (direct) {
          const upcoming = (d.requests || []).filter((x: any) => samePhone(x.phone, phone) && x.status === "accepted" && (x.fdate || x.date) >= todayISO() && widOf(x) === "home").length;
          if (upcoming >= 4) return { abort: true, err: "You already have 4 upcoming sessions. Please cancel one or ask Michela." };
        }
        created = {
          id: "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          name, phone, email: clip(r.email, 120).trim(), date: r.date, wid, loc,
          reqStart: r.reqStart, dur: Number(r.dur), note: clip(r.note, 500).trim(),
          status: "pending", created: Date.now(), upd: Date.now(),
        };
        if (direct) Object.assign(created, { status: "accepted", direct: true, fdate: r.date, start: r.reqStart, fdur: Number(r.dur) });
        d.requests = [...(d.requests || []), created];
        return { data: d };
      });
      if (res.abort) return fail(res.err);
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
            if ((new Date(yy, mm - 1, dd, hh, mi).getTime() - nowV.getTime()) / 3600000 < 24) return { abort: true, err: "This session starts in less than 24 hours. Please contact Michela directly to cancel it." };
          }
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
