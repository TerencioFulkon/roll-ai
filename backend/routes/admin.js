import express from "express";
import { supabase } from "../supabase.js";

const router = express.Router();

router.get("/usage", async (_req, res) => {
  const { data, error } = await supabase.from("usage_logs").select("*").order("created_at", { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.json(data ?? []);
});

router.get("/quality", async (_req, res) => {
  const { data, error } = await supabase
    .from("quality_scores")
    .select("*, jobs(*)")
    .order("created_at", { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.json(data ?? []);
});

export default router;
