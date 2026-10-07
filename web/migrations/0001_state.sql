CREATE TABLE organizer_state (
  owner TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  document TEXT NOT NULL CHECK (json_valid(document))
);
