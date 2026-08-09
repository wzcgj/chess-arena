-- Chess Arena 数据库初始化（Supabase / Postgres）
-- 在 Supabase 控制台 → SQL Editor 中粘贴并运行一次即可。
-- 应用启动时会自动检测这些表是否存在（见 server/store.js 的 initStore）。

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  username text unique not null,
  salt text not null,
  hash text not null,
  created_at bigint not null default 0
);

create table if not exists tokens (
  token text primary key,
  username text not null
);

create table if not exists games (
  id text primary key,
  username text not null,
  opponent text not null default '—',
  mode text not null default 'single',
  result text not null default '*',
  pgn text not null default '',
  fen text not null default '',
  moves jsonb not null default '[]'::jsonb,
  duration_sec int not null default 0,
  raw text not null default '',
  created_at bigint not null default 0
);

create index if not exists idx_games_username on games (username, created_at desc);
