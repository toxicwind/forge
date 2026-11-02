// forge overlay — live TV screen-frame PiP overlay (headed control lane).
//
// Serves the Hisense/Android TV's current frame at http://<host>:9101/screen.png
// every poll, bound 0.0.0.0 so the host LAN + flotilla PiP overlay reach it,
// while adb drives the TV headlessly. Durable: run via `forge overlay` (or a
// supervisor) — never a detached eval that dies with its kernel.
//
// Env: OVERLAY_SERIAL (adb target, default 10.0.0.225:5555), OVERLAY_PORT (9101).
import http from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const SERIAL = process.env.OVERLAY_SERIAL || "10.0.0.225:5555";
const PORT = Number(process.env.OVERLAY_PORT || 9101);
const FRAME = "/tmp/lv.png";
const POLL_MS = 1500;

function grab() {
  try { execFileSync("adb", ["-s", SERIAL, "shell", "screencap", "-p", "/sdcard/lv.png"], { stdio: "ignore", timeout: 8000 }); } catch (_) {}
  try { execFileSync("adb", ["-s", SERIAL, "pull", "/sdcard/lv.png", FRAME], { stdio: "ignore", timeout: 8000 }); } catch (_) {}
}
grab();
setInterval(grab, POLL_MS);

http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end(`<img src="/screen.png" style="width:100%"><script>setInterval(()=>{const i=document.querySelector('img');i.src='/screen.png?t='+Date.now()},800)</script>`);
    return;
  }
  res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
  res.end(existsSync(FRAME) ? readFileSync(FRAME) : Buffer.alloc(0));
}).listen(PORT, "0.0.0.0", () => console.log(`[forge overlay] live ${SERIAL} -> :${PORT}`));