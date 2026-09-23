import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

// The tests in artifact.test.ts mock DefaultArtifactClient entirely, so they
// exercise uploadReport's error handling only through artificial rejections.
// These tests drive uploadReport through the REAL @actions/artifact client
// with a report path that does not exist on disk — the failure mode most
// likely to occur in practice. That client detects the missing file while
// building its upload specification, before any network access, so the tests
// run fully offline. A syntactically valid ACTIONS_RUNTIME_TOKEN is stubbed
// as insurance so the scenario can never fail for a missing environment
// instead.
process.env.ACTIONS_RUNTIME_TOKEN = process.env.ACTIONS_RUNTIME_TOKEN ?? "stub-token";

import { uploadReport } from "../../src/artifact";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-artifact-test-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("uploadReport against a real @actions/artifact client", () => {
  it("resolves with uploaded: false (never throws) when the report file does not exist", async () => {
    const dir = makeTempDir();
    const missingReportPath = path.join(dir, "report-does-not-exist.json");

    const outcome = await uploadReport(missingReportPath);

    expect(outcome).toEqual({
      uploaded: false,
      reason: expect.stringContaining(missingReportPath),
    });
  });
});
