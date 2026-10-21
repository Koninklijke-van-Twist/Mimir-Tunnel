import assert from "node:assert/strict";
import test from "node:test";
import { stripPackageManifest } from "../scripts/install-bc-mcp.mjs";

test("workaround haalt lockfile-bronnen uit het manifest: devDependencies en scripts", () => {
  const stripped = stripPackageManifest({
    name: "business-central-mcp",
    version: "2.2.0",
    scripts: { test: "vitest", prepublishOnly: "tsc" },
    dependencies: { zod: "^4.3.6" },
    devDependencies: { vitest: "^4.1.2", typescript: "^6.0.2" },
  });
  assert.equal(stripped.devDependencies, undefined);
  assert.equal(stripped.scripts, undefined);
  assert.equal(stripped.dependencies.zod, "^4.3.6");
  assert.equal(stripped.version, "2.2.0");
});
