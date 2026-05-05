import { supabase } from "../supabase.js";

/**
 * Requires a valid Bearer JWT. Uses the existing service-role Supabase client — no anon client.
 */
export async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      console.log("[auth] anonymous request");
      return res.status(401).json({ error: "Unauthorised" });
    }

    const {
      data: { user },
      error
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      console.log("[auth] anonymous request");
      return res.status(401).json({ error: "Unauthorised" });
    }

    req.user = user;
    console.log(`[auth] authenticated: user_id=${user.id}`);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Attaches req.user when Bearer token is valid; otherwise req.user = null and continues.
 * Anonymous uploads and status checks remain allowed.
 */
export async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      req.user = null;
      console.log("[auth] anonymous request");
      return next();
    }

    const {
      data: { user },
      error
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      req.user = null;
      console.log("[auth] anonymous request");
      return next();
    }

    req.user = user;
    console.log(`[auth] authenticated: user_id=${user.id}`);
    next();
  } catch (err) {
    next(err);
  }
}
