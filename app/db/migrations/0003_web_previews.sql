-- Reelarc Footage: web previews.
--
-- Adds one empty column, footage_proxy_jobs.preview_size_bytes: the size of
-- each clip's browser-playable preview (Previews/...mp4), which the proxy
-- worker now makes alongside the proxy. Nothing else changes; existing rows
-- just start with no preview.

ALTER TABLE "footage_proxy_jobs" ADD COLUMN "preview_size_bytes" bigint;