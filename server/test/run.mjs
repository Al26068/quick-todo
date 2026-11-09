// 同期・通知サーバーのテスト（node test/run.mjs）
// - Web Push の暗号化を、独立した実装(http_ece)で復号して確かめる
// - 付箋の同期（競合・削除・ページング・端末ごとの分離）と、アラームの全端末配信を確かめる
//   （D1 の代わりに Node 組み込みの SQLite を使う。SQL は同じ方言）

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createECDH, createPublicKey, verify, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { b64u, encryptPayload, vapidAuthorization } from "../src/webpush.js";
import { handle, runDue, normalizeKey, cleanItem } from "../src/index.js";

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
    const isSelect = /^\s*select/i.test(sql);
    const st = {
      bind: (...p) => { params = p; return st; },
      run: async () => ({ success: true, meta: { changes: db.prepare(sql).run(...params).changes } }),
      all: async () => ({ results: db.prepare(sql).all(...params).map((r) => ({ ...r })) }),
      first: async () => { const r = db.prepare(sql).get(...params); return r ? { ...r } : null; },
      _exec: () => (isSelect ? { results: db.prepare(sql).all(...params).map((r) => ({ ...r })) } : (db.prepare(sql).run(...params), { results: [] })),
    };
    return st;
  };
  return {
    prepare,
    batch: async (stmts) => {
      db.exec("BEGIN");
      try { const out = stmts.map((s) => s._exec()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    db,
  };
}

/* ---- 鍵 ---- */
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
    sub: { endpoint: `https://${host}/wpush/v2/${randomBytes(12).toString("hex")}`, keys: { p256dh: b64u.enc(ecdh.getPublicKey()), auth: b64u.enc(authSecret) } },
  };
}
const decrypt = (dev, body) => JSON.parse(ece.decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: dev.ecdh, authSecret: dev.authSecret }).toString("utf8"));

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const newKey = () => Array.from(randomBytes(26), (b) => B32[b % 32]).join("");

const mkEnv = (extra = {}) => ({ DB: makeD1(), VAPID_KEYS: JSON.stringify(VAPID), ALLOWED_ORIGIN: "https://al26068.github.io", ...extra });
const call = (env, path, body, key, headers = {}) =>
  handle(new Request("https://worker.test" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: "Bearer " + key } : {}), ...headers },
    body: JSON.stringify(body || {}),
  }), env);
const sync = async (env, key, items = [], since = 0) => {
  const r = await call(env, "/api/data/sync", { items, since }, key);
  return { status: r.status, ...(await r.json()) };
};
let clock = 1_700_000_000_000;
const item = (id, over = {}) => ({ id, title: "付箋 " + id, stage: "todo", notes: { todo: "", doing: "", done: "" }, alarm: null, back: "todo", ts: clock, u: ++clock, d: 0, ...over });

console.log("webpush.js");

await test("暗号化したペイロードを http_ece で復号できる（日本語・長文も）", async () => {
  const dev = newDevice();
  const msg = { title: "レポート提出🌙", body: "参考文献を3件追加する。".repeat(10), id: "abc" };
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
  const payload = JSON.parse(Buffer.from(pl, "base64url").toString());
  assert.equal(payload.aud, "https://web.push.apple.com");
  assert.equal(payload.sub, "https://example.com/");
  assert.ok(payload.exp > now / 1000 && payload.exp <= now / 1000 + 24 * 3600);
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u.enc(publicRaw.slice(1, 33)), y: b64u.enc(publicRaw.slice(33, 65)) }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(`${hd}.${pl}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sg, "base64url")));
});

console.log("認証・基本");

await test("公開鍵を返す / CORS は許可したオリジンだけ（Authorization も許可）", async () => {
  const env = mkEnv();
  const r = await handle(new Request("https://worker.test/api/vapid-public-key", { headers: { Origin: "https://al26068.github.io" } }), env);
  assert.equal((await r.json()).key, VAPID.publicKey);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "https://al26068.github.io");
  const bad = await handle(new Request("https://worker.test/api/vapid-public-key", { headers: { Origin: "https://evil.example" } }), env);
  assert.equal(bad.headers.get("Access-Control-Allow-Origin"), null);
  const pre = await handle(new Request("https://worker.test/api/data/sync", { method: "OPTIONS", headers: { Origin: "https://al26068.github.io" } }), env);
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("Access-Control-Allow-Headers"), /Authorization/);
});

await test("同期コードがない・短い・文字が違うと 401", async () => {
  const env = mkEnv();
  for (const k of [undefined, "", "ABC", "!".repeat(26), newKey().slice(1)]) assert.equal((await call(env, "/api/data/sync", {}, k)).status, 401, String(k));
});

await test("同期コードは小文字・ハイフン・O/0 のゆれを同じものとして扱う", async () => {
  const env = mkEnv();
  const key = "K7QM2X9D4TBF6HZ8NPRSV3WY5A".replace("0", "0");
  assert.equal(normalizeKey("k7qm-2x9d 4tbf-6hz8-nprs-v3wy-5a"), key);
  assert.equal(normalizeKey("O1L"), "011");
  await sync(env, key, [item("a")]);
  const r = await sync(env, "k7qm-2x9d-4tbf-6hz8-nprs-v3wy-5a", [], 0);
  assert.equal(r.items.length, 1);
});

await test("古い v2.0 のAPIは、更新を促すメッセージで 410", async () => {
  const r = await call(mkEnv(), "/api/sync", {});
  assert.equal(r.status, 410);
  assert.match((await r.json()).error, /更新/);
});

console.log("付箋の同期");

await test("端末Aで追加した付箋が、端末Bで取得できる（内容もそのまま）", async () => {
  const env = mkEnv(), key = newKey();
  const a = item("n1", { title: "牛乳を買う", stage: "doing", notes: { todo: "忘れずに", doing: "20時まで", done: "" }, alarm: clock + 3600000 });
  const w = await sync(env, key, [a]);
  assert.equal(w.status, 200);
  const r = await sync(env, key, [], 0);
  assert.equal(r.items.length, 1);
  assert.deepEqual(r.items[0], { ...a, u: a.u });
  assert.equal(r.more, false);
  assert.ok(r.cursor > 0);
});

await test("まだ誰も使っていないコードは exists:false（入力ミスの検出用）", async () => {
  const env = mkEnv(), key = newKey();
  const r = await sync(env, key, [], 0);
  assert.deepEqual([r.exists, r.items.length], [false, 0]);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM users").get().n, 0, "読むだけでは何も作らない");
  await sync(env, key, [item("a")]);
  assert.equal((await sync(env, key, [], 0)).exists, true);
});

await test("差分だけが返る（since 以降の変更のみ）", async () => {
  const env = mkEnv(), key = newKey();
  await sync(env, key, [item("a"), item("b")]);
  const first = await sync(env, key, [], 0);
  assert.equal(first.items.length, 2);
  assert.deepEqual((await sync(env, key, [], first.cursor)).items, []);
  await sync(env, key, [item("b", { title: "変更", u: ++clock })]);
  const diff = await sync(env, key, [], first.cursor);
  assert.deepEqual(diff.items.map((x) => [x.id, x.title]), [["b", "変更"]]);
});

await test("競合：あとから編集したほうが勝つ。古い編集は無視される", async () => {
  const env = mkEnv(), key = newKey();
  const base = clock;
  await sync(env, key, [item("x", { title: "新しい", u: base + 100 })]);
  await sync(env, key, [item("x", { title: "古い", u: base + 50 })]);
  assert.equal((await sync(env, key, [], 0)).items[0].title, "新しい");
  await sync(env, key, [item("x", { title: "さらに新しい", u: base + 200 })]);
  assert.equal((await sync(env, key, [], 0)).items[0].title, "さらに新しい");
  await sync(env, key, [item("x", { title: "同時刻", u: base + 200 })]);
  assert.equal((await sync(env, key, [], 0)).items[0].title, "さらに新しい", "同じ時刻は先に入ったほうを残す");
});

await test("削除は印として同期され、新しい編集があれば復活もする", async () => {
  const env = mkEnv(), key = newKey();
  const base = clock;
  await sync(env, key, [item("d", { u: base + 1 })]);
  await sync(env, key, [item("d", { d: 1, u: base + 2, title: "消す前のタイトル" })]);
  const r = await sync(env, key, [], 0);
  assert.equal(r.items[0].d, 1);
  assert.equal(r.items[0].title, "", "削除した付箋の中身は残さない");
  await sync(env, key, [item("d", { u: base + 3, title: "復活" })]);
  const r2 = await sync(env, key, [], 0);
  assert.deepEqual([r2.items[0].d, r2.items[0].title], [0, "復活"]);
});

await test("450枚でも取りこぼしなく取得できる（200枚ずつのページ送り）", async () => {
  const env = mkEnv(), key = newKey();
  for (let i = 0; i < 450; i += 50) await sync(env, key, Array.from({ length: 50 }, (_, k) => item("p" + (i + k))));
  const seen = new Set();
  let cursor = 0, pages = 0;
  for (;;) {
    const r = await sync(env, key, [], cursor);
    r.items.forEach((x) => seen.add(x.id));
    cursor = r.cursor; pages++;
    if (!r.more) break;
  }
  assert.equal(seen.size, 450);
  assert.equal(pages, 3);
  assert.deepEqual((await sync(env, key, [], cursor)).items, []);
});

await test("ほかの人のコードでは見えない・書けない", async () => {
  const env = mkEnv(), a = newKey(), b = newKey();
  await sync(env, a, [item("secret", { title: "Aだけの付箋" })]);
  assert.deepEqual((await sync(env, b, [], 0)).items, []);
  await sync(env, b, [item("secret", { title: "Bが同じIDで上書き", u: clock + 9999 })]);
  assert.equal((await sync(env, a, [], 0)).items[0].title, "Aだけの付箋");
});

await test("入力の検査：不正な付箋は捨て、未来すぎる時刻は丸める、長すぎる文字は切る", async () => {
  const now = Date.now();
  assert.equal(cleanItem({ id: "", u: 1 }, now), null);
  assert.equal(cleanItem({ id: "a", u: "x" }, now), null);
  assert.equal(cleanItem(null, now), null);
  const far = cleanItem({ id: "a", title: "t".repeat(500), u: now + 9e9, stage: "bogus", alarm: now, notes: { todo: "x".repeat(5000) } }, now);
  assert.equal(far.stage, "todo");
  assert.equal(far.title.length, 200);
  assert.equal(far.notes.todo.length, 2000);
  assert.ok(far.u <= now + 5 * 60 * 1000);
  assert.equal(cleanItem({ id: "a", u: 5, stage: "done", alarm: 123 }, now).alarm, null, "完了にアラームは残さない");
});

await test("本文が大きすぎる場合は 413、付箋の上限も守る", async () => {
  const env = mkEnv(), key = newKey();
  const r = await call(env, "/api/data/sync", { items: [{ id: "x", u: 1, title: "y".repeat(600000) }] }, key);
  assert.equal(r.status, 413);
  env.DB.db.prepare("INSERT INTO users (uid, created_at, seq) VALUES ('q', 0, 1)").run();
  const stmt = env.DB.db.prepare("INSERT INTO items (uid,id,data,u,deleted,seq) VALUES (?,?,?,?,0,1)");
  const uid = await (async () => { const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("quick-todo:" + key)); return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join(""); })();
  env.DB.db.prepare("INSERT INTO users (uid, created_at, seq) VALUES (?, 0, 1)").run(uid);
  for (let i = 0; i < 2000; i++) stmt.run(uid, "i" + i, "{}", 1);
  const full = await sync(env, key, [item("one-more")]);
  assert.equal(full.status, 413);
});

await test("データ削除：付箋・アラーム・端末がすべて消える（他の人の分は残る）", async () => {
  const env = mkEnv(), a = newKey(), b = newKey();
  const dev = newDevice();
  await sync(env, a, [item("a1", { alarm: clock + 60000 })]);
  await sync(env, b, [item("b1")]);
  await call(env, "/api/push/subscribe", { subscription: dev.sub }, a);
  assert.equal((await call(env, "/api/data/delete", {}, a)).status, 200);
  const c = (t) => env.DB.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  assert.deepEqual([c("users"), c("items"), c("reminders"), c("devices")], [1, 1, 0, 0]);
});

console.log("アラームと通知");

await test("アラームは付箋から自動で作られ、完了・削除・時刻変更に追従する", async () => {
  const env = mkEnv(), key = newKey();
  const now = Date.now();
  const rem = () => env.DB.db.prepare("SELECT id, stage, note, fire_at, sent FROM reminders ORDER BY id").all();
  await sync(env, key, [
    item("a", { stage: "doing", notes: { todo: "", doing: "保険証を持つ", done: "" }, alarm: now + 60000 }),
    item("b", { alarm: now + 120000 }),
    item("c", { stage: "done" }),
    item("old", { alarm: now - 3600000 }),
  ]);
  assert.deepEqual(rem().map((r) => [r.id, r.stage, r.sent]), [["a", "doing", 0], ["b", "todo", 0], ["old", "todo", 1]]);
  assert.equal(rem()[0].note, "保険証を持つ");

  env.DB.db.prepare("UPDATE reminders SET sent = 1 WHERE id = 'a'").run();
  await sync(env, key, [item("a", { stage: "todo", alarm: now + 60000 })]);
  assert.deepEqual({ ...rem().find((r) => r.id === "a") }, { id: "a", stage: "todo", note: "", fire_at: now + 60000, sent: 1 }, "時刻が同じなら送信済みのまま・段階は追従");
  await sync(env, key, [item("a", { alarm: now + 300000 })]);
  assert.equal(rem().find((r) => r.id === "a").sent, 0, "時刻を変えたら未送信に戻る");
  await sync(env, key, [item("a", { stage: "done" })]);
  await sync(env, key, [item("b", { d: 1 })]);
  assert.deepEqual(rem().map((r) => r.id), ["old"], "完了・削除でアラームは消える");
});

const stubFetch = (handler) => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
  return { calls, restore: () => { globalThis.fetch = orig; } };
};

await test("時間が来たアラームを、同じコードの全端末へ送る（別の人には送らない）", async () => {
  const env = mkEnv(), mine = newKey(), other = newKey();
  const iphone = newDevice(), ipad = newDevice(), stranger = newDevice("fcm.googleapis.com");
  const now = Date.now();
  await sync(env, mine, [item("due", { title: "歯医者の予約", stage: "doing", notes: { todo: "", doing: "保険証を持つ", done: "" }, alarm: now + 1000 }), item("later", { alarm: now + 3600000 })]);
  await sync(env, other, [item("o", { title: "他人の付箋", alarm: now + 1000 })]);
  await call(env, "/api/push/subscribe", { subscription: iphone.sub }, mine);
  await call(env, "/api/push/subscribe", { subscription: ipad.sub }, mine);
  await call(env, "/api/push/subscribe", { subscription: stranger.sub }, other);
  const f = stubFetch(() => new Response(null, { status: 201 }));
  try {
    const res = await runDue(env, now + 5000);
    assert.deepEqual(res, { due: 2, sent: 2, failed: 0, removed: 0, idle: 0 });
    assert.equal(f.calls.length, 3);
    const to = (dev) => f.calls.filter((c) => c.url === dev.sub.endpoint);
    assert.equal(to(iphone).length, 1); assert.equal(to(ipad).length, 1); assert.equal(to(stranger).length, 1);
    const expect = { title: "歯医者の予約", body: "保険証を持つ", tag: "qt-due", id: "due" };
    assert.deepEqual(decrypt(iphone, to(iphone)[0].init.body), expect);
    assert.deepEqual(decrypt(ipad, to(ipad)[0].init.body), expect);
    assert.equal(decrypt(stranger, to(stranger)[0].init.body).title, "他人の付箋");
    assert.equal((await runDue(env, now + 65000)).due, 0, "二重に送らない");
  } finally { f.restore(); }
});

await test("メモが空なら段階名の本文。通知先がない・失効した端末はあとで片付く", async () => {
  const env = mkEnv(), key = newKey();
  const gone = newDevice(), live = newDevice();
  const now = Date.now();
  await sync(env, key, [item("n", { title: "洗濯", alarm: now + 1 })]);
  assert.deepEqual(await runDue(env, now + 2000), { due: 1, sent: 0, failed: 0, removed: 0, idle: 1 }, "端末がなくても詰まらない");
  await sync(env, key, [item("m", { title: "掃除", alarm: now + 3 })]);
  await call(env, "/api/push/subscribe", { subscription: gone.sub }, key);
  await call(env, "/api/push/subscribe", { subscription: live.sub }, key);
  const f = stubFetch((url) => new Response(null, { status: url === gone.sub.endpoint ? 410 : 201 }));
  try {
    const r = await runDue(env, now + 2000);
    assert.deepEqual([r.sent, r.removed], [1, 1]);
    assert.equal(decrypt(live, f.calls.find((c) => c.url === live.sub.endpoint).init.body).body, "未着手のアラームです");
    assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM devices").get().n, 1, "失効した端末は削除");
  } finally { f.restore(); }
});

await test("一時的な失敗は次の分に再送し、6時間たったら諦める", async () => {
  const env = mkEnv(), key = newKey();
  const dev = newDevice();
  const now = Date.now();
  await sync(env, key, [item("r", { alarm: now + 1 })]);
  await call(env, "/api/push/subscribe", { subscription: dev.sub }, key);
  let status = 500;
  const f = stubFetch(() => new Response(null, { status }));
  try {
    assert.equal((await runDue(env, now + 2000)).failed, 1);
    assert.equal(env.DB.db.prepare("SELECT sent FROM reminders WHERE id='r'").get().sent, 0);
    status = 201;
    assert.equal((await runDue(env, now + 62000)).sent, 1);
    await sync(env, key, [item("z", { alarm: now + 3 })]);
    status = 503;
    await runDue(env, now + 7 * 3600 * 1000);
    assert.equal(env.DB.db.prepare("SELECT sent FROM reminders WHERE id='z'").get().sent, 2);
  } finally { f.restore(); }
});

await test("1分あたりの送信数に上限があり、残りは次の分に回る", async () => {
  const env = mkEnv(), key = newKey();
  const devs = Array.from({ length: 5 }, () => newDevice());
  const now = Date.now();
  await sync(env, key, Array.from({ length: 20 }, (_, i) => item("b" + i, { alarm: now + 1 })));
  for (const d of devs) await call(env, "/api/push/subscribe", { subscription: d.sub }, key);
  const f = stubFetch(() => new Response(null, { status: 201 }));
  try {
    const r1 = await runDue(env, now + 2000);
    assert.ok(f.calls.length <= 40, "送信 " + f.calls.length);
    assert.equal(r1.sent, 8);
    const r2 = await runDue(env, now + 62000);
    assert.equal(r2.sent, 8);
  } finally { f.restore(); }
});

await test("端末の登録・解除・テスト通知は、同じコードの端末だけ操作できる。端末数には上限がある", async () => {
  const env = mkEnv(), a = newKey(), b = newKey();
  const dev = newDevice();
  assert.equal((await call(env, "/api/push/subscribe", { subscription: { ...dev.sub, endpoint: "https://evil.example.com/x" } }, a)).status, 400);
  assert.equal((await call(env, "/api/push/subscribe", { subscription: dev.sub })).status, 401);
  await call(env, "/api/push/subscribe", { subscription: dev.sub }, a);
  const f = stubFetch(() => new Response(null, { status: 201 }));
  try {
    assert.equal((await call(env, "/api/push/test", { endpoint: dev.sub.endpoint }, b)).status, 404, "他人の端末には送れない");
    const r = await call(env, "/api/push/test", { endpoint: dev.sub.endpoint }, a);
    assert.equal(r.status, 200);
    assert.equal(decrypt(dev, f.calls[0].init.body).title, "テスト通知");
  } finally { f.restore(); }
  await call(env, "/api/push/unsubscribe", { endpoint: dev.sub.endpoint }, b);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM devices").get().n, 1, "他人は解除できない");
  await call(env, "/api/push/unsubscribe", { endpoint: dev.sub.endpoint }, a);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM devices").get().n, 0);
  for (let i = 0; i < 13; i++) { await call(env, "/api/push/subscribe", { subscription: newDevice().sub }, a); }
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM devices").get().n, 10);
});

await test("VAPID_KEYS が未設定なら分かるエラーを返す", async () => {
  const r = await handle(new Request("https://worker.test/api/vapid-public-key"), { DB: makeD1() });
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /VAPID_KEYS/);
});

console.log(`\n${passed} passed${process.exitCode ? " (failures above)" : ""}`);
