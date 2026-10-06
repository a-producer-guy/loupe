"use client";

import { Plus, SearchX } from "lucide-react";
import { useState, type ReactNode } from "react";
import { NewShootDialog } from "@/components/shoots/new-shoot-dialog";
import { NewShootRow, NewShootTile, ShootList, ShootListGroup, ShootRow, ShootTile } from "@/components/shoots/shoot-tile";
import { StatusBar, TopBar } from "@/components/shell/top-bar";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { useToast } from "@/components/ui/toast";
import { useViewMode, ViewToggle, type ViewMode } from "@/components/ui/view-toggle";
import { longDate } from "@/lib/dates";
import { formatBytes, searchWords, shootSearchText } from "@/lib/footage/names";
import type { ShootSummary } from "@/lib/footage/status";
import { usePolling, useShootSearch, useToday, useUploadsOverview } from "@/lib/hooks";

export function TodayBoard({ initial }: { initial: ShootSummary[] }) {
  const [shoots, refresh] = usePolling("/api/shoots", "shoots", initial);
  const today = useToday();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [view, setView] = useViewMode("footage.shootsView");
  const toast = useToast();
  const uploads = useUploadsOverview();
  const everyMatch = useShootSearch(query);

  const words = searchWords(query);
  const searching = words.length > 0;
  // Matches from the shoots already on screen show at once; the server then adds any from further back.
  const results = searching ? (everyMatch ?? shoots.filter((s) => words.every((word) => shootSearchText(s).includes(word)))) : [];

  const todays = today ? shoots.filter((s) => s.shootDate === today) : [];
  const upcoming = today ? shoots.filter((s) => s.shootDate > today).sort((a, b) => a.shootDate.localeCompare(b.shootDate)) : [];
  const earlier = today ? shoots.filter((s) => s.shootDate < today) : [];
  const total = shoots.reduce((sum, s) => sum + s.files.bytesUploaded, 0);
  const newShoot = () => setCreating(true);

  return (
    <>
      <TopBar
        crumbs={[{ label: "Today" }]}
        actions={
          <Button variant="primary" size="sm" onClick={newShoot}>
            <Plus className="size-4" /> New shoot
          </Button>
        }
      />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1480px] px-4 pb-16 pt-8 sm:px-8">
          {!today ? (
            <Skeleton />
          ) : (
            <>
              <div className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
                <div>
                  <h1 className="text-[30px] font-semibold leading-tight tracking-tight">Today</h1>
                  <p className="mt-1 text-[14px] text-muted">
                    {longDate(today)}
                    {todays.length > 0 && ` · ${todays.length} shoot${todays.length === 1 ? "" : "s"}`}
                  </p>
                </div>
                <div className="flex w-full items-center gap-2 sm:w-auto">
                  <SearchField value={query} onChange={setQuery} placeholder="Search all shoots" className="flex-1 sm:w-64 sm:flex-none" />
                  <ViewToggle view={view} onChange={setView} />
                </div>
              </div>

              {searching ? (
                <SearchResults
                  query={query.trim()}
                  shoots={results}
                  complete={everyMatch !== null}
                  view={view}
                  onChanged={refresh}
                  onClear={() => setQuery("")}
                />
              ) : view === "grid" ? (
                <>
                  <Grid>
                    {todays.map((shoot) => (
                      <ShootTile key={shoot.id} shoot={shoot} onChanged={refresh} />
                    ))}
                    <NewShootTile onClick={newShoot} />
                  </Grid>
                  {upcoming.length > 0 && (
                    <Section title="Coming up" count={upcoming.length}>
                      {upcoming.map((shoot) => (
                        <ShootTile key={shoot.id} shoot={shoot} onChanged={refresh} />
                      ))}
                    </Section>
                  )}
                  {earlier.length > 0 && (
                    <Section title="Earlier" count={earlier.length}>
                      {earlier.map((shoot) => (
                        <ShootTile key={shoot.id} shoot={shoot} onChanged={refresh} />
                      ))}
                    </Section>
                  )}
                </>
              ) : (
                <ShootList>
                  {(upcoming.length > 0 || earlier.length > 0) && <ShootListGroup title="Today" count={todays.length} first />}
                  {todays.map((shoot) => (
                    <ShootRow key={shoot.id} shoot={shoot} onChanged={refresh} />
                  ))}
                  <NewShootRow onClick={newShoot} />
                  {upcoming.length > 0 && <ShootListGroup title="Coming up" count={upcoming.length} />}
                  {upcoming.map((shoot) => (
                    <ShootRow key={shoot.id} shoot={shoot} onChanged={refresh} />
                  ))}
                  {earlier.length > 0 && <ShootListGroup title="Earlier" count={earlier.length} />}
                  {earlier.map((shoot) => (
                    <ShootRow key={shoot.id} shoot={shoot} onChanged={refresh} />
                  ))}
                </ShootList>
              )}
            </>
          )}
        </div>
      </main>
      <StatusBar right={uploads.active ? <span className="text-pink">Uploading · keep this tab open</span> : null}>
        {shoots.length} shoot{shoots.length === 1 ? "" : "s"} in the last month · {formatBytes(total)} stored
      </StatusBar>
      {today && (
        <NewShootDialog
          open={creating}
          today={today}
          onClose={() => setCreating(false)}
          onCreated={(shoot) => {
            setQuery("");
            void refresh();
            toast({ tone: "good", title: `${shoot.name} is ready`, detail: "Drop the camera cards on it." });
          }}
        />
      )}
    </>
  );
}

function SearchResults({
  query,
  shoots,
  complete,
  view,
  onChanged,
  onClear,
}: {
  query: string;
  shoots: ShootSummary[];
  complete: boolean;
  view: ViewMode;
  onChanged: () => void;
  onClear: () => void;
}) {
  if (shoots.length === 0) {
    return complete ? (
      <div className="animate-rise rounded-2xl border border-dashed border-line-strong px-6 py-16 text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-surface-2 text-muted">
          <SearchX className="size-6" strokeWidth={1.7} />
        </div>
        <p className="mt-4 text-[16px] font-semibold">No shoots match “{query}”</p>
        <p className="mx-auto mt-1 max-w-sm text-[13.5px] text-muted">Search by name, DP, month or date, like “Jane” or “sep 23”.</p>
        <Button variant="secondary" size="sm" className="mt-5" onClick={onClear}>
          Clear search
        </Button>
      </div>
    ) : (
      <p className="text-[13px] text-muted">Searching…</p>
    );
  }

  return (
    <>
      <p className="mb-4 text-[13px] text-muted">
        <span className="font-medium text-text">
          {shoots.length} {shoots.length === 1 ? "shoot matches" : "shoots match"}
        </span>{" "}
        “{query}”
      </p>
      {view === "grid" ? (
        <Grid>
          {shoots.map((shoot) => (
            <ShootTile key={shoot.id} shoot={shoot} onChanged={onChanged} />
          ))}
        </Grid>
      ) : (
        <ShootList>
          {shoots.map((shoot) => (
            <ShootRow key={shoot.id} shoot={shoot} onChanged={onChanged} />
          ))}
        </ShootList>
      )}
    </>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(270px,1fr))]">{children}</div>;
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="mt-12">
      <h2 className="mb-4 flex items-baseline gap-2 text-[15px] font-semibold">
        {title} <span className="text-[13px] font-normal text-faint">{count}</span>
      </h2>
      <Grid>{children}</Grid>
    </section>
  );
}

function Skeleton() {
  return (
    <div>
      <div className="skeleton mb-2 h-8 w-40 rounded-lg" />
      <div className="skeleton mb-8 h-4 w-56 rounded" />
      <Grid>
        {[0, 1, 2].map((i) => (
          <div key={i} className="overflow-hidden rounded-xl border border-line">
            <div className="skeleton aspect-video" />
            <div className="space-y-2 p-3.5">
              <div className="skeleton h-4 w-2/3 rounded" />
              <div className="skeleton h-3 w-1/2 rounded" />
            </div>
          </div>
        ))}
      </Grid>
    </div>
  );
}
