import type { Metadata } from "next";
import { getDb } from "@/lib/db/client";
import { watchState } from "@/lib/footage/share";
import { signView } from "@/lib/storage";
import { WatchView } from "./watch-view";

export const metadata: Metadata = { title: "Loupe · Watch the cut", robots: { index: false, follow: false } };

/** A share link: anyone with it watches the newest cut and leaves notes; nothing here changes the cut. */
export default async function WatchPage(props: PageProps<"/watch/[token]">) {
  const token = (await props.params).token;
  const state = await watchState(getDb(), token, signView);
  if (!state) {
    return (
      <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24, background: "var(--bg)", color: "var(--muted)", textAlign: "center" }}>
        <div>
          <p style={{ fontSize: 22, fontWeight: 600, color: "var(--text)", margin: 0 }}>This link doesn&apos;t work any more.</p>
          <p style={{ margin: "8px 0 0" }}>Ask whoever sent it for a new one.</p>
        </div>
      </main>
    );
  }
  return <WatchView token={token} initial={state} />;
}
