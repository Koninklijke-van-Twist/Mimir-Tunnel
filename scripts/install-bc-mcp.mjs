#!/usr/bin/env node
/**
 * Installeert de bridge-dependencies.
 *
 * Normaal pad: `npm install` in deze repo. business-central-mcp komt dan als
 * dependency binnen en npm negeert de devDependencies van dat pakket.
 *
 * `npm i` ín de uitgepakte tarball faalt op npm 10 met
 * `Cannot read properties of null (reading 'edgesOut')` (arborist, via de
 * devDependency-boom van vitest). Dit script valt daarop terug: pack, haal
 * lockfile + devDependencies + scripts uit package.json, `npm i --omit=dev`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function stripPackageManifest(pkg) {
  const next = { ...pkg };
  delete next.devDependencies;
  delete next.scripts;
  return next;
}

function run(cmd, args, cwd) {
  try {
    execFileSync(cmd, args, { cwd, stdio: ["ignore", "inherit", "pipe"], encoding: "utf8" });
  } catch (err) {
    if (err.stderr) process.stderr.write(err.stderr);
    const wrapped = new Error((err.stderr || err.message || String(err)).trim());
    wrapped.cause = err;
    throw wrapped;
  }
}

function vendorInstall() {
  const work = join(tmpdir(), `bc-mcp-pack-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  run("npm", ["pack", "business-central-mcp@2.2.0"], work);
  const tarball = readdirSync(work).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack leverde geen tarball");
  const vendor = join(root, "vendor", "business-central-mcp");
  rmSync(vendor, { recursive: true, force: true });
  mkdirSync(vendor, { recursive: true });
  run("tar", ["-xzf", join(work, tarball), "-C", vendor, "--strip-components=1"], root);
  const manifestPath = join(vendor, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, `${JSON.stringify(stripPackageManifest(manifest), null, 2)}\n`);
  rmSync(join(vendor, "package-lock.json"), { force: true });
  run("npm", ["install", "--omit=dev", "--ignore-scripts"], vendor);
  if (existsSync(join(root, "node_modules", "business-central-mcp"))) {
    rmSync(join(root, "node_modules", "business-central-mcp"), { recursive: true, force: true });
  }
  run("npm", ["install", "--omit=dev", "--no-save", vendor], root);
  rmSync(work, { recursive: true, force: true });
  process.stderr.write("business-central-mcp geïnstalleerd via vendor-workaround (edgesOut).\n");
}

function main() {
  const forceVendor = process.env.BC_MCP_FORCE_VENDOR === "1";
  if (!forceVendor) {
    try {
      run("npm", ["install", "--omit=dev"], root);
      return;
    } catch (err) {
      if (!/edgesOut/.test(err.message)) throw err;
      process.stderr.write("npm install faalde met edgesOut; vendor-workaround start.\n");
    }
  }
  vendorInstall();
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
