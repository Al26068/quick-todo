# 同期・通知サーバー（やること ver 3.0）

iPhone・iPad・PCの付箋を同じ内容にそろえ、アラームの時間に全端末へ通知を届けるサーバーです。
Cloudflare Workers（無料プランで動きます）と D1 を使います。

```
端末A ─┐                                     ┌─▶ 端末A（通知）
端末B ─┼─ 付箋の差分を送受信 ─▶ Worker + D1 ─┼─▶ 端末B（通知）
端末C ─┘        毎分 cron でアラーム確認 ────┴─▶ 端末C（通知）
```

## しくみ

- **同期コード**: 1台目がランダムな鍵（26文字）を作ります。アカウントやパスワードはありません。コードを知っている端末だけが同じデータを読み書きできます。サーバーには鍵そのものではなく、そのハッシュだけを保存します。
- **付箋ごとに新しいほうが勝つ**: 付箋には最終編集時刻があり、同じ付箋を2台で編集したら、あとの編集を採用します。削除は印（墓標）を残して伝えます。
- **差分だけ送受信**: 端末は「前回の続き」の位置を覚えていて、変わった付箋だけをやり取りします。開いている間は45秒ごと、編集の1.5秒後にも同期します。
- **アラーム**: 付箋から自動でアラーム表が作られ、時間が来ると、そのコードに登録された全端末へ Web Push で通知します。
- 上限: 1コードあたり付箋2000枚、通知先の端末10台。

## セットアップ（初回だけ・約10分）

Node.js 20 以上と Cloudflare のアカウント（無料）が必要です。

```bash
cd server
npm install
npm run setup
```

`npm run setup` は、Cloudflare へのログイン（ブラウザが開きます）→ データベース作成 → テーブル作成 → 通知用の鍵の生成 → デプロイ → 鍵の登録 までを行い、最後にサーバーのURL（`https://quick-todo-push.＜サブドメイン＞.workers.dev`）を表示します。

うまくいかない場合は、次の手動手順でも同じことができます。

```bash
npx wrangler login
npx wrangler d1 create quick-todo          # 表示された database_id を wrangler.toml に貼る
npx wrangler d1 execute quick-todo --remote --file=schema.sql
npx wrangler deploy
npm run keys
npx wrangler secret put VAPID_KEYS < vapid-keys.json
```

確認: ブラウザで `＜WorkerのURL＞/api/health` を開き、`{"ok":true,...}` と出れば成功です。
ver 2.0 のサーバーを使っていた場合も、同じ手順をもう一度流せば更新できます（古いテーブルは自動で整理されます。ver 2.0 のアラーム登録は引き継がれないので、付箋を同期すると作り直されます）。

## アプリ側の設定

1. **1台目**（例: iPhone）: ホーム画面の「やること」を開き、右上の雲ボタン →「サーバー」にURLを貼って保存 →「この端末から同期を始める」
2. 表示された **同期コード** をコピーして、2台目に送る（自分宛てのメッセージなどで）
3. **2台目以降**（iPad・PC）: アプリを開き、雲ボタン →「同期に参加する」にコードを貼って「参加する」。サーバーのURLはコードに含まれているので入力不要です
4. 通知が欲しい端末では、ベルのボタン →「通知をオンにする」（iPhone/iPadはホーム画面に追加したアプリから。iOS 16.4 以降）

以降、どの端末で追加・移動・編集しても、ほかの端末に反映されます。

## API

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/api/health` | 動作確認 |
| GET | `/api/vapid-public-key` | 通知の公開鍵 |
| POST | `/api/data/sync` | 付箋の送受信 `{items, since}` → `{exists, items, cursor, more}`（`Authorization: Bearer <鍵>`） |
| POST | `/api/data/delete` | このコードのデータをすべて削除 |
| POST | `/api/push/subscribe` / `unsubscribe` / `test` | 通知先の登録・解除・テスト |

ver 2.0 の `/api/sync` などは 410 を返します。

## 注意

- 同期コードは合鍵です。漏れたと思ったら、アプリの「サーバーのデータを削除」→ 新しく同期を始め直してください。
- 付箋の中身はサーバーに平文で保存されます（通知の本文に使うため）。機微な内容は書かないでください。
- アプリの公開先が `https://al26068.github.io` 以外のときは、`wrangler.toml` の `ALLOWED_ORIGIN` を変えてください。
- 通知は cron が毎分確認するため、最大1分ほど遅れることがあります。

## 開発・テスト

```bash
npm test      # 暗号化・API・同期・cron のテスト（23件）
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
