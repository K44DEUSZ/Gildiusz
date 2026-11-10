import { setInterval } from "node:timers";
const mode = process.argv[2];
if (mode === "hold") {
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else if (mode === "stderr") {
  process.stderr.write(Buffer.alloc(70000, 65));
  process.stdin.resume();
} else if (mode === "flood") {
  process.stdout.write(Buffer.alloc(500000, 65));
  process.stdin.resume();
} else {
  process.stdin.on("data", () => {
    process.stdout.write(Buffer.from("packet"));
  });
  process.stdin.on("end", () => {
    process.stdout.end();
  });
}
