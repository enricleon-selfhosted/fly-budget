-- Recurring items recognized by the bank's text ("bank text contains"), decision D28.
-- Hand-written like 0019-0021 (db:generate would also propose the pending legacy cleanup).
ALTER TABLE `schedules` ADD `match_text` text;
