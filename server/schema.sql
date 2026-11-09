-- やること ver 2.0 通知サーバーのテーブル（Cloudflare D1）

CREATE TABLE IF NOT EXISTS subs (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alarms (
  endpoint TEXT NOT NULL,
  id       TEXT NOT NULL,
  title    TEXT NOT NULL,
  stage    TEXT NOT NULL,
  note     TEXT NOT NULL DEFAULT '',
  fire_at  INTEGER NOT NULL,
  sent     INTEGER NOT NULL DEFAULT 0,  -- 0: 未送信 / 1: 送信済み / 2: 諦めた
  rev      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (endpoint, id)
);

CREATE INDEX IF NOT EXISTS alarms_due ON alarms (sent, fire_at);
