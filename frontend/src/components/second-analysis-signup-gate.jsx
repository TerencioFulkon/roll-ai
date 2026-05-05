import { useState } from "react";
import { claimSessionJobs } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

/**
 * @param {object} props
 * @param {string | null} props.sessionId
 * @param {string} props.pendingJobId
 * @param {(targetJobId: string) => void | Promise<void>} props.onSuccess
 */
export function SecondAnalysisSignupGate({ sessionId, pendingJobId, onSuccess }) {
  const { signUpWithPassword } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const inputClass =
    "h-auto min-h-[52px] w-full rounded-lg border-border bg-[var(--rollai-input-surface)] px-4 py-3 text-base text-foreground shadow-sm";

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setInfo("");

    if (!sessionId) {
      setError("Session could not be restored. Refresh and try again.");
      return;
    }

    if (!email.trim() || !password) {
      setError("Enter an email and password.");
      return;
    }

    if (password.length < 8) {
      setError("Use at least 8 characters for your password.");
      return;
    }

    setBusy(true);
    try {
      const { data, error: signErr } = await signUpWithPassword(email.trim(), password);
      if (signErr) {
        setError(signErr.message);
        return;
      }

      if (!data.session?.access_token) {
        setInfo(
          "Check your email to confirm your account. After confirming, open RollAI again — your analyses will be waiting."
        );
        return;
      }

      await claimSessionJobs(sessionId);
      await onSuccess(pendingJobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-[70dvh] flex-col justify-center px-6 py-10 md:mx-auto md:max-w-md">
      <div className="flex flex-col gap-3 text-center">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          Your second analysis is ready
        </h2>
        <p className="text-base leading-relaxed text-muted-foreground">
          Create a free account to watch it and save your rolls.
        </p>
      </div>

      <form className="mt-8 flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        {error ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {info ? (
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            {info}
          </p>
        ) : null}

        <div className="flex flex-col gap-2 text-left">
          <label htmlFor="gate-email" className="rollai-label">
            Email
          </label>
          <Input
            id="gate-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(ev) => setEmail(ev.target.value)}
            className={cn(inputClass)}
            disabled={busy}
          />
        </div>
        <div className="flex flex-col gap-2 text-left">
          <label htmlFor="gate-password" className="rollai-label">
            Password
          </label>
          <Input
            id="gate-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(ev) => setPassword(ev.target.value)}
            className={cn(inputClass)}
            disabled={busy}
          />
        </div>

        <Button
          type="submit"
          disabled={busy}
          className="h-auto w-full rounded-lg bg-primary py-3 text-base font-semibold text-primary-foreground shadow-sm"
        >
          {busy ? "Creating account…" : "Create free account"}
        </Button>

        <p className="text-center text-sm text-muted-foreground">Your first analysis will be saved too.</p>
      </form>
    </div>
  );
}
