/**
 * Interactive terminal prompt for the install CLIs (plain or hidden input).
 * Hidden mode reads raw stdin so passwords are not echoed.
 */

import { createInterface } from "node:readline";

export function prompt(question: string, hidden = false): Promise<string> {
  return new Promise((resolveFn) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    if (hidden) {
      process.stdout.write(question);
      process.stdin.setRawMode?.(true);
      let value = "";
      process.stdin.resume();
      process.stdin.setEncoding("utf8");

      const onData = (char: string) => {
        if (char === "\n" || char === "\r" || char === "") {
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          rl.close();
          resolveFn(value);
        } else if (char === "" || char === "\b") {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      };
      process.stdin.on("data", onData);
    } else {
      rl.question(question, (answer: string) => {
        rl.close();
        resolveFn(answer);
      });
    }
  });
}
