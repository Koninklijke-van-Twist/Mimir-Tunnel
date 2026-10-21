import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const TOKEN = "test-token-value-123456";
const GIT_TOKEN = "from-git-should-not-win-xxxx";
const script = new URL("../scripts/update.sh", import.meta.url);

function shQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

function git(cwd, args) {
  const result = run("git", args, { cwd });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  }
  return result;
}

function bashOk(scriptText, path) {
  writeFileSync(path, scriptText);
  chmodSync(path, 0o755);
}

function startHealth(portFile) {
  const child = spawn(process.execPath, ["-e", `
    const http = require("http");
    const fs = require("fs");
    const token = process.env.TOKEN;
    const server = http.createServer((req, res) => {
      const ok = req.url.split("?")[0] === "/health"
        && req.headers.authorization === "Bearer " + token;
      res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
      res.end(ok ? '{"ok":true}' : '{"ok":false}');
    });
    server.listen(0, "127.0.0.1", () => {
      fs.writeFileSync(process.env.PORTFILE, String(server.address().port));
    });
  `], {
    env: { ...process.env, TOKEN, PORTFILE: portFile },
    stdio: "ignore",
  });
  return child;
}

async function waitForPort(portFile) {
  for (let i = 0; i < 50; i += 1) {
    if (existsSync(portFile)) {
      const port = readFileSync(portFile, "utf8").trim();
      if (port) return port;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("health-server gaf geen poort");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mimir-update-"));
  const origin = join(root, "origin.git");
  const src = join(root, "src");
  const dest = join(root, "dest");
  const bin = join(root, "bin");
  const backups = join(root, "backups");
  const log = join(root, "systemctl.log");
  const npmLog = join(root, "npm.log");
  mkdirSync(bin);
  writeFileSync(log, "");
  chmodSync(log, 0o666);
  writeFileSync(npmLog, "");
  chmodSync(npmLog, 0o666);
  bashOk(`#!/bin/bash
printf '%s\\n' "$*" >> ${shQuote(log)}
exit 0
`, join(bin, "systemctl"));
  bashOk(`#!/bin/bash
printf '%s\\n' "$*" >> ${shQuote(npmLog)}
mkdir -p node_modules
echo from-npm > node_modules/from-npm
exit 0
`, join(bin, "npm"));
  run("git", ["init", "--bare", "-b", "master", origin]);
  run("git", ["clone", origin, src]);
  git(src, ["config", "user.email", "test@example.com"]);
  git(src, ["config", "user.name", "Test"]);
  git(src, ["config", "core.autocrlf", "false"]);
  const pkg = '{"name":"fixture","version":"1.0.0"}\n';
  const lock = '{"name":"fixture","lockfileVersion":3,"packages":{}}\n';
  writeFileSync(join(src, "marker"), "from-master\n");
  writeFileSync(join(src, "package.json"), pkg);
  writeFileSync(join(src, "package-lock.json"), lock);
  writeFileSync(join(src, ".env.example"), "example\n");
  writeFileSync(join(src, ".env"), `TUNNEL_TOKEN=${GIT_TOKEN}\nTUNNEL_PORT=1\n`);
  git(src, ["add", "marker", "package.json", "package-lock.json", ".env.example", ".env"]);
  git(src, ["commit", "-m", "master"]);
  git(src, ["push", "-u", "origin", "master"]);
  git(src, ["checkout", "-b", "main"]);
  writeFileSync(join(src, "marker"), "from-main\n");
  git(src, ["commit", "-am", "main"]);
  git(src, ["push", "-u", "origin", "main"]);
  git(src, ["checkout", "master"]);
  mkdirSync(join(dest, "node_modules"), { recursive: true });
  writeFileSync(join(dest, "marker"), "old\n");
  writeFileSync(join(dest, "package.json"), pkg);
  writeFileSync(join(dest, "package-lock.json"), lock);
  writeFileSync(join(dest, "node_modules", "keep"), "keep\n");
  return { root, src, dest, bin, backups, log, npmLog, pkg, lock };
}

function writeEnv(dest, port) {
  writeFileSync(join(dest, ".env"), `# comment\nTUNNEL_TOKEN=${TOKEN}\nTUNNEL_PORT=${port}\n`);
}

function runUpdate(fx, args = [], extra = {}) {
  const env = {
    PATH: `${extra.npm === false ? "" : ""}${fx.bin}:${process.env.PATH}`,
    MIMIR_SRC: fx.src,
    MIMIR_DEST: fx.dest,
    MIMIR_USER: "ubuntu",
    MIMIR_GROUP: "ubuntu",
    MIMIR_SERVICE: "mimir-bc-bridge-test",
    MIMIR_BACKUP_DIR: fx.backups,
    MIMIR_LOCK: join(fx.root, "update.lock"),
    MIMIR_HEALTH_TRIES: extra.tries ?? "8",
    MIMIR_HEALTH_INTERVAL: extra.interval ?? "0.2",
    HOME: process.env.HOME ?? "/tmp",
  };
  if (extra.npm === false) {
    env.PATH = `${process.env.PATH}:${fx.bin}`;
    const realBin = join(fx.root, "bin-no-npm");
    mkdirSync(realBin, { recursive: true });
    bashOk(readFileSync(join(fx.bin, "systemctl"), "utf8"), join(realBin, "systemctl"));
    env.PATH = `${realBin}:${process.env.PATH}`;
  }
  const prefix = Object.entries(env).map(([key, value]) => `${key}=${shQuote(value)}`).join(" ");
  const tail = args.map(shQuote).join(" ");
  return run("sudo", ["bash", "-c", `${prefix} bash ${shQuote(script.pathname)} ${tail}`]);
}

function restarts(log) {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter((line) => line.startsWith("restart "));
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

test("update.sh weigert een aanroep zonder sudo", () => {
  const result = run("bash", [script.pathname]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /sudo/);
});

test("update.sh is geldige bash", () => {
  const result = run("bash", ["-n", script.pathname]);
  assert.equal(result.status, 0, result.stderr);
});

test("update.sh werkt een schone checkout bij en laat .env staan", async (t) => {
  const fx = fixture();
  const portFile = join(fx.root, "port");
  const server = startHealth(portFile);
  t.after(() => {
    server.kill();
    run("sudo", ["rm", "-rf", fx.root]);
  });
  const port = await waitForPort(portFile);
  writeEnv(fx.dest, port);

  const first = runUpdate(fx, [], { npm: false });
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(readFileSync(join(fx.dest, "marker"), "utf8"), "from-master\n");
  assert.equal(readFileSync(join(fx.dest, ".env"), "utf8").includes(TOKEN), true);
  assert.equal(readFileSync(join(fx.dest, ".env"), "utf8").includes(GIT_TOKEN), false);
  assert.equal(readFileSync(join(fx.dest, ".env.example"), "utf8"), "example\n");
  assert.equal(existsSync(join(fx.dest, ".git")), false);
  assert.equal(existsSync(join(fx.dest, "node_modules", "keep")), true);
  assert.equal(readFileSync(fx.npmLog, "utf8"), "");
  assert.equal(mode(join(fx.dest, ".env")), 0o600);
  assert.equal(mode(fx.dest), 0o750);
  assert.equal(statSync(fx.dest).uid, process.getuid());
  assert.equal(restarts(fx.log).length, 1);
  const saved = run("sudo", ["find", fx.backups, "-mindepth", "1", "-maxdepth", "1", "-type", "d"]);
  assert.equal(saved.status, 0, saved.stderr);
  const savedDir = saved.stdout.trim().split("\n").filter(Boolean);
  assert.equal(savedDir.length, 1);
  assert.equal(run("sudo", ["cat", join(savedDir[0], "marker")]).stdout, "old\n");
  assert.match(first.stdout, /npm install overgeslagen/);
  assert.match(first.stdout, /Healthcheck geslaagd/);
  assert.equal(first.stdout.includes(TOKEN), false);
  assert.equal(first.stderr.includes(TOKEN), false);
  assert.equal(first.stdout.includes(GIT_TOKEN), false);

  const again = runUpdate(fx, [], { npm: false });
  assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
  assert.equal(readFileSync(join(fx.dest, "marker"), "utf8"), "from-master\n");
  assert.equal(readFileSync(join(fx.dest, ".env"), "utf8").includes(TOKEN), true);
  assert.equal(restarts(fx.log).length, 2);

  const onMain = runUpdate(fx, ["main"], { npm: false });
  assert.equal(onMain.status, 0, `${onMain.stdout}\n${onMain.stderr}`);
  assert.equal(readFileSync(join(fx.dest, "marker"), "utf8"), "from-main\n");
  assert.equal(readFileSync(join(fx.dest, ".env"), "utf8").includes(TOKEN), true);
  assert.match(onMain.stdout, /branch main/);
});

test("update.sh installeert npm alleen als het lockbestand wijzigt", async (t) => {
  const fx = fixture();
  const portFile = join(fx.root, "port");
  const server = startHealth(portFile);
  t.after(() => {
    server.kill();
    run("sudo", ["rm", "-rf", fx.root]);
  });
  const port = await waitForPort(portFile);
  writeEnv(fx.dest, port);
  const prepared = runUpdate(fx, ["master"], { npm: false });
  assert.equal(prepared.status, 0, `${prepared.stdout}\n${prepared.stderr}`);

  writeFileSync(join(fx.src, "package-lock.json"), `${fx.lock.trim()}\n{"changed":true}\n`);
  git(fx.src, ["commit", "-am", "lock"]);
  git(fx.src, ["push", "origin", "master"]);
  const updated = runUpdate(fx, ["master"]);
  assert.equal(updated.status, 0, `${updated.stdout}\n${updated.stderr}`);
  assert.match(updated.stdout, /npm install --omit=dev/);
  assert.match(readFileSync(fx.npmLog, "utf8"), /install --omit=dev/);
  assert.equal(readFileSync(join(fx.dest, "node_modules", "from-npm"), "utf8").trim(), "from-npm");
  assert.equal(existsSync(join(fx.dest, "node_modules", "keep")), false);
  assert.equal(readFileSync(join(fx.dest, ".env"), "utf8").includes(TOKEN), true);
});

test("update.sh zet de backup terug als /health niet antwoordt", async (t) => {
  const fx = fixture();
  t.after(() => run("sudo", ["rm", "-rf", fx.root]));
  writeEnv(fx.dest, "39999");
  const result = runUpdate(fx, ["master"], { npm: false, tries: "2", interval: "0.1" });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(fx.dest, "marker"), "utf8"), "old\n");
  assert.equal(readFileSync(join(fx.dest, ".env"), "utf8").includes(TOKEN), true);
  assert.equal(mode(join(fx.dest, ".env")), 0o600);
  assert.match(result.stdout, /teruggezet/i);
  assert.equal(result.stdout.includes(TOKEN), false);
  assert.ok(restarts(fx.log).length >= 2);
});

test("een vieze werkboom wijzigt /opt niet", () => {
  const fx = fixture();
  try {
    writeEnv(fx.dest, "8787");
    writeFileSync(join(fx.src, "lokaal.txt"), "x\n");
    const result = runUpdate(fx, ["master"], { npm: false, tries: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /niet schoon/);
    assert.equal(readFileSync(join(fx.dest, "marker"), "utf8"), "old\n");
    assert.equal(existsSync(fx.backups), false);
    assert.equal(restarts(fx.log).length, 0);
  } finally {
    run("sudo", ["rm", "-rf", fx.root]);
  }
});
