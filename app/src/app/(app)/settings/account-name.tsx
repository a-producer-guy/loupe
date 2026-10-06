"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/** The account's name (the studio or filmmaker). Only the owner can change it. */
export function AccountName({ initial, canEdit }: { initial: string; canEdit: boolean }) {
  const [name, setName] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setState("saving");
    const response = await fetch("/api/account", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }).catch(() => null);
    if (!response?.ok) return setState("error");
    const body = (await response.json()) as { name: string };
    setName(body.name);
    setSaved(body.name);
    setState("saved");
  };

  return (
    <form onSubmit={save}>
      <label className="text-[13px] text-faint" htmlFor="account-name">
        Studio or name
      </label>
      <div className="mt-1.5 flex flex-wrap gap-2">
        <input
          id="account-name"
          value={name}
          disabled={!canEdit}
          onChange={(event) => {
            setName(event.target.value);
            setState("idle");
          }}
          maxLength={80}
          className="h-10 min-w-0 flex-1 rounded-xl bg-bg px-3.5 text-[15px] ring-1 ring-line-strong focus:outline-none focus:ring-2 focus:ring-text disabled:text-muted"
        />
        {canEdit && (
          <Button type="submit" variant="primary" disabled={state === "saving" || name.trim() === saved}>
            {state === "saving" ? "Saving…" : "Save"}
          </Button>
        )}
      </div>
      <p className="mt-1.5 min-h-4 text-[12.5px]">
        {state === "saved" ? <span className="text-good">Saved.</span> : state === "error" ? <span className="text-bad">Couldn&apos;t save. Try again.</span> : !canEdit ? <span className="text-faint">Only the account owner can change this.</span> : null}
      </p>
    </form>
  );
}
