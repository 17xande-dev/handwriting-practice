-- Records gain a third kind, 'strokes' (a person's stroke definitions for one font). A CHECK cannot be
-- altered in place on a STRICT table, so the table is rebuilt: the old one is renamed (its
-- AUTOINCREMENT counter goes with it), the new one is filled with every row and its seq values, and the
-- counter is carried over so a deleted seq is still never handed out again.

DROP INDEX records_user_seq;
ALTER TABLE records RENAME TO records_old;

CREATE TABLE records (
	seq     INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	kind    TEXT    NOT NULL CHECK (kind IN ('check', 'ink', 'strokes')),
	id      TEXT    NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
	data    TEXT,
	UNIQUE (user_id, kind, id)
) STRICT;

INSERT INTO records (seq, user_id, kind, id, data)
	SELECT seq, user_id, kind, id, data FROM records_old;

UPDATE sqlite_sequence
	SET seq = max(seq, coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'records_old'), 0))
	WHERE name = 'records';
INSERT INTO sqlite_sequence (name, seq)
	SELECT 'records', seq FROM sqlite_sequence WHERE name = 'records_old'
	AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'records');

DROP TABLE records_old;
CREATE INDEX records_user_seq ON records(user_id, seq);
