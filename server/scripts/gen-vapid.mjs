// VAPID 鍵（通知サーバーの身分証）を1組つくる。
//   node scripts/gen-vapid.mjs
// 出力される vapid-keys.json を Worker の秘密情報 VAPID_KEYS として登録する。

import { writeFileSync, existsSync } from "node:fs";

const out = new URL("../vapid-keys.json", import.meta.url);
if (existsSync(out)) {
  console.error("vapid-keys.json はすでにあります。作り直すと、登録済みの端末は通知を受け取れなくなります。");
  console.error("本当に作り直す場合は、先にこのファイルを消してください。");
  process.exit(1);
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicKey = b64u(await crypto.subtle.exportKey("raw", pair.publicKey));
const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
delete privateJwk.key_ops;
delete privateJwk.ext;

writeFileSync(out, JSON.stringify({ publicKey, privateJwk }));
console.log("vapid-keys.json を作りました（他人に見せないでください）。");
console.log("次のコマンドで Worker に登録します:");
console.log("  npx wrangler secret put VAPID_KEYS < vapid-keys.json");
