// Shared by the setup scripts: asking in the terminal and saving settings files.

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
          return resolve(answer.trim());
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
