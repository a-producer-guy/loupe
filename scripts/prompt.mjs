// Shared by the setup scripts: asking in the terminal and saving settings files.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** Asks one question in the terminal. `hidden` keeps what's typed or pasted off the screen. */
export function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const input = process.stdin;
    let answer = "";
    input.setEncoding("utf8");
    if (hidden && input.isTTY) input.setRawMode(true);
    input.resume();
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          input.off("data", onData);
          if (hidden && input.isTTY) input.setRawMode(false);
          input.pause();
          process.stdout.write("\n");
          // Some terminals wrap a paste in invisible markers (ESC[200~ … ESC[201~); drop those
          // and any other control characters so only what was copied is left.
          return resolve(answer.replace(/\x1b\[[0-9;]*[~A-Za-z]/g, "").replace(/[\x00-\x1f\x7f]/g, "").trim());
        }
        if (char === "\u0003") process.exit(1); // Ctrl-C
        if (char === "\u007f" || char === "\b") answer = answer.slice(0, -1);
        else answer += char;
        if (!hidden) process.stdout.write(char);
      }
    };
    input.on("data", onData);
  });
}

/** Sets or replaces KEY=value lines in an env file, leaving everything else alone. */
export function writeEnv(file, values) {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
}

/**
 * On a Mac: "copy it, then press return here", and the value is read from the clipboard,
 * so nothing is pasted into the terminal at all. Elsewhere it falls back to a hidden paste.
 */
export async function askFromClipboard(label) {
  if (process.platform !== "darwin") return ask(`  ${label} (hidden): `, { hidden: true });
  await ask(`  Copy the ${label}, then press return here… `, { hidden: true });
  return execFileSync("pbpaste", { encoding: "utf8" }).replace(/[\x00-\x1f\x7f]/g, "").trim();
}
