import express from "express";
import { listVoicesForApi } from "../services/ttsService.js";

const router = express.Router();

router.get("/", (_req, res) => {
  res.json(listVoicesForApi());
});

export default router;
