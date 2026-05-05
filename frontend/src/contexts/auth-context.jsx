import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase-client";

const AuthContext = /** @type {import("react").Context<AuthContextValue | null>} */ (createContext(null));

/**
 * @typedef {Object} AuthContextValue
 * @property {boolean} isAuthenticated
 * @property {import("@supabase/supabase-js").User | null} user
 * @property {import("@supabase/supabase-js").Session | null} session
 * @property {(email: string, password: string) => Promise<import("@supabase/supabase-js").AuthResponse>} signUpWithPassword
 * @property {() => string | null} getAccessToken
 */

export function AuthProvider({ children }) {
  const [session, setSession] = useState(/** @type {import("@supabase/supabase-js").Session | null} */ (null));

  useEffect(() => {
    if (!supabase) {
      return undefined;
    }

    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) setSession(data.session ?? null);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const signUpWithPassword = useCallback(async (email, password) => {
    if (!supabase) {
      return {
        data: { user: null, session: null },
        error: new Error("Sign up unavailable — configure VITE_SUPABASE_URL and publishable key.")
      };
    }
    return supabase.auth.signUp({ email, password });
  }, []);

  const value = useMemo(
    () => ({
      isAuthenticated: Boolean(session?.user),
      user: session?.user ?? null,
      session,
      signUpWithPassword,
      getAccessToken: () => session?.access_token ?? null
    }),
    [session, signUpWithPassword]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    return {
      isAuthenticated: false,
      user: null,
      session: null,
      signUpWithPassword: async () => ({
        data: { user: null, session: null },
        error: new Error("Auth provider missing.")
      }),
      getAccessToken: () => null
    };
  }
  return ctx;
}
