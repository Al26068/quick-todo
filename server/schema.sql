-- やること ver 3.0 サーバーのテーブル（Cloudflare D1）
-- 何度流しても安全です。ver 2.0 で作った古いテーブルは使わないので消します。

DROP TABLE IF EXISTS alarms;
DROP TABLE IF EXISTS subs;

-- 同期コードから作った識別子（コードそのものは保存しない）
CREATE TABLE IF NOT EXISTS users (
  uid        TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  seq        INTEGER NOT NULL DEFAULT 0     -- 書き込みのたびに増える番号
);

-- 付箋。data は付箋1枚分のJSON。u は最後に編集された時刻、seq は変更の通し番号
CREATE TABLE IF NOT EXISTS items (
  uid     TEXT NOT NULL,
  id      TEXT NOT NULL,
  data    TEXT NOT NULL,
  u       INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  seq     INTEGER NOT NULL,
  PRIMARY KEY (uid, id)
);
CREATE INDEX IF NOT EXISTS items_seq ON items (uid, seq);

-- 通知を受け取る端末（iPhone・iPad・PCなど）
CREATE TABLE IF NOT EXISTS devices (
  endpoint   TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_uid ON devices (uid);

-- アラーム。items から自動で作られる（直接は書き込まない）
CREATE TABLE IF NOT EXISTS reminders (
  uid     TEXT NOT NULL,
  id      TEXT NOT NULL,
  title   TEXT NOT NULL,
  stage   TEXT NOT NULL,
  note    TEXT NOT NULL DEFAULT '',
  fire_at INTEGER NOT NULL,
  sent    INTEGER NOT NULL DEFAULT 0,       -- 0: 未送信 / 1: 送信済み / 2: 諦めた
  PRIMARY KEY (uid, id)
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders (sent, fire_at);
