import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(
  new URL("../scripts/configure-token-capacity.mjs", import.meta.url),
);

test("capacity helper preserves comments and unrelated credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-capacity-test-"));
  const envPath = join(directory, "custom.env");
  try {
    const original = [
      "# private provider credentials",
      "KIMI_CODE_API_KEY=synthetic-secret",
      "USAGE_HUB_KIMI_WEEKLY_TOKEN_CAPACITY=5000000",
      "USAGE_HUB_CLOUD_URL=https://example.test/",
      "",
    ].join("\n");
    await writeFile(envPath, original, "utf8");

    await execFileAsync(
      process.execPath,
      [scriptPath, "kimi", "10000000"],
      {
        env: {
          ...process.env,
          USAGE_HUB_ENV_FILE: envPath,
        },
      },
    );
    const configured = await readFile(envPath, "utf8");
    assert.match(configured, /^# private provider credentials$/m);
    assert.match(configured, /^KIMI_CODE_API_KEY=synthetic-secret$/m);
    assert.match(configured, /^USAGE_HUB_CLOUD_URL=https:\/\/example\.test\/$/m);
    assert.equal(
      configured.match(/^USAGE_HUB_KIMI_WEEKLY_TOKEN_CAPACITY=/gm)?.length,
      1,
    );
    assert.match(
      configured,
      /^USAGE_HUB_KIMI_WEEKLY_TOKEN_CAPACITY=10000000$/m,
    );

    await execFileAsync(
      process.execPath,
      [scriptPath, "kimi", "clear"],
      {
        env: {
          ...process.env,
          USAGE_HUB_ENV_FILE: envPath,
        },
      },
    );
    const cleared = await readFile(envPath, "utf8");
    assert.doesNotMatch(
      cleared,
      /^USAGE_HUB_KIMI_WEEKLY_TOKEN_CAPACITY=/m,
    );
    assert.match(cleared, /^KIMI_CODE_API_KEY=synthetic-secret$/m);
  } finally {
    await rm(directory, { recursive: true });
  }
});
