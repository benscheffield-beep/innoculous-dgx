import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import app from "../app.js";

vi.mock("../workers/pipeline.js", () => ({
  runPipeline: vi.fn().mockResolvedValue(undefined),
  retryPipeline: vi.fn().mockResolvedValue(undefined),
}));

const VALID_CREATE_BODY = {
  kernel: { type: "gaussian", sigma: 1.0 },
  Q: [[1, 0], [0, 1]],
  truncation: { M: 2, r: 3 },
  latency: { lambda: 0.5, delta: 0.1, Tnow: 0 },
  precision: { b: 53, tol: 1e-6 },
};

describe("GET /api/healthz", () => {
  it("returns 200 with status ok", async () => {
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});

describe("POST /api/jobs – validation", () => {
  it("rejects missing kernel", async () => {
    const res = await request(app)
      .post("/api/jobs")
      .send({ Q: [[1, 0], [0, 1]], truncation: { M: 2, r: 3 }, latency: { lambda: 0.5, delta: 0.1, Tnow: 0 }, precision: { b: 53, tol: 1e-6 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  it("rejects invalid kernel type", async () => {
    const res = await request(app)
      .post("/api/jobs")
      .send({ ...VALID_CREATE_BODY, kernel: { type: "invalid_kernel" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  it("rejects missing Q matrix", async () => {
    const res = await request(app)
      .post("/api/jobs")
      .send({ ...VALID_CREATE_BODY, Q: undefined });
    expect(res.status).toBe(400);
  });

  it("rejects missing truncation", async () => {
    const res = await request(app)
      .post("/api/jobs")
      .send({ ...VALID_CREATE_BODY, truncation: undefined });
    expect(res.status).toBe(400);
  });

  it("rejects negative sigma", async () => {
    const res = await request(app)
      .post("/api/jobs")
      .send({ ...VALID_CREATE_BODY, kernel: { type: "gaussian", sigma: -1 } });
    expect(res.status).toBe(400);
  });

  it("rejects invalid latency (negative lambda)", async () => {
    const res = await request(app)
      .post("/api/jobs")
      .send({ ...VALID_CREATE_BODY, latency: { lambda: -0.5, delta: 0.1, Tnow: 0 } });
    expect(res.status).toBe(400);
  });

  it("rejects empty body", async () => {
    const res = await request(app).post("/api/jobs").send({});
    expect(res.status).toBe(400);
  });

  it("rejects non-numeric tol", async () => {
    const res = await request(app)
      .post("/api/jobs")
      .send({ ...VALID_CREATE_BODY, precision: { b: 53, tol: "not-a-number" } });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/jobs – success & idempotency", () => {
  it("creates a job and returns 201", async () => {
    const res = await request(app).post("/api/jobs").send(VALID_CREATE_BODY);
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.status).toBe("queued");
    expect(res.body.kernel_params).toBeTruthy();
    expect(res.body.retry_count).toBe(0);
    expect(res.body.created_at).toBeTruthy();
  });

  it("is idempotent when job_id is supplied", async () => {
    const { runPipeline } = await import("../workers/pipeline.js");
    const job_id = "550e8400-e29b-41d4-a716-446655440000";

    const res1 = await request(app).post("/api/jobs").send({ ...VALID_CREATE_BODY, job_id });
    const res2 = await request(app).post("/api/jobs").send({ ...VALID_CREATE_BODY, job_id });

    expect([200, 201]).toContain(res1.status);
    expect(res2.status).toBe(200);
    expect(res1.body.id).toBe(res2.body.id);
    expect(vi.mocked(runPipeline)).toHaveBeenCalledWith(job_id);
  });

  it("creates distinct jobs when no job_id is provided", async () => {
    const [res1, res2] = await Promise.all([
      request(app).post("/api/jobs").send(VALID_CREATE_BODY),
      request(app).post("/api/jobs").send(VALID_CREATE_BODY),
    ]);
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res1.body.id).not.toBe(res2.body.id);
  });

  it("accepts mellin kernel type", async () => {
    const res = await request(app)
      .post("/api/jobs")
      .send({ ...VALID_CREATE_BODY, kernel: { type: "mellin", alpha: 0.5 } });
    expect(res.status).toBe(201);
    expect(res.body.kernel_params.kernel.type).toBe("mellin");
  });

  it("stores policy_config when provided", async () => {
    const policy = { spectral_radius_max: 0.95, cond_limit: 1e5 };
    const res = await request(app)
      .post("/api/jobs")
      .send({ ...VALID_CREATE_BODY, policy_config: policy });
    expect(res.status).toBe(201);
    expect(res.body.policy_config.spectral_radius_max).toBe(0.95);
  });
});

describe("GET /api/jobs – listing", () => {
  it("returns 200 with jobs array and pagination", async () => {
    const res = await request(app).get("/api/jobs");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.jobs)).toBe(true);
    expect(typeof res.body.total).toBe("number");
    expect(typeof res.body.page).toBe("number");
    expect(typeof res.body.page_size).toBe("number");
  });

  it("respects page_size parameter", async () => {
    const res = await request(app).get("/api/jobs?page_size=2");
    expect(res.status).toBe(200);
    expect(res.body.jobs.length).toBeLessThanOrEqual(2);
    expect(res.body.page_size).toBe(2);
  });

  it("returns page 1 with default page_size when params are omitted", async () => {
    const res = await request(app).get("/api/jobs");
    expect(res.body.page).toBe(1);
    expect(res.body.page_size).toBe(20);
  });
});

describe("GET /api/jobs/:id", () => {
  it("returns 404 for unknown id", async () => {
    const res = await request(app).get("/api/jobs/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns job detail for known id", async () => {
    const create = await request(app).post("/api/jobs").send(VALID_CREATE_BODY);
    expect(create.status).toBe(201);
    const res = await request(app).get(`/api/jobs/${create.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(create.body.id);
    expect(res.body.status).toBeTruthy();
  });
});

describe("PATCH /api/jobs/:id/status", () => {
  it("returns 404 for unknown job", async () => {
    const res = await request(app)
      .patch("/api/jobs/00000000-0000-0000-0000-000000000000/status")
      .send({ status: "failed" });
    expect(res.status).toBe(404);
  });

  it("updates status for existing job", async () => {
    const create = await request(app).post("/api/jobs").send(VALID_CREATE_BODY);
    const res = await request(app)
      .patch(`/api/jobs/${create.body.id}/status`)
      .send({ status: "editor_running" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("editor_running");
  });

  it("rejects missing status field", async () => {
    const create = await request(app).post("/api/jobs").send(VALID_CREATE_BODY);
    const res = await request(app)
      .patch(`/api/jobs/${create.body.id}/status`)
      .send({ step: "some_step" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/jobs/:id/work + /verify + /verdict", () => {
  it("POST /work returns 202 for existing job", async () => {
    const create = await request(app).post("/api/jobs").send(VALID_CREATE_BODY);
    const res = await request(app)
      .post(`/api/jobs/${create.body.id}/work`)
      .send({ kernel: VALID_CREATE_BODY.kernel, Q: VALID_CREATE_BODY.Q, truncation: VALID_CREATE_BODY.truncation });
    expect(res.status).toBe(202);
  });

  it("POST /verify returns 202 for existing job", async () => {
    const create = await request(app).post("/api/jobs").send(VALID_CREATE_BODY);
    const res = await request(app)
      .post(`/api/jobs/${create.body.id}/verify`)
      .send({ artifact_id: "00000000-0000-0000-0000-000000000001" });
    expect(res.status).toBe(202);
  });

  it("POST /verdict updates job status to complete on pass", async () => {
    const create = await request(app).post("/api/jobs").send(VALID_CREATE_BODY);
    const res = await request(app)
      .post(`/api/jobs/${create.body.id}/verdict`)
      .send({
        verdict: "pass",
        issues: [],
        recomputed_metrics: { spectral_radius: 0.5, cond_number: 2.0, dual_error_estimate: 0, spectral_tail_estimate: 0 },
        signed_proof: "a".repeat(64),
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("complete");
  });

  it("POST /verdict updates job status to failed on fail", async () => {
    const create = await request(app).post("/api/jobs").send(VALID_CREATE_BODY);
    const res = await request(app)
      .post(`/api/jobs/${create.body.id}/verdict`)
      .send({
        verdict: "fail",
        issues: [{ check_id: "CHK02", severity: "fail", message: "spectral radius too high", remediation: "apply_damping_to_G_off" }],
        recomputed_metrics: {},
        signed_proof: "b".repeat(64),
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
  });

  it("POST /verdict with warn maps to complete_with_warnings", async () => {
    const create = await request(app).post("/api/jobs").send(VALID_CREATE_BODY);
    const res = await request(app)
      .post(`/api/jobs/${create.body.id}/verdict`)
      .send({
        verdict: "warn",
        issues: [{ check_id: "CHK03", severity: "warn", message: "high cond", remediation: "recommend_increase_b" }],
        recomputed_metrics: {},
        signed_proof: "c".repeat(64),
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("complete_with_warnings");
  });
});

describe("Fuzz tests – adversarial inputs", () => {
  const fuzzCases = [
    {},
    null,
    "not-an-object",
    42,
    [],
    { kernel: null },
    { kernel: { type: "gaussian" }, Q: "not-a-matrix" },
    { kernel: { type: "gaussian" }, Q: [[1, 0], [0, 1]], truncation: { M: -1, r: 3 } },
    { kernel: { type: "gaussian" }, Q: [[1, 0], [0, 1]], truncation: { M: 2, r: 0 } },
    { ...VALID_CREATE_BODY, precision: { b: 0, tol: -1 } },
    { ...VALID_CREATE_BODY, latency: { lambda: 0, delta: 0.1, Tnow: 0 } },
    { ...VALID_CREATE_BODY, job_id: "not-a-uuid" },
  ];

  for (const [idx, body] of fuzzCases.entries()) {
    it(`rejects malformed input #${idx}`, async () => {
      const res = await request(app).post("/api/jobs").send(body as object);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  }
});
