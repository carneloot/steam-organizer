CREATE TABLE classification_errors (
  owner TEXT NOT NULL,
  appid INTEGER NOT NULL,
  job_id TEXT NOT NULL,
  error TEXT NOT NULL,
  PRIMARY KEY (owner, appid),
  FOREIGN KEY (owner, appid) REFERENCES library_games(owner, appid) ON DELETE CASCADE
);
