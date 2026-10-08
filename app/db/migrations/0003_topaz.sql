-- Loupe: Topaz 4K finals. Adds two columns to loupe_finals; changes nothing else.
--
-- request: fal's request for a Topaz 4K version, saved the moment it's made, so a restarted worker waits for it
--   instead of paying for it twice.
-- cost: what that 4K version cost, in dollars.

ALTER TABLE "loupe_finals" ADD COLUMN "request" jsonb;--> statement-breakpoint
ALTER TABLE "loupe_finals" ADD COLUMN "cost" real;