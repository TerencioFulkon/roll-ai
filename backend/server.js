import "./env.js";

import cors from "cors";
import express from "express";
import { config } from "./config/index.js";
import { logVisionProviderBootstrap } from "./lib/logVisionBootstrap.js";
import { optionalAuth, requireAuth } from "./middleware/auth.js";
import uploadRouter from "./routes/upload.js";
import sessionsRouter from "./routes/sessions.js";
import statusRouter from "./routes/status.js";
import voicesRouter from "./routes/voices.js";
import adminRouter from "./routes/admin.js";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/** Legacy paths — same handlers as /api/*; optionalAuth preserves anonymous uploads/status. */
app.use("/upload", optionalAuth, uploadRouter);
app.use("/status", optionalAuth, statusRouter);

app.use("/api/upload", optionalAuth, uploadRouter);
app.use("/api/sessions", optionalAuth, sessionsRouter);
app.use("/api/jobs", optionalAuth, statusRouter);

app.use("/api/voices", voicesRouter);
app.use("/api/admin", requireAuth, adminRouter);

app.listen(config.PORT, () => {
  logVisionProviderBootstrap("api");
  console.log(`Backend listening on port ${config.PORT}`);
});
