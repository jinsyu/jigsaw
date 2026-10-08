-- jigsaw: 96 pieces (12 x 8) join the piece counts a class can use.
alter table jigsaw.sessions drop constraint sessions_piece_count_check;
alter table jigsaw.sessions
  add constraint sessions_piece_count_check check (piece_count in (12, 24, 48, 70, 96));
