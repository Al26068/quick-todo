// ひとまとめセットアップ: npm run setup
// Cloudflare にログイン済み（または、ここでログイン）なら、データベース作成〜デプロイまで行います。
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const toml = join(root, "wrangler.toml");
const keysFile = join(root, "vapid-keys.json");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function wr(args, { input, inherit } = {}) {
  const r = spawnSync(npx, ["wrangler", ...args], { cwd: root, input, encoding: "utf8", stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || ""), stdout: r.stdout || "" };
}
const say = (m) => console.log("\n▶ " + m);
const die = (m) => { console.error("\n✖ " + m); process.exit(1); };

say("1/5 Cloudflare にログインしているか確認");
const who = wr(["whoami"]).out;
if (!/logged in|associated with the email/i.test(who) || /not authenticated/i.test(who)) {
  console.log("ブラウザが開くので、Cloudflare にログインして許可してください。");
  if (!wr(["login"], { inherit: true }).ok) die("ログインできませんでした。もう一度 npm run setup を実行してください。");
}

say("2/5 データベース (D1) を用意");
const findDb = () => {
  const r = wr(["d1", "list", "--json"]);
  try { return JSON.parse(r.stdout.slice(r.stdout.indexOf("["))).find((d) => d.name === "quick-todo"); } catch { return null; }
};
let db = findDb();
if (!db) {
  if (!wr(["d1", "create", "quick-todo"]).ok) die("データベースを作れませんでした。");
  db = findDb();
}
const dbId = db && (db.uuid || db.database_id);
if (!dbId) die("データベースのIDが取得できませんでした。`npx wrangler d1 list` で確認してください。");
let t = readFileSync(toml, "utf8");
t = t.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${dbId}"`);
writeFileSync(toml, t);
console.log("database_id =", dbId);

say("3/5 テーブルを作成");
if (!wr(["d1", "execute", "quick-todo", "--remote", "--yes", "--file=schema.sql"]).ok) die("テーブルを作れませんでした。");

say("4/5 通知用の鍵 (VAPID) を用意");
if (!existsSync(keysFile)) spawnSync("node", [join("scripts", "gen-vapid.mjs")], { cwd: root, stdio: "inherit" });
const keys = JSON.parse(readFileSync(keysFile, "utf8"));
console.log("公開鍵:", keys.publicKey);

say("5/5 デプロイ");
const dep = wr(["deploy"]);
console.log(dep.out);
if (!dep.ok) die("デプロイに失敗しました。");
const url = (dep.out.match(/https:\/\/[^\s]+\.workers\.dev/) || [])[0];
const sec = wr(["secret", "put", "VAPID_KEYS"], { input: JSON.stringify({ publicKey: keys.publicKey, privateJwk: keys.privateJwk }) });
if (!sec.ok) die("鍵の登録に失敗しました:\n" + sec.out);

console.log("\n✔ 完了しました");
console.log("サーバーのURL:", url || "(デプロイ結果に表示されたURL)");
console.log("→ アプリの 設定（雲/ベルのボタン）→ サーバー に、このURLを入れて保存してください。");
