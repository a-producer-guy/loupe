"use client";

import { useRef, useState, type ReactNode } from "react";
import { getUploadManager } from "@/lib/upload/manager";
import { groupFileList, readEntries, takeEntries } from "@/lib/upload/read-drop";

/** The whole area is a drop target for card folders; clicking it opens a folder picker. */
export function DropZone({
  shootId,
  shootName,
  children,
  className = "",
}: {
  shootId: number;
  shootName: string;
  children: (state: { dragging: boolean; choose: () => void }) => ReactNode;
  className?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  // Kept in state (not a ref) so the click handler can be handed to children while rendering.
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  const choose = () => input?.click();

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    // The dropped items vanish once this handler returns, so grab them first.
    const entries = takeEntries(event.dataTransfer);
    if (entries.length === 0) return;
    const manager = getUploadManager();
    manager.startReading(shootId, shootName);
    void readEntries(entries, (count) => manager.readProgress(shootId, count)).then((groups) =>
      manager.add(shootId, groups, shootName),
    );
  };

  const onPick = (picker: HTMLInputElement) => {
    const groups = picker.files?.length ? groupFileList(picker.files) : [];
    picker.value = ""; // so picking the same folder again still counts as a change
    if (groups.length) void getUploadManager().add(shootId, groups, shootName);
  };

  return (
    <div
      data-dropzone
      className={className}
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
      {children({ dragging, choose })}
      <input
        ref={setInput}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => onPick(event.currentTarget)}
        {...{ webkitdirectory: "", directory: "" }}
      />
    </div>
  );
}
