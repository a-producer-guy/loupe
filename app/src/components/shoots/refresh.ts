"use client";

import { useEffect, useRef } from "react";

/** Refreshes the server's view as soon as this tab finishes files, instead of waiting for the next poll. */
export function useRefreshWhenSettled(active: boolean, filesDone: number, refresh: () => void) {
  const was = useRef({ active, filesDone });
  useEffect(() => {
    const before = was.current;
    was.current = { active, filesDone };
    if ((before.active && !active) || filesDone - before.filesDone >= 1) {
      const id = setTimeout(refresh, 300);
      return () => clearTimeout(id);
    }
  }, [active, filesDone, refresh]);
}
