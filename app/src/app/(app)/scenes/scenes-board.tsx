"use client";

import { Plus, SearchX } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { NewShootRow, NewShootTile, ShootList, ShootRow, ShootTile } from "@/components/shoots/shoot-tile";
import { StatusBar, TopBar } from "@/components/shell/top-bar";
import { Loupe } from "@/components/loupe/loupe";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { useViewMode, ViewToggle, type ViewMode } from "@/components/ui/view-toggle";
import { formatBytes, searchWords, shootSearchText } from "@/lib/footage/names";
import type { ShootSummary } from "@/lib/footage/status";
import { usePolling, useShootSearch, useUploadsOverview } from "@/lib/hooks";

/** Every scene in the account, newest first: scenes are dated by their shoot day. */
export const ALL_SCENES = { from: "2000-01-01", to: "2100-01-01" };

export function ScenesBoard({ initial }: { initial: ShootSummary[] }) {
  const [scenes, refresh] = usePolling(`/api/shoots?from=${ALL_SCENES.from}&to=${ALL_SCENES.to}`, "shoots", initial);
  const [query, setQuery] = useState("");
  const [view, setView] = useViewMode("loupe.scenesView");
  const uploads = useUploadsOverview();
  const everyMatch = useShootSearch(query);

  const words = searchWords(query);
  const searching = words.length > 0;
  const results = searching ? (everyMatch ?? scenes.filter((s) => words.every((word) => shootSearchText(s).includes(word)))) : scenes;
  const total = scenes.reduce((sum, s) => sum + s.files.bytesUploaded, 0);

  return (
    <>
      <TopBar
        crumbs={[{ label: "Your scenes" }]}
        actions={
          <Link href="/scenes/new">
            <Button variant="primary" size="sm">
              <Plus className="size-4" /> New scene
            </Button>
          </Link>
        }
      />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1480px] px-4 pb-16 pt-8 sm:px-8">
          {scenes.length === 0 ? (
            <FirstScene />
          ) : (
            <>
              <div className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
                <div>
                  <h1 className="text-[30px] font-semibold leading-tight tracking-[-0.035em]">Your scenes</h1>
                  <p className="mt-1 text-[14px] text-muted">
                    {scenes.length} scene{scenes.length === 1 ? "" : "s"} · {formatBytes(total)} of footage
                  </p>
                </div>
                <div className="flex w-full items-center gap-2 sm:w-auto">
                  <SearchField value={query} onChange={setQuery} placeholder="Search your scenes" className="flex-1 sm:w-64 sm:flex-none" />
                  <ViewToggle view={view} onChange={setView} />
                </div>
              </div>
              {searching && results.length === 0 ? (
                <NoMatch query={query.trim()} complete={everyMatch !== null} onClear={() => setQuery("")} />
              ) : (
                <Scenes scenes={results} view={view} onChanged={refresh} showNew={!searching} />
              )}
            </>
          )}
        </div>
      </main>
      <StatusBar right={uploads.active ? <span className="font-medium text-tally">Uploading · keep this tab open</span> : null}>
        {scenes.length} scene{scenes.length === 1 ? "" : "s"} · {formatBytes(total)} stored
      </StatusBar>
    </>
  );
}

function Scenes({ scenes, view, onChanged, showNew }: { scenes: ShootSummary[]; view: ViewMode; onChanged: () => void; showNew: boolean }) {
  if (view === "grid") {
    return (
      <Grid>
        {showNew && <NewShootTile />}
        {scenes.map((scene) => (
          <ShootTile key={scene.id} shoot={scene} onChanged={onChanged} />
        ))}
      </Grid>
    );
  }
  return (
    <ShootList>
      {showNew && <NewShootRow />}
      {scenes.map((scene) => (
        <ShootRow key={scene.id} shoot={scene} onChanged={onChanged} />
      ))}
    </ShootList>
  );
}

/** The very first visit: Loupe, and one thing to do. */
function FirstScene() {
  return (
    <div className="mx-auto mt-[8vh] max-w-xl animate-rise text-center">
      <Loupe size={84} mood="idle" dept="edit" label="Loupe" />
      <h1 className="mt-6 text-[40px] font-semibold leading-none tracking-[-0.05em] sm:text-[52px]">Drop your first scene.</h1>
      <p className="mx-auto mt-4 max-w-md text-[16px] text-muted">
        The whole folder from the shoot: camera cards, sound and the script. It uploads, makes editing proxies, and Loupe gets to work.
      </p>
      <Link href="/scenes/new" className="mt-7 inline-block">
        <Button variant="primary">Start a scene</Button>
      </Link>
      <p className="mt-4 text-[12.5px] text-faint">Your first scene is free.</p>
    </div>
  );
}

function NoMatch({ query, complete, onClear }: { query: string; complete: boolean; onClear: () => void }) {
  if (!complete) return <p className="text-[13px] text-muted">Searching…</p>;
  return (
    <div className="animate-rise rounded-2xl border border-dashed border-line-strong px-6 py-16 text-center">
      <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-surface-2 text-muted">
        <SearchX className="size-6" strokeWidth={1.7} />
      </div>
      <p className="mt-4 text-[16px] font-semibold">No scenes match “{query}”</p>
      <p className="mx-auto mt-1 max-w-sm text-[13.5px] text-muted">Search by name, month or date, like “offer” or “sep 23”.</p>
      <Button variant="secondary" size="sm" className="mt-5" onClick={onClear}>
        Clear search
      </Button>
    </div>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(270px,1fr))]">{children}</div>;
}
