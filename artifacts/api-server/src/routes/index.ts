import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import jobsRouter from "./jobs.js";
import daemonRouter from "./daemon.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(jobsRouter);
// Standalone (unbound) Daemon endpoint — used by the splash widget so
// visitors can chat with the Daemon (with voice playback + sentence bar)
// before any relic has been sealed.
router.use(daemonRouter);

export default router;
