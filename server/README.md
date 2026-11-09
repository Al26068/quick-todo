# 通知サーバー（やること ver 2.0）

アプリを閉じていても、アラームの時間にiPhoneへ通知を届けるためのサーバーです。
Cloudflare Workers（無料プランで動きます）と D1 を使います。

```
アプリ ──アラーム一覧──▶ Worker(D1に保存) ──毎分チェック──▶ Apple等のpushサービス ──▶ iPhone
```

- アプリがサーバーに送るのは、アラームを設定した付箋の「タイトル・段階・メモの冒頭・時刻」だけです。
- 送信先は Apple / Google / Mozilla / Microsoft の push サービスに限定しています。
- 認証はありません。通知の宛先（購読URL）は推測できない長い文字列で、それを知っている端末だけが自分の分を登録できます。

## セットアップ（初回だけ・約10分）

Node.js 20 以上と Cloudflare のアカウント（無料）が必要です。

```bash
cd server
npm install
npx wrangler login
```

**1. データベースを作る**

```bash
npx wrangler d1 create quick-todo
```

表示される `database_id` を `wrangler.toml` の `REPLACE_WITH_DATABASE_ID` に貼ります。
（wrangler が設定ファイルへの追記を提案してきたら、断って手で貼っても、受けてもどちらでも構いません。`[[d1_databases]]` が1つだけになっていることを確認してください。）

```bash
npx wrangler d1 execute quick-todo --remote --file=schema.sql
```

**2. デプロイする**

```bash
npx wrangler deploy
```

最後に `https://quick-todo-push.＜あなたのサブドメイン＞.workers.dev` というURLが表示されます。これが通知サーバーのURLです。

**3. 通知の鍵を登録する**

```bash
npm run keys
npx wrangler secret put VAPID_KEYS < vapid-keys.json
```

`vapid-keys.json` は他人に見せないでください（Git には入らない設定にしてあります）。
作り直すと、登録済みの端末は通知を受け取れなくなります。

**4. 動作を確認する**

ブラウザで `＜WorkerのURL＞/api/health` を開き、`{"ok":true,...}` と出れば成功です。

## アプリ側の設定

1. iPhoneのホーム画面に追加した「やること」を開く（Safariのタブでは通知できません。iOS 16.4 以降が必要です）
2. 右上のベルを押す
3. 「通知サーバーのURL」にWorkerのURLを貼って「URLを保存」
4. 「通知をオンにする」を押し、iPhoneの許可ダイアログで「許可」
5. 「テスト通知」で届くことを確認する

以降、未着手・実行中の付箋にアラームを設定すると、時間になったときに通知されます。付箋をタップすると、その付箋が開きます。

## 補足

- アプリを開くたびに、アラームの一覧がサーバーと同期されます。
- アラームは1分単位で、cron が毎分確認します。通知は最大で1分ほど遅れることがあります。
- 完了にした付箋のアラームは自動で解除されます。
- アプリの公開先が `https://al26068.github.io` 以外のときは、`wrangler.toml` の `ALLOWED_ORIGIN` を変えてください。
- 複数の端末（iPhone と iPad など）でも使えます。端末ごとに別々のアラーム一覧として扱われます。

## 開発・テスト

```bash
npm test      # 暗号化・API・cron のテスト
npm run dev   # ローカルで起動（http://localhost:8787）。先に下の .dev.vars を作る
```

`server/.dev.vars` の例（Git には入りません）:

```
VAPID_KEYS={"publicKey":"…","privateJwk":{…}}   # npm run keys で作った vapid-keys.json の中身
DEV=1
ALLOWED_ORIGIN=http://localhost:5173
```

ローカルのDBは `npx wrangler d1 execute quick-todo --local --file=schema.sql` で作ります。
`DEV=1` のときだけ、`127.0.0.1` への通知送信を許可します（本番では設定しません）。
