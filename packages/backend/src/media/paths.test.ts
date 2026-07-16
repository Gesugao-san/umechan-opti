import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildMediaFileName,
  buildPublicMediaUrl,
  buildRelativePath,
  hash8,
  isSafeFilename,
  parseFilenameFromUrl,
  sanitizeFileName,
} from "./paths";

describe("media/paths", () => {
  it("parses filename and extension from URL", () => {
    const parsed = parseFilenameFromUrl("https://example.com/files/photo%20shot.jpg");
    assert.equal(parsed.name, "photo_shot");
    assert.equal(parsed.extension, "jpg");
  });

  it("builds deterministic hash8", () => {
    const first = hash8("https://example.com/a.jpg");
    const second = hash8("https://example.com/a.jpg");
    assert.equal(first, second);
    assert.equal(first.length, 8);
  });

  it("sanitizes unsafe filename characters", () => {
    assert.equal(sanitizeFileName("../evil/name"), "_evil_name");
  });

  it("builds media file name with hash", () => {
    const fileName = buildMediaFileName({
      postId: 42,
      fileType: "image",
      sourceUrl: "https://example.com/cat.png",
    });
    assert.match(fileName, /^42_image_[a-f0-9]{8}_cat\.png$/);
  });

  it("builds relative and public paths", () => {
    const relative = buildRelativePath(10, "42_image_abcd1234_cat.png");
    assert.equal(relative, "media-data/10/42_image_abcd1234_cat.png");

    process.env.API_PUBLIC_BASE_URL = "http://localhost:3000/api";
    const publicUrl = buildPublicMediaUrl(relative);
    assert.equal(
      publicUrl,
      "http://localhost:3000/api/v2/media/10/42_image_abcd1234_cat.png",
    );
  });

  it("validates safe filenames", () => {
    assert.equal(isSafeFilename("42_image_abcd1234_cat.png"), true);
    assert.equal(isSafeFilename("../passwd"), false);
    assert.equal(isSafeFilename("a/b"), false);
  });
});
