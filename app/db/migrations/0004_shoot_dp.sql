-- Reelarc Footage: the DP on each shoot.
--
-- Adds one empty column, footage_projects.dp_name: the DP (director of
-- photography) who shot it, typed in when the shoot is made or added later.
-- Nothing else changes; existing shoots just start with no DP.

ALTER TABLE "footage_projects" ADD COLUMN "dp_name" text;