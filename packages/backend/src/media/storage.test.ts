import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deleteFile,
  ensureThreadDir,
  fileExists,
  getMediaDataRoot,
  resolveAbsolutePath,
  resolveAbsolutePathFromParts,
} from "./storage";

describe("media/storage", () => {
  let tempDir = "";

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "umechan-media-test-"));
    process.env.MEDIA_DATA_DIR = tempDir;
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves paths inside media root", () => {
    const absolute = resolveAbsolutePathFromParts(5, "test.png");
    assert.ok(absolute);
    assert.ok(absolute!.startsWith(getMediaDataRoot()));
  });

  it("rejects path traversal", () => {
    assert.equal(resolveAbsolutePath("media-data/1/../../etc/passwd"), null);
    assert.equal(resolveAbsolutePath("../secrets"), null);
  });

  it("creates thread dir and tracks files", async () => {
    await ensureThreadDir(7);
    const relative = "media-data/7/sample.bin";
    const absolute = resolveAbsolutePath(relative);
    assert.ok(absolute);
    await fs.promises.writeFile(absolute!, "data");
    assert.equal(fileExists(relative), true);
    await deleteFile(relative);
    assert.equal(fileExists(relative), false);
  });
});
