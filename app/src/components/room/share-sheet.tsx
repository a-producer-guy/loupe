"use client";

import { useState } from "react";

// Sharing a scene (Guy, Oct 7): a secret link anyone can open to watch the newest cut and leave notes pinned to
// moments. They can't change anything; their notes come here.

export function ShareSheet({ path, busy, onShare, onStop, onClose }: { path: string | null; busy: boolean; onShare: () => void; onStop: () => void; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const url = path ? `${window.location.origin}${path}` : null;
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="shareH" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet-card">
        <h2 id="shareH">Share the cut</h2>
        <p>Anyone with the link can watch the newest version and leave notes pinned to moments. They can&apos;t change anything: their notes come to you, and you decide what Loupe does with them.</p>
        {url ? (
          <>
            <div className="share-row">
              <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void navigator.clipboard.writeText(url).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1800);
                  });
                }}
              >
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
            <p className="fine">
              Stop sharing and this link stops working for good.{" "}
              <button type="button" className="textlink" disabled={busy} onClick={onStop}>
                Stop sharing
              </button>
            </p>
          </>
        ) : (
          <button type="button" className="btn" disabled={busy} onClick={onShare}>
            Make a link
          </button>
        )}
        <div style={{ marginTop: 18 }}>
          <button type="button" className="btn soft" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
