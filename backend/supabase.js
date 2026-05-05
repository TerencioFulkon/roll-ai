import { createClient } from "@supabase/supabase-js";
import { config } from "./config/index.js";

export const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY);
