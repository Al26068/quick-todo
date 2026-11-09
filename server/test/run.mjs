// 通知サーバーのテスト（node test/run.mjs）
// - Web Push の暗号化を、独立した実装(http_ece)で復号して確かめる
// - VAPID の署名を Node の crypto で検証する
// - API と cron の動きを、SQLite を D1 の代わりに使って確かめる

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createECDH, createPublicKey, verify, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { b64u, encryptPayload, vapidAuthorization } from "../src/webpush.js";
import { handle, runDue } from "../src/index.js";

const require = createRequire(import.meta.url);
const ece = require("http_ece");
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log("  ok  " + name); }
  catch (e) { console.error("  FAIL " + name + "\n", e); process.exitCode = 1; }
};

/* ---- D1 の代わり ---- */
function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  const prepare = (sql) => {
    let params = [];
    const st = {
      bind: (...p) => { params = p; return st; },
      run: async () => ({ success: true, meta: { changes: db.prepare(sql).run(...params).changes } }),
      all: async () => ({ results: db.prepare(sql).all(...params).map((r) => ({ ...r })) }),
      first: async () => { const r = db.prepare(sql).get(...params); return r ? { ...r } : null; },
      _exec: () => db.prepare(sql).run(...params),
    };
    return st;
  };
  return {
    prepare,
    batch: async (stmts) => {
      db.exec("BEGIN");
      try { for (const s of stmts) s._exec(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
      return [];
    },
    db,
  };
}

/* ---- VAPID 鍵と、端末（購読者）の鍵 ---- */
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const VAPID = { publicKey: b64u.enc(publicRaw), privateJwk };

function newDevice(host = "web.push.apple.com") {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const authSecret = randomBytes(16);
  return {
    ecdh, authSecret,
    sub: {
      endpoint: `https://${host}/wpush/v2/${randomBytes(12).toString("hex")}`,
      keys: { p256dh: b64u.enc(ecdh.getPublicKey()), auth: b64u.enc(authSecret) },
    },
  };
}
const decrypt = (dev, body) =>
  JSON.parse(ece.decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: dev.ecdh, authSecret: dev.authSecret }).toString("utf8"));

const post = (env, path, body, headers = {}) =>
  handle(new Request("https://worker.test" + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }), env);

console.log("webpush.js");

await test("暗号化したペイロードを http_ece で復号できる", async () => {
  const dev = newDevice();
  const msg = { title: "牛乳を買う", body: "実行中のアラームです", id: "abc" };
  const body = await encryptPayload(new TextEncoder().encode(JSON.stringify(msg)), dev.sub.keys.p256dh, dev.sub.keys.auth);
  assert.deepEqual(decrypt(dev, body), msg);
});

await test("日本語・長めのメモも壊れない", async () => {
  const dev = newDevice();
  const msg = { title: "レポート提出🌙", body: "参考文献を3件追加する。".repeat(10) };
  const body = await encryptPayload(new TextEncoder().encode(JSON.stringify(msg)), dev.sub.keys.p256dh, dev.sub.keys.auth);
  assert.deepEqual(decrypt(dev, body), msg);
});

await test("VAPID の署名を検証できる（aud・exp・sub も正しい）", async () => {
  const endpoint = "https://web.push.apple.com/wpush/v2/xyz";
  const now = Date.now();
  const h = await vapidAuthorization(endpoint, VAPID, "https://example.com/", now);
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h);
  assert.ok(m, "ヘッダ形式: " + h);
  const [, hd, pl, sg, k] = m;
  assert.equal(k, VAPID.publicKey);
  const header = JSON.parse(Buffer.from(hd, "base64url").toString());
  const payload = JSON.parse(Buffer.from(pl, "base64url").toString());
  assert.deepEqual(header, { typ: "JWT", alg: "ES256" });
  assert.equal(payload.aud, "https://web.push.apple.com");
  assert.equal(payload.sub, "https://example.com/");
  assert.ok(payload.exp > now / 1000 && payload.exp <= now / 1000 + 24 * 3600);
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u.enc(publicRaw.slice(1, 33)), y: b64u.enc(publicRaw.slice(33, 65)) }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(`${hd}.${pl}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sg, "base64url")));
});

console.log("API");

const mkEnv = (extra = {}) => ({ DB: makeD1(), VAPID_KEYS: JSON.stringify(VAPID), ALLOWED_ORIGIN: "https://al26068.github.io", ...extra });

await test("公開鍵を返す / CORS は許可したオリジンだけ", async () => {
  const env = mkEnv();
  const r = await handle(new Request("https://worker.test/api/vapid-public-key", { headers: { Origin: "https://al26068.github.io" } }), env);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).key, VAPID.publicKey);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "https://al26068.github.io");
  const bad = await handle(new Request("https://worker.test/api/vapid-public-key", { headers: { Origin: "https://evil.example" } }), env);
  assert.equal(bad.headers.get("Access-Control-Allow-Origin"), null);
  const pre = await handle(new Request("https://worker.test/api/sync", { method: "OPTIONS", headers: { Origin: "https://al26068.github.io" } }), env);
  assert.equal(pre.status, 204);
});

await test("sync: 保存・更新・削除が反映され、送信済みは時刻が同じなら保持される", async () => {
  const env = mkEnv();
  const dev = newDevice();
  const now = Date.now();
  const mk = (id, at, stage = "todo") => ({ id, title: "付箋 " + id, stage, note: "", at });
  let r = await post(env, "/api/sync", { subscription: dev.sub, alarms: [mk("a", now + 60000), mk("b", now + 120000, "doing")] });
  assert.equal((await r.json()).count, 2);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM alarms").get().n, 2);

  env.DB.db.prepare("UPDATE alarms SET sent = 1 WHERE id = 'a'").run();
  await post(env, "/api/sync", { subscription: dev.sub, alarms: [mk("a", now + 60000), mk("b", now + 999000, "doing")] });
  const rows = Object.fromEntries(env.DB.db.prepare("SELECT id, sent, fire_at FROM alarms").all().map((x) => [x.id, x]));
  assert.equal(rows.a.sent, 1, "時刻が同じなら送信済みのまま");
  assert.equal(rows.b.fire_at, now + 999000);

  env.DB.db.prepare("UPDATE alarms SET sent = 1 WHERE id = 'b'").run();
  await post(env, "/api/sync", { subscription: dev.sub, alarms: [mk("a", now + 300000), mk("b", now + 999000, "doing")] });
  assert.equal(env.DB.db.prepare("SELECT sent FROM alarms WHERE id='a'").get().sent, 0, "時刻を変えたら未送信に戻る");
  assert.equal(env.DB.db.prepare("SELECT sent FROM alarms WHERE id='b'").get().sent, 1);

  await post(env, "/api/sync", { subscription: dev.sub, alarms: [mk("b", now + 999000, "doing")] });
  assert.deepEqual(env.DB.db.prepare("SELECT id FROM alarms").all().map((x) => x.id), ["b"], "一覧から消えたものは削除");
});

await test("sync: 不正な購読先・大きすぎる本文・壊れた JSON は拒否する", async () => {
  const env = mkEnv();
  const dev = newDevice("evil.example.com");
  assert.equal((await post(env, "/api/sync", { subscription: dev.sub, alarms: [] })).status, 400);
  const ok = newDevice();
  assert.equal((await post(env, "/api/sync", { subscription: { ...ok.sub, endpoint: "http://web.push.apple.com/x" }, alarms: [] })).status, 400);
  assert.equal((await post(env, "/api/sync", { subscription: ok.sub, alarms: [{ id: "x", title: "y".repeat(70000), at: 1 }] })).status, 413);
  const bad = await handle(new Request("https://worker.test/api/sync", { method: "POST", body: "{oops" }), env);
  assert.equal(bad.status, 400);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM subs").get().n, 0);
});

await test("sync: 10分以上前の時刻は送らない（登録時点で送信済み扱い）", async () => {
  const env = mkEnv();
  const dev = newDevice();
  await post(env, "/api/sync", { subscription: dev.sub, alarms: [{ id: "old", title: "古い", stage: "todo", at: Date.now() - 3600000 }] });
  assert.equal(env.DB.db.prepare("SELECT sent FROM alarms WHERE id='old'").get().sent, 1);
});

console.log("cron");

function stubFetch(handler) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

await test("時間が来たアラームだけを、暗号化した通知で送る", async () => {
  const env = mkEnv();
  const dev = newDevice();
  const now = Date.now();
  await post(env, "/api/sync", { subscription: dev.sub, alarms: [
    { id: "due", title: "歯医者の予約", stage: "doing", note: "保険証を持つ", at: now + 1000 },
    { id: "later", title: "あとで", stage: "todo", at: now + 3600000 },
  ] });
  const f = stubFetch(() => new Response(null, { status: 201 }));
  try {
    const res = await runDue(env, now + 5000);
    assert.deepEqual(res, { due: 1, sent: 1, failed: 0, removed: 0 });
    assert.equal(f.calls.length, 1);
    const c = f.calls[0];
    assert.equal(c.url, dev.sub.endpoint);
    assert.equal(c.init.headers["Content-Encoding"], "aes128gcm");
    assert.equal(c.init.headers.TTL, "86400");
    assert.match(c.init.headers.Authorization, /^vapid t=.+, k=.+$/);
    assert.deepEqual(decrypt(dev, c.init.body), { title: "歯医者の予約", body: "保険証を持つ", tag: "qt-due", id: "due" });
    // 2回目は送らない
    assert.equal((await runDue(env, now + 65000)).due, 0);
  } finally { f.restore(); }
});

await test("メモが空のときは段階名の本文になる", async () => {
  const env = mkEnv();
  const dev = newDevice();
  const now = Date.now();
  await post(env, "/api/sync", { subscription: dev.sub, alarms: [{ id: "n", title: "洗濯", stage: "todo", at: now + 1 }] });
  const f = stubFetch(() => new Response(null, { status: 201 }));
  try {
    await runDue(env, now + 2000);
    assert.equal(decrypt(dev, f.calls[0].init.body).body, "未着手のアラームです");
  } finally { f.restore(); }
});

await test("410 が返ったら購読を削除し、500 は次の分に再送する", async () => {
  const env = mkEnv();
  const gone = newDevice(), flaky = newDevice();
  const now = Date.now();
  await post(env, "/api/sync", { subscription: gone.sub, alarms: [{ id: "g", title: "g", stage: "todo", at: now + 1 }] });
  await post(env, "/api/sync", { subscription: flaky.sub, alarms: [{ id: "f", title: "f", stage: "todo", at: now + 1 }] });
  let status = 410;
  const f = stubFetch((url) => new Response(null, { status: url === gone.sub.endpoint ? 410 : status }));
  try {
    status = 500;
    let r = await runDue(env, now + 2000);
    assert.deepEqual([r.sent, r.failed, r.removed], [0, 1, 1]);
    assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM subs WHERE endpoint = ?").get(gone.sub.endpoint).n, 0);
    assert.equal(env.DB.db.prepare("SELECT sent FROM alarms WHERE id='f'").get().sent, 0);
    status = 201;
    r = await runDue(env, now + 62000);
    assert.equal(r.sent, 1);
    // 6時間を超えて失敗し続けたら諦める
    await post(env, "/api/sync", { subscription: flaky.sub, alarms: [{ id: "z", title: "z", stage: "todo", at: now + 3 }] });
    status = 503;
    await runDue(env, now + 7 * 3600 * 1000);
    assert.equal(env.DB.db.prepare("SELECT sent FROM alarms WHERE id='z'").get().sent, 2);
  } finally { f.restore(); }
});

await test("test エンドポイントと unsubscribe", async () => {
  const env = mkEnv();
  const dev = newDevice();
  await post(env, "/api/sync", { subscription: dev.sub, alarms: [] });
  const f = stubFetch(() => new Response(null, { status: 201 }));
  try {
    const r = await post(env, "/api/test", { endpoint: dev.sub.endpoint });
    assert.equal(r.status, 200);
    assert.equal(decrypt(dev, f.calls[0].init.body).title, "テスト通知");
    assert.equal((await post(env, "/api/test", { endpoint: "https://web.push.apple.com/unknown" })).status, 404);
  } finally { f.restore(); }
  await post(env, "/api/unsubscribe", { endpoint: dev.sub.endpoint });
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM subs").get().n, 0);
});

await test("VAPID_KEYS が未設定なら分かるエラーを返す", async () => {
  const env = { DB: makeD1() };
  const r = await handle(new Request("https://worker.test/api/vapid-public-key"), env);
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /VAPID_KEYS/);
});

console.log(`\n${passed} passed${process.exitCode ? " (failures above)" : ""}`);
