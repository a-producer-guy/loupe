"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Loupe } from "@/components/loupe/loupe";
import { TopBar } from "@/components/shell/top-bar";
import { Button } from "@/components/ui/button";
import { localDay } from "@/lib/hooks";
import { getUploadManager } from "@/lib/upload/manager";
import { groupFileList, readEntries, takeEntries, type PickedGroup } from "@/lib/upload/read-drop";
import { asScene } from "@/lib/upload/scene-drop";

type Step = { kind: "waiting" } | { kind: "reading"; found: number } | { kind: "starting"; name: string } | { kind: "error"; message: string; planNeeded?: boolean };

/**
 * "Drop your scene." The whole page takes the shoot folder: Loupe names the scene after it, starts
 * uploading and opens the scene, with nothing to fill in first.
 */
export function NewScene({ planNeeded, free }: { planNeeded: string | null; free: boolean }) {
  const router = useRouter();
  const [dragging, setDragging] = useState(false);
  const [step, setStep] = useState<Step>(planNeeded ? { kind: "error", message: planNeeded, planNeeded: true } : { kind: "waiting" });
  const depth = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  const busy = step.kind === "reading" || step.kind === "starting";

  const start = async (groups: PickedGroup[]) => {
    if (!groups.some((g) => g.files.length)) {
      setStep({ kind: "error", message: "That folder looks empty. Drop the folder from the shoot, with the camera cards inside." });
      return;
    }
    const today = localDay(new Date());
    const scene = asScene(groups, today);
    setStep({ kind: "starting", name: scene.name });
    const response = await fetch("/api/shoots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: scene.name, shootDate: today }),
    }).catch(() => null);
    if (!response?.ok) {
      const body = (await response?.json().catch(() => null)) as { error?: string; code?: string } | null;
      setStep({ kind: "error", message: body?.error ?? "Couldn't reach Loupe. Check the internet connection and drop the folder again.", planNeeded: body?.code === "plan-needed" });
      return;
    }
    const { shoot } = (await response.json()) as { shoot: { id: number; name: string } };
    void getUploadManager().add(shoot.id, scene.groups, shoot.name);
    router.push(`/scenes/${shoot.id}`);
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    if (busy || planNeeded) return;
    // The dropped items vanish once this handler returns, so grab them first.
    const entries = takeEntries(event.dataTransfer);
    if (entries.length === 0) return;
    setStep({ kind: "reading", found: 0 });
    void readEntries(entries, (found) => setStep({ kind: "reading", found })).then(start);
  };

  return (
    <>
      <TopBar crumbs={[{ label: "Your scenes", href: "/scenes" }, { label: "New scene" }]} />
      <main
        className="relative flex-1 overflow-y-auto"
        onDragEnter={(event) => {
          event.preventDefault();
          depth.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setDragging(false);
        }}
        onDrop={onDrop}
      >
        <div className="mx-auto grid w-full max-w-[1100px] gap-7 px-5 pb-16 pt-[6vh] sm:px-8">
          <div className="flex items-center gap-4">
            <Loupe size={64} mood={busy ? "think" : dragging ? "listen" : "idle"} dept="edit" label="Loupe" three />
            <p className="text-[15px] text-muted">
              Hi, I&apos;m <span className="font-medium text-text">Loupe</span>. I watch every take so you can direct.
            </p>
          </div>
          <h1 className="text-[clamp(46px,8.4vw,120px)] font-semibold leading-[0.9] tracking-[-0.055em] text-balance">
            Drop your scene<span className="text-faint">.</span>
          </h1>
          <p className="-mt-1 max-w-[44ch] text-[clamp(16px,1.5vw,19px)] text-muted">
            The whole folder from the shoot: camera cards, sound and the script. It uploads, makes editing proxies, and I get to work.
          </p>

          <div
            onClick={() => !busy && !planNeeded && picker.current?.click()}
            className={`relative grid cursor-pointer gap-5 rounded-[22px] bg-surface p-8 shadow-lift transition ${dragging ? "bg-[#fffbfa]" : ""} ${busy || planNeeded ? "cursor-default" : ""}`}
          >
            <div className={`pointer-events-none absolute inset-3 rounded-2xl border-[1.5px] border-dashed transition-colors ${dragging ? "border-tally" : "border-line-strong"}`} />
            <div className="relative">
              {step.kind === "reading" ? (
                <p className="text-[17px] font-medium">Reading the folder… {step.found ? `${step.found.toLocaleString()} files` : ""}</p>
              ) : step.kind === "starting" ? (
                <p className="text-[17px] font-medium">Starting “{step.name}”…</p>
              ) : step.kind === "error" ? (
                <div className="grid gap-3">
                  <p className="text-[16px] font-medium text-bad">{step.message}</p>
                  <div className="flex flex-wrap gap-3">
                    {step.planNeeded ? (
                      <Link href="/plan" onClick={(event) => event.stopPropagation()}>
                        <Button variant="primary">See plans</Button>
                      </Link>
                    ) : (
                      <Button variant="primary" onClick={(event) => { event.stopPropagation(); setStep({ kind: "waiting" }); picker.current?.click(); }}>
                        Choose a folder
                      </Button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <Button variant="primary" size="lg" onClick={(event) => { event.stopPropagation(); picker.current?.click(); }}>
                    Choose a folder
                  </Button>
                  <span className="text-[14px] text-muted">or drag it anywhere on this page</span>
                </div>
              )}
            </div>
            <div className="relative flex flex-wrap gap-x-6 gap-y-1.5 text-[12.5px] text-faint">
              <span>Folders kept as shot</span>
              <span>Hidden files skipped</span>
              <span>Proxies made for Premiere</span>
              {free && !planNeeded && <span>Cutting is free. You pay when you export.</span>}
            </div>
          </div>
        </div>
        <input
          ref={picker}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            const list = event.currentTarget.files;
            const groups = list?.length ? groupFileList(list) : [];
            event.currentTarget.value = "";
            if (groups.length) void start(groups);
          }}
          {...{ webkitdirectory: "", directory: "" }}
        />
      </main>
    </>
  );
}
