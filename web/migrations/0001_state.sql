CREATE TABLE libraries (
  owner TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  steam_id TEXT,
  job_present INTEGER NOT NULL DEFAULT 0 CHECK (job_present IN (0, 1)),
  criteria_present INTEGER NOT NULL DEFAULT 0 CHECK (criteria_present IN (0, 1)),
  requests_present INTEGER NOT NULL DEFAULT 0 CHECK (requests_present IN (0, 1)),
  operation TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(operation)),
  flight TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(flight)),
  result TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(result)),
  completed TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(completed))
);

CREATE TABLE library_games (
  owner TEXT NOT NULL REFERENCES libraries(owner) ON DELETE CASCADE,
  appid INTEGER NOT NULL CHECK (appid > 0),
  position INTEGER NOT NULL CHECK (position >= 0),
  name TEXT NOT NULL,
  playtime_forever INTEGER NOT NULL CHECK (playtime_forever >= 0),
  playtime_2weeks INTEGER CHECK (playtime_2weeks >= 0),
  tags TEXT NOT NULL CHECK (json_valid(tags)),
  reviewed INTEGER NOT NULL CHECK (reviewed IN (0, 1)),
  PRIMARY KEY (owner, appid)
);
CREATE INDEX library_games_order ON library_games(owner, position);

CREATE TABLE category_criteria (
  owner TEXT NOT NULL REFERENCES libraries(owner) ON DELETE CASCADE,
  steam_id TEXT NOT NULL,
  criteria TEXT NOT NULL CHECK (json_valid(criteria)),
  PRIMARY KEY (owner, steam_id)
);

CREATE TABLE classification_jobs (
  owner TEXT PRIMARY KEY NOT NULL REFERENCES libraries(owner) ON DELETE CASCADE,
  id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'failed', 'cancelled')),
  total INTEGER NOT NULL CHECK (total >= 0),
  completed INTEGER NOT NULL CHECK (completed >= 0),
  current TEXT,
  error TEXT,
  steam_id TEXT,
  ids TEXT NOT NULL CHECK (json_valid(ids)),
  criteria TEXT NOT NULL CHECK (json_valid(criteria)),
  cancel INTEGER NOT NULL CHECK (cancel IN (0, 1))
);

CREATE TABLE classification_requests (
  owner TEXT NOT NULL REFERENCES libraries(owner) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (json_valid(operation)),
  flight TEXT NOT NULL CHECK (json_valid(flight)),
  result TEXT NOT NULL CHECK (json_valid(result)),
  completed TEXT NOT NULL CHECK (json_valid(completed)),
  PRIMARY KEY (owner, request_id)
);
