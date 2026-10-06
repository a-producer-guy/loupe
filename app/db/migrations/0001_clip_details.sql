-- Reelarc Footage: clip details for the shoot page.
--
-- Adds one empty column, footage_proxy_jobs.media, where the proxy worker
-- notes each clip's length, frame size, frame rate, codec, audio tracks and
-- timecode. Nothing else changes; existing rows just start with no details.

ALTER TABLE "footage_proxy_jobs" ADD COLUMN "media" jsonb;