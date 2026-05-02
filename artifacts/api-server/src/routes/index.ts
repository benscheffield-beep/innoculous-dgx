import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import jobsRouter from "./jobs.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(jobsRouter);

export default router;
