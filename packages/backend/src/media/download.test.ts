import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

describe("media/download", () => {
  let tempDir = "";
  let downloadToAbsolutePath: typeof import("./download").downloadToAbsolutePath;
  const originalFetch = global.fetch;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "umechan-download-test-"));
    process.env.MEDIA_DOWNLOAD_MAX_RETRIES = "3";
    process.env.MEDIA_DOWNLOAD_RETRY_DELAY_MS = "1";
    process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = "5000";
    ({ downloadToAbsolutePath } = await import("./download"));
  });

  after(() => {
    global.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns false on 404 without retries", async () => {
    let calls = 0;
    global.fetch = (async () => {
      calls += 1;
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const target = path.join(tempDir, "missing.jpg");
    const ok = await downloadToAbsolutePath("https://example.com/missing.jpg", target);
    assert.equal(ok, false);
    assert.equal(calls, 1);
  });

  it("retries on 500 and succeeds", async () => {
    let calls = 0;
    global.fetch = (async () => {
      calls += 1;
      if (calls < 3) {
        return new Response(null, { status: 500 });
      }
      const body = Readable.toWeb(Readable.from([Buffer.from("ok")])) as ReadableStream;
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const target = path.join(tempDir, "retry.jpg");
    const ok = await downloadToAbsolutePath("https://example.com/retry.jpg", target);
    assert.equal(ok, true);
    assert.equal(calls, 3);
    assert.equal(fs.readFileSync(target, "utf8"), "ok");
  });
});
