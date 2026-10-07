-- jigsaw: sessions.aspect keeps the picture ratio exactly through a restart (spec D17).
--
-- The Supabase Postgres image sets extra_float_digits = 0, so a double precision value read
-- through the Data API (the rt server's supabase-js) comes back rounded to 15 significant
-- digits: a restored class would get a slightly different ratio than the one its pieces were
-- laid out with. The old browser-direct migrations hid this with `alter role ... set
-- extra_float_digits = 1`, which jigsaw must not do on the shared gyosil project. numeric
-- stores the decimal the server sent (the shortest text of the JS number) and returns the same
-- digits, so the number read back is the same double.
alter table jigsaw.sessions
  alter column aspect type numeric using aspect::numeric;
