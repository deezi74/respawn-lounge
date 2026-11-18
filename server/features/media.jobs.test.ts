import { describe, expect, it } from "vitest";
import { claimJobState, runnableJob, type Job } from "./processing";
const job: Job = {
  id: "scratch-job",
  ownerId: 1,
  resourceId: "scratch-clip",
  type: "clip",
  version: 1,
  state: "queued",
  attempts: 0,
  runAt: 1000,
  createdAt: 1000,
};
describe("durable media lease transitions", () => {
  it("claims a queued job with a token and bounded lease", () => {
    const claimed = claimJobState(job, "worker-a", 1000);
    expect(claimed).toMatchObject({
      state: "running",
      attempts: 1,
      token: "worker-a",
      leaseUntil: 91_000,
    });
    expect(() => claimJobState(claimed, "worker-b", 1001)).toThrow(
      "already claimed"
    );
  });
  it("resumes the same persisted job after a process crash expires its lease", () => {
    const beforeCrash = claimJobState(job, "old-process", 1000);
    const persisted = JSON.parse(JSON.stringify(beforeCrash)) as Job;
    expect(runnableJob(persisted, 91_001)).toBe(true);
    const recovered = claimJobState(persisted, "new-process", 91_001);
    expect(recovered).toMatchObject({
      id: job.id,
      resourceId: job.resourceId,
      state: "running",
      attempts: 2,
      token: "new-process",
      leaseUntil: 181_001,
    });
  });
  it("does not retry done/error jobs or queued backoff early", () => {
    for (const state of ["done", "error"] as const)
      expect(runnableJob({ ...job, state }, 2000)).toBe(false);
    expect(runnableJob({ ...job, runAt: 3000 }, 2000)).toBe(false);
  });
  it("stops crash loops after three attempts rather than consuming unlimited compute", () => {
    const recovered = claimJobState(
      { ...job, state: "running", attempts: 3, leaseUntil: 0 },
      "last-claimer",
      1000
    );
    expect(recovered.state).toBe("error");
    expect(recovered.attempts).toBe(3);
    expect(recovered.error).toContain("three interrupted attempts");
  });
});
