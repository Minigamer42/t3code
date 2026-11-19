import { describe, expect, it } from "@effect/vitest";
import { ciProgressJobs } from "./ci.ts";

describe("CI progress", () => {
  it("omits skipped and unrun manual jobs while retaining jobs that ran", () => {
    const jobs = ["manual", "skipped", "pending", "running", "success", "failed", "canceled"].map(
      (status, index) => ({
        id: String(index),
        name: status,
        status,
        url: null,
        allowFailure: true,
      }),
    );
    expect(ciProgressJobs(jobs).map((job) => job.status)).toEqual([
      "pending",
      "running",
      "success",
      "failed",
      "canceled",
    ]);
  });
});
