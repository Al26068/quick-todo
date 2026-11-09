// やること ver 2.0 — 通知サーバー（Cloudflare Workers + D1）
// アプリから「アラーム一覧」を受け取って保存し、毎分の cron で時間が来たものを Web Push で送る。

import { sendPush } from "./webpush.js";

const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
];
const MAX_BODY = 64 * 1024;
const MAX_ALARMS = 100;
const STALE_MS = 10 * 60 * 1000;      // 10分以上前の時刻は「もう過ぎたもの」として送らない
const GIVE_UP_MS = 6 * 60 * 60 * 1000; // 送信が続けて失敗したら6時間で諦める

/* ---------- 共通 ---------- */
function corsHeaders(req, env) {
  const allowed = (env.ALLOWED_ORIGIN || "*").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("Origin") || "";
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allowed.includes("*")) h["Access-Control-Allow-Origin"] = "*";
  else if (allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
const reply = (req, env, status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(req, env) } });

async function readJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw Object.assign(new Error("too large"), { status: 413 });
  try { return JSON.parse(text); } catch { throw Object.assign(new Error("bad json"), { status: 400 }); }
}

function allowedEndpoint(u, env) {
  let url;
  try { url = new URL(u); } catch { return false; }
  if (env.DEV === "1" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) return true;
  return url.protocol === "https:" && PUSH_HOSTS.some((r) => r.test(url.hostname));
}

function validSub(s, env) {
  if (!s || typeof s !== "object" || !s.keys) return null;
  const { endpoint } = s;
  const { p256dh, auth } = s.keys;
  if (typeof endpoint !== "string" || endpoint.length > 1000 || !allowedEndpoint(endpoint, env)) return null;
  if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 200 || auth.length > 100) return null;
  return { endpoint, p256dh, auth };
}

function vapidConfig(env) {
  if (!env.VAPID_KEYS) throw Object.assign(new Error("VAPID_KEYS is not set"), { status: 500 });
  const keys = typeof env.VAPID_KEYS === "string" ? JSON.parse(env.VAPID_KEYS) : env.VAPID_KEYS;
  return { keys, subject: env.VAPID_SUBJECT || "https://al26068.github.io/quick-todo/" };
}

/* ---------- ルート ---------- */
export async function handle(req, env) {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req, env) });
  try {
    if (url.pathname === "/" || url.pathname === "/api/health") return reply(req, env, 200, { ok: true, app: "quick-todo-push", version: "2.0" });
    if (url.pathname === "/api/vapid-public-key" && req.method === "GET") {
      return reply(req, env, 200, { key: vapidConfig(env).keys.publicKey });
    }
    if (url.pathname === "/api/sync" && req.method === "POST") return await sync(req, env);
    if (url.pathname === "/api/unsubscribe" && req.method === "POST") return await unsubscribe(req, env);
    if (url.pathname === "/api/test" && req.method === "POST") return await testPush(req, env);
    return reply(req, env, 404, { error: "not found" });
  } catch (e) {
    return reply(req, env, e.status || 500, { error: e.message || "error" });
  }
}

async function sync(req, env) {
  const body = await readJson(req);
  const sub = validSub(body.subscription, env);
  if (!sub) return reply(req, env, 400, { error: "bad subscription" });
  const list = Array.isArray(body.alarms) ? body.alarms.slice(0, MAX_ALARMS) : [];
  const now = Date.now();
  const rev = crypto.randomUUID();

  const stmts = [
    env.DB.prepare(
      `INSERT INTO subs (endpoint, p256dh, auth, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = ?2, auth = ?3, updated_at = ?4`
    ).bind(sub.endpoint, sub.p256dh, sub.auth, now),
  ];
  let count = 0;
  for (const a of list) {
    if (!a || typeof a.id !== "string" || !a.id || a.id.length > 80 || !Number.isFinite(a.at)) continue;
    const stage = a.stage === "doing" ? "doing" : "todo";
    const title = String(a.title || "").slice(0, 120);
    const note = String(a.note || "").slice(0, 120);
    const sent = a.at < now - STALE_MS ? 1 : 0;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO alarms (endpoint, id, title, stage, note, fire_at, sent, rev) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(endpoint, id) DO UPDATE SET
           title = ?3, stage = ?4, note = ?5,
           sent = CASE WHEN alarms.fire_at = ?6 THEN alarms.sent ELSE ?7 END,
           fire_at = ?6, rev = ?8`
      ).bind(sub.endpoint, a.id, title, stage, note, Math.round(a.at), sent, rev)
    );
    count++;
  }
  stmts.push(env.DB.prepare(`DELETE FROM alarms WHERE endpoint = ?1 AND rev <> ?2`).bind(sub.endpoint, rev));
  await env.DB.batch(stmts);
  return reply(req, env, 200, { ok: true, count });
}

async function unsubscribe(req, env) {
  const { endpoint } = await readJson(req);
  if (typeof endpoint !== "string") return reply(req, env, 400, { error: "bad endpoint" });
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM alarms WHERE endpoint = ?1`).bind(endpoint),
    env.DB.prepare(`DELETE FROM subs WHERE endpoint = ?1`).bind(endpoint),
  ]);
  return reply(req, env, 200, { ok: true });
}

async function testPush(req, env) {
  const { endpoint } = await readJson(req);
  if (typeof endpoint !== "string") return reply(req, env, 400, { error: "bad endpoint" });
  const row = await env.DB.prepare(`SELECT endpoint, p256dh, auth FROM subs WHERE endpoint = ?1`).bind(endpoint).first();
  if (!row) return reply(req, env, 404, { error: "not subscribed" });
  const res = await sendPush(row, { title: "テスト通知", body: "通知は正常に届いています", tag: "qt-test", id: null }, vapidConfig(env));
  return reply(req, env, res.ok ? 200 : 502, { ok: res.ok, status: res.status });
}

/* ---------- cron：時間が来たアラームを送る ---------- */
export async function runDue(env, now = Date.now()) {
  const cfg = vapidConfig(env);
  const { results } = await env.DB.prepare(
    `SELECT a.endpoint, a.id, a.title, a.stage, a.note, a.fire_at, s.p256dh, s.auth
       FROM alarms a JOIN subs s ON s.endpoint = a.endpoint
      WHERE a.sent = 0 AND a.fire_at <= ?1
      ORDER BY a.fire_at LIMIT 40`
  ).bind(now).all();

  const stage = { todo: "未着手", doing: "実行中" };
  let sent = 0, failed = 0, removed = 0;
  for (const row of results) {
    const payload = {
      title: row.title || "やること",
      body: row.note ? row.note : `${stage[row.stage] || ""}のアラームです`,
      tag: "qt-" + row.id,
      id: row.id,
    };
    let status = 0;
    try { status = (await sendPush(row, payload, cfg)).status; } catch { status = 0; }

    if (status >= 200 && status < 300) {
      await env.DB.prepare(`UPDATE alarms SET sent = 1 WHERE endpoint = ?1 AND id = ?2`).bind(row.endpoint, row.id).run();
      sent++;
    } else if (status === 404 || status === 410) {
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM alarms WHERE endpoint = ?1`).bind(row.endpoint),
        env.DB.prepare(`DELETE FROM subs WHERE endpoint = ?1`).bind(row.endpoint),
      ]);
      removed++;
    } else {
      failed++;
      if (now - row.fire_at > GIVE_UP_MS) {
        await env.DB.prepare(`UPDATE alarms SET sent = 2 WHERE endpoint = ?1 AND id = ?2`).bind(row.endpoint, row.id).run();
      }
    }
  }

  // 古いデータの掃除
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM alarms WHERE sent <> 0 AND fire_at < ?1`).bind(now - 7 * 24 * 3600 * 1000),
    env.DB.prepare(`DELETE FROM subs WHERE updated_at < ?1`).bind(now - 120 * 24 * 3600 * 1000),
  ]);
  return { due: results.length, sent, failed, removed };
}

export default {
  fetch: (req, env) => handle(req, env),
  scheduled: (event, env, ctx) => { ctx.waitUntil(runDue(env)); },
};
