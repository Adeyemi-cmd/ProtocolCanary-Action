import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureCanaryInstalled } from "../../src/canary";
import { InstallationFailedError } from "../../src/errors";
import { ResolvedVersion } from "../../src/version";

const { isFeatureAvailableMock, restoreCacheMock } = vi.hoisted(() => ({
  isFeatureAvailableMock: vi.fn(),
  restoreCacheMock: vi.fn(),
}));

// The cache client is stubbed out so no test in this file can reach the
// GitHub cache service: restoreFromCache/saveToCache become inert no-ops.
// This keeps every code path (including the cargo-unavailable one) offline
// and deterministic even on GitHub-hosted runners, where the Actions cache
// feature would otherwise be available.
vi.mock("@actions/cache", () => ({
  isFeatureAvailable: isFeatureAvailableMock,
  restoreCache: restoreCacheMock,
  saveCache: vi.fn(),
}));

const MOCK_CANARY_SOURCE = path.join(__dirname, "..", "fixtures", "mock-canary.cjs");

describe("ensureCanaryInstalled", () => {
  let tempCargoHome: string;
  let originalCargoHome: string | undefined;

  beforeEach(() => {
    tempCargoHome = fs.mkdtempSync(path.join(os.tmpdir(), "canary-cargo-home-"));
    fs.mkdirSync(path.join(tempCargoHome, "bin"), { recursive: true });
    originalCargoHome = process.env.CARGO_HOME;
    process.env.CARGO_HOME = tempCargoHome;
    process.env.MOCK_CANARY_VERSION = "0.1.0";
    isFeatureAvailableMock.mockReturnValue(false);
    restoreCacheMock.mockClear();
  });

  afterEach(() => {
    if (originalCargoHome === undefined) {
      delete process.env.CARGO_HOME;
    } else {
      process.env.CARGO_HOME = originalCargoHome;
    }
    delete process.env.MOCK_CANARY_VERSION;
    fs.rmSync(tempCargoHome, { recursive: true, force: true });
  });

  it("uses an already-installed binary when its version matches, without installing anything", async () => {
    const binaryPath = path.join(tempCargoHome, "bin", "stellar-canary");
    fs.copyFileSync(MOCK_CANARY_SOURCE, binaryPath);
    fs.chmodSync(binaryPath, 0o755);

    const resolved: ResolvedVersion = { version: "0.1.0", tag: "v0.1.0", commitSha: "abc123" };
    const installed = await ensureCanaryInstalled(resolved);

    expect(installed.binaryPath).toBe(binaryPath);
    expect(installed.version).toBe("0.1.0");
  });

  it("does not reuse an already-installed binary with a different version", async () => {
    const binaryPath = path.join(tempCargoHome, "bin", "stellar-canary");
    fs.copyFileSync(MOCK_CANARY_SOURCE, binaryPath);
    fs.chmodSync(binaryPath, 0o755);
    process.env.MOCK_CANARY_VERSION = "0.0.9";

    // A version mismatch falls through to cache-then-cargo-install, which
    // this offline test cannot complete — asserting the rejection is
    // enough to prove the stale binary was correctly rejected rather than
    // silently reused.
    const resolved: ResolvedVersion = { version: "0.1.0", tag: "v0.1.0", commitSha: "abc123" };
    await expect(ensureCanaryInstalled(resolved)).rejects.toThrow();
  }, 30_000);

  it("rejects with InstallationFailedError when cargo is unavailable", async () => {
    // Simulate a runner with no Rust toolchain: CARGO_HOME already points
    // at the empty temp dir from beforeEach, PATH is scrubbed of every
    // directory that could resolve a `cargo` binary, and the cache client
    // is stubbed off (see the vi.mock above) so restoreFromCache can neither
    // reach the cache service nor short-circuit with a hit, even on
    // GitHub-hosted runners. `@actions/exec` looks up the command with
    // `io.which(..., true)`, so the very first `cargo --version` probe
    // rejects before any network call is attempted.
    const originalPath = process.env.PATH;
    const originalPathExt = process.env.PATHEXT;
    process.env.PATH = tempCargoHome;
    delete process.env.PATHEXT;

    try {
      const resolved: ResolvedVersion = { version: "0.1.0", tag: "v0.1.0", commitSha: "abc123" };
      try {
        await ensureCanaryInstalled(resolved);
        expect.unreachable("ensureCanaryInstalled should have rejected when cargo is unavailable");
      } catch (error) {
        expect(error).toBeInstanceOf(InstallationFailedError);
        expect((error as InstallationFailedError).code).toBe("InstallationFailed");

        // The whole point of this error message is to tell a self-hosted
        // or non-Ubuntu runner operator exactly what to install.
        const message = (error as InstallationFailedError).message;
        expect(message).toContain("The `cargo` command was not found on this runner");
        expect(message).toContain("dtolnay/rust-toolchain");
      }

      // Guard the offline guarantee: with the cache client stubbed out, the
      // cache path must never run, let alone short-circuit this failure.
      expect(restoreCacheMock).not.toHaveBeenCalled();
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalPathExt === undefined) {
        delete process.env.PATHEXT;
      } else {
        process.env.PATHEXT = originalPathExt;
      }
    }
  });
});
