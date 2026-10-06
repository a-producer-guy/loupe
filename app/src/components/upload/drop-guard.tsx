"use client";

import { useEffect } from "react";

/**
 * A card dropped just outside a drop zone would otherwise make the browser
 * open the file and leave the page, stopping every upload in the tab.
 */
export function DropGuard() {
  useEffect(() => {
    const stop = (event: DragEvent) => {
      if (!(event.target as Element | null)?.closest?.("[data-dropzone]")) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
      }
    };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);
  return null;
}
