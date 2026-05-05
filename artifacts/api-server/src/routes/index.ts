import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import jobsRouter from "./jobs.js";
import devRouter from "./dev.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(jobsRouter);
// Dev-only endpoints (synthetic-relic minting for daemon-chat smoke testing)
// are mounted only outside production. The router itself also guards each
// handler with a 404 short-circuit on NODE_ENV=production as belt-and-braces.
if (process.env["NODE_ENV"] !== "production") {
  router.use(devRouter);
}

export default router;
