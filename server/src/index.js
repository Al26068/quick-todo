// やること ver 3.0 — 同期・通知サーバー（Cloudflare Workers + D1）
//
// ・端末は「同期コード」(ランダムな鍵) を持つ。サーバーはその SHA-256 だけを覚える。
// ・付箋は 1枚ずつ「最後に編集した時刻 u」を持ち、新しいほうを採用する（削除も印として同期）。
// ・アラームは付箋から自動で作り、毎分の cron で、同じコードを使う全端末へ Web Push で送る。

import { sendPush } from "./webpush.js";

const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
];
const MAX_BODY = 512 * 1024;
const MAX_PUSH_ITEMS = 50;          // 1回の同期で受け取る付箋の数
const PAGE = 200;                   // 1回の同期で返す付箋の数
const CHUNK = 10;                   // D1 の1文に渡す付箋の数
const MAX_ITEMS_PER_USER = 2000;
const MAX_DEVICES_PER_USER = 10;
const STALE_MS = 10 * 60 * 1000;    // 10分以上前のアラームは送らない
const GIVE_UP_MS = 6 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const PUSH_BUDGET = 40;             // 1分あたりの送信上限（無料枠の subrequest 制限に合わせる）
const STAGES = ["todo", "doing", "done"];

/* ---------- 共通 ---------- */
function corsHeaders(req, env) {
  const allowed = (env.ALLOWED_ORIGIN || "*").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("Origin") || "";
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allowed.includes("*")) h["Access-Control-Allow-Origin"] = "*";
  else if (allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
const reply = (req, env, status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(req, env) } });
const fail = (status, message) => Object.assign(new Error(message), { status });

async function readJson(req, max = MAX_BODY) {
  const text = await req.text();
  if (text.length > max) throw fail(413, "データが大きすぎます");
  try { return text ? JSON.parse(text) : {}; } catch { throw fail(400, "JSON が正しくありません"); }
}

/** 同期コードのゆれ（小文字・ハイフン・空白・O/I/L）をそろえる。アプリ側と同じ規則。 */
export function normalizeKey(s) {
  return String(s || "").toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}
const KEY_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

async function authUid(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("Authorization") || "");
  const key = m ? normalizeKey(m[1]) : "";
  if (!KEY_RE.test(key)) throw fail(401, "同期コードが正しくありません");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("quick-todo:" + key));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
  if (!env.VAPID_KEYS) throw fail(500, "VAPID_KEYS が設定されていません");
  const keys = typeof env.VAPID_KEYS === "string" ? JSON.parse(env.VAPID_KEYS) : env.VAPID_KEYS;
  return { keys, subject: env.VAPID_SUBJECT || "https://al26068.github.io/quick-todo/" };
}

/** 受け取った付箋を、保存してよい形にそろえる。 */
export function cleanItem(x, now) {
  if (!x || typeof x !== "object") return null;
  const id = String(x.id == null ? "" : x.id);
  if (!id || id.length > 80) return null;
  const u = Number(x.u);
  if (!Number.isFinite(u) || u <= 0) return null;
  const s = (v, max) => String(v == null ? "" : v).slice(0, max);
  const stage = STAGES.includes(x.stage) ? x.stage : "todo";
  const d = x.d ? 1 : 0;
  const n = x.notes && typeof x.notes === "object" ? x.notes : {};
  const alarm = !d && stage !== "done" && Number.isFinite(x.alarm) ? Math.round(x.alarm) : null;
  return {
    id,
    title: d ? "" : s(x.title, 200),
    stage,
    notes: d ? { todo: "", doing: "", done: "" } : { todo: s(n.todo, 2000), doing: s(n.doing, 2000), done: s(n.done, 2000) },
    alarm,
    back: x.back === "doing" ? "doing" : "todo",
    ts: Number.isFinite(x.ts) ? Math.round(x.ts) : Math.round(u),
    u: Math.min(Math.round(u), now + FUTURE_SKEW_MS),
    d,
  };
}

/* ---------- ルート ---------- */
export async function handle(req, env) {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req, env) });
  try {
    const p = url.pathname;
    if (p === "/" || p === "/api/health") return reply(req, env, 200, { ok: true, app: "quick-todo", version: "3.0" });
    if (p === "/api/vapid-public-key" && req.method === "GET") return reply(req, env, 200, { key: vapidConfig(env).keys.publicKey });
    if (req.method !== "POST") return reply(req, env, 404, { error: "not found" });
    if (p === "/api/data/sync") return await dataSync(req, env);
    if (p === "/api/data/delete") return await dataDelete(req, env);
    if (p === "/api/push/subscribe") return await pushSubscribe(req, env);
    if (p === "/api/push/unsubscribe") return await pushUnsubscribe(req, env);
    if (p === "/api/push/test") return await pushTest(req, env);
    if (p === "/api/sync" || p === "/api/unsubscribe" || p === "/api/test") return reply(req, env, 410, { error: "古いバージョンです。アプリを更新してください（ver 3.0）" });
    return reply(req, env, 404, { error: "not found" });
  } catch (e) {
    return reply(req, env, e.status || 500, { error: e.message || "error" });
  }
}

/* ---------- 同期 ---------- */
async function dataSync(req, env) {
  const uid = await authUid(req);
  const body = await readJson(req);
  const now = Date.now();
  const incoming = (Array.isArray(body.items) ? body.items : []).slice(0, MAX_PUSH_ITEMS).map((x) => cleanItem(x, now)).filter(Boolean);
  let since = Number.isFinite(body.since) && body.since > 0 ? Math.floor(body.since) : 0;

  const user = await env.DB.prepare(`SELECT seq FROM users WHERE uid = ?1`).bind(uid).first();
  const creating = !user && body.create === true;   // 付箋が0枚の端末が同期を始めるときも、コードを登録する
  if (!user && !incoming.length && !creating) return reply(req, env, 200, { exists: false, items: [], cursor: 0, more: false, now });
  if (user && since > user.seq * 1000 + 999) since = 0;   // 作り直されたデータに古い目印が残っていたとき

  const stmts = [];
  if (incoming.length || creating) {
    const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM items WHERE uid = ?1`).bind(uid).first();
    if (c.n >= MAX_ITEMS_PER_USER) throw fail(413, "付箋が多すぎます（上限 " + MAX_ITEMS_PER_USER + " 枚）");
    stmts.push(env.DB.prepare(`INSERT INTO users (uid, created_at, seq) VALUES (?1, ?2, 0) ON CONFLICT(uid) DO NOTHING`).bind(uid, now));
    stmts.push(env.DB.prepare(`UPDATE users SET seq = seq + 1 WHERE uid = ?1`).bind(uid));
    for (let i = 0; i < incoming.length; i += CHUNK) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO items (uid, id, data, u, deleted, seq)
           SELECT ?1, json_extract(j.value, '$.id'), j.value, json_extract(j.value, '$.u'), json_extract(j.value, '$.d'),
                  (SELECT seq FROM users WHERE uid = ?1) * 1000 + ?3 + j.key
             FROM json_each(?2) AS j WHERE true
           ON CONFLICT(uid, id) DO UPDATE SET data = excluded.data, u = excluded.u, deleted = excluded.deleted, seq = excluded.seq
             WHERE excluded.u > items.u`
        ).bind(uid, JSON.stringify(incoming.slice(i, i + CHUNK)), i)
      );
    }
    // アラームは付箋から作り直す（送信済みの印は、時刻が同じなら引き継ぐ）
    stmts.push(
      env.DB.prepare(
        `INSERT INTO reminders (uid, id, title, stage, note, fire_at, sent)
         SELECT i.uid, i.id, json_extract(i.data, '$.title'), json_extract(i.data, '$.stage'),
                substr(coalesce(json_extract(i.data, '$.notes.' || json_extract(i.data, '$.stage')), ''), 1, 120),
                json_extract(i.data, '$.alarm'),
                CASE WHEN json_extract(i.data, '$.alarm') < ?2 THEN 1 ELSE 0 END
           FROM items i
          WHERE i.uid = ?1 AND i.deleted = 0 AND json_extract(i.data, '$.stage') <> 'done'
            AND json_type(i.data, '$.alarm') IN ('integer', 'real')
         ON CONFLICT(uid, id) DO UPDATE SET
           title = excluded.title, stage = excluded.stage, note = excluded.note,
           sent = CASE WHEN reminders.fire_at = excluded.fire_at THEN reminders.sent ELSE excluded.sent END,
           fire_at = excluded.fire_at`
      ).bind(uid, now - STALE_MS)
    );
    stmts.push(
      env.DB.prepare(
        `DELETE FROM reminders WHERE uid = ?1 AND id NOT IN (
           SELECT id FROM items WHERE uid = ?1 AND deleted = 0 AND json_extract(data, '$.stage') <> 'done'
              AND json_type(data, '$.alarm') IN ('integer', 'real'))`
      ).bind(uid)
    );
  }
  stmts.push(env.DB.prepare(`SELECT data, seq FROM items WHERE uid = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3`).bind(uid, since, PAGE + 1));
  stmts.push(env.DB.prepare(`SELECT seq FROM users WHERE uid = ?1`).bind(uid));

  const out = await env.DB.batch(stmts);
  const rows = out[out.length - 2].results || [];
  const u2 = (out[out.length - 1].results || [])[0];
  const more = rows.length > PAGE;
  const page = rows.slice(0, PAGE);
  const cursor = page.length ? page[page.length - 1].seq : Math.max(since, u2 ? u2.seq * 1000 + 999 : 0);
  return reply(req, env, 200, { exists: true, items: page.map((r) => JSON.parse(r.data)), cursor, more, now });
}

async function dataDelete(req, env) {
  const uid = await authUid(req);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM reminders WHERE uid = ?1`).bind(uid),
    env.DB.prepare(`DELETE FROM devices WHERE uid = ?1`).bind(uid),
    env.DB.prepare(`DELETE FROM items WHERE uid = ?1`).bind(uid),
    env.DB.prepare(`DELETE FROM users WHERE uid = ?1`).bind(uid),
  ]);
  return reply(req, env, 200, { ok: true });
}

/* ---------- 通知を受け取る端末 ---------- */
async function pushSubscribe(req, env) {
  const uid = await authUid(req);
  const body = await readJson(req, 16 * 1024);
  const sub = validSub(body.subscription, env);
  if (!sub) return reply(req, env, 400, { error: "通知の登録情報が正しくありません" });
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO devices (endpoint, uid, p256dh, auth, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT(endpoint) DO UPDATE SET uid = ?2, p256dh = ?3, auth = ?4, updated_at = ?5`
    ).bind(sub.endpoint, uid, sub.p256dh, sub.auth, now),
    env.DB.prepare(
      `DELETE FROM devices WHERE uid = ?1 AND endpoint NOT IN (SELECT endpoint FROM devices WHERE uid = ?1 ORDER BY updated_at DESC LIMIT ?2)`
    ).bind(uid, MAX_DEVICES_PER_USER),
  ]);
  return reply(req, env, 200, { ok: true });
}

async function pushUnsubscribe(req, env) {
  const uid = await authUid(req);
  const { endpoint } = await readJson(req, 16 * 1024);
  if (typeof endpoint !== "string") return reply(req, env, 400, { error: "bad endpoint" });
  await env.DB.prepare(`DELETE FROM devices WHERE endpoint = ?1 AND uid = ?2`).bind(endpoint, uid).run();
  return reply(req, env, 200, { ok: true });
}

async function pushTest(req, env) {
  const uid = await authUid(req);
  const { endpoint } = await readJson(req, 16 * 1024);
  if (typeof endpoint !== "string") return reply(req, env, 400, { error: "bad endpoint" });
  const row = await env.DB.prepare(`SELECT endpoint, p256dh, auth FROM devices WHERE endpoint = ?1 AND uid = ?2`).bind(endpoint, uid).first();
  if (!row) return reply(req, env, 404, { error: "この端末は通知に登録されていません" });
  const res = await sendPush(row, { title: "テスト通知", body: "通知は正常に届いています", tag: "qt-test", id: null }, vapidConfig(env));
  return reply(req, env, res.ok ? 200 : 502, { ok: res.ok, status: res.status });
}

/* ---------- cron：時間が来たアラームを、同じコードの全端末へ送る ---------- */
export async function runDue(env, now = Date.now()) {
  const cfg = vapidConfig(env);
  const { results } = await env.DB.prepare(
    `SELECT uid, id, title, stage, note, fire_at FROM reminders WHERE sent = 0 AND fire_at <= ?1 ORDER BY fire_at LIMIT 40`
  ).bind(now).all();

  const stage = { todo: "未着手", doing: "実行中" };
  const devicesOf = new Map();
  let budget = PUSH_BUDGET, sent = 0, failed = 0, removed = 0, idle = 0;

  for (const r of results) {
    let devs = devicesOf.get(r.uid);
    if (!devs) {
      devs = (await env.DB.prepare(`SELECT endpoint, p256dh, auth FROM devices WHERE uid = ?1`).bind(r.uid).all()).results;
      devicesOf.set(r.uid, devs);
    }
    const mark = (v) => env.DB.prepare(`UPDATE reminders SET sent = ?3 WHERE uid = ?1 AND id = ?2`).bind(r.uid, r.id, v).run();
    if (!devs.length) { await mark(1); idle++; continue; }          // 通知を受ける端末がない
    if (budget < devs.length) break;                                 // 残りは次の分に回す
    budget -= devs.length;

    const payload = { title: r.title || "やること", body: r.note ? r.note : `${stage[r.stage] || ""}のアラームです`, tag: "qt-" + r.id, id: r.id };
    let ok = 0, transient = 0;
    for (const d of [...devs]) {
      let status = 0;
      try { status = (await sendPush(d, payload, cfg)).status; } catch { status = 0; }
      if (status >= 200 && status < 300) ok++;
      else if (status === 404 || status === 410) {
        await env.DB.prepare(`DELETE FROM devices WHERE endpoint = ?1`).bind(d.endpoint).run();
        devs.splice(devs.indexOf(d), 1);
        removed++;
      } else transient++;
    }
    if (ok > 0) { await mark(1); sent++; }
    else if (transient === 0) { await mark(1); idle++; }            // 全端末が失効していた
    else { failed++; if (now - r.fire_at > GIVE_UP_MS) await mark(2); }
  }

  if (Math.floor(now / 60000) % 60 === 0) {                          // 1時間に1回、古いデータを掃除
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM reminders WHERE sent <> 0 AND fire_at < ?1`).bind(now - 7 * 24 * 3600 * 1000),
      env.DB.prepare(`DELETE FROM items WHERE deleted = 1 AND u < ?1`).bind(now - 180 * 24 * 3600 * 1000),
      env.DB.prepare(`DELETE FROM devices WHERE updated_at < ?1`).bind(now - 120 * 24 * 3600 * 1000),
    ]);
  }
  return { due: results.length, sent, failed, removed, idle };
}

export default {
  fetch: (req, env) => handle(req, env),
  scheduled: (event, env, ctx) => { ctx.waitUntil(runDue(env)); },
};
