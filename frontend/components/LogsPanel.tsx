"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type LogEntry = {
  id: number;
  time: number;
  pod: string;
  text: string;
  kind?: "log" | "error";
  // Set on error rows only: the Problem's `title` picks the sentence and
  // `request_id` is what support looks the real reason up by. The backend
  // stopped sending the reason itself (#108).
  errorTitle?: string;
  requestId?: string;
};

// The kinds streamErrorKind() in backend/internal/api/release_logs.go can
// actually produce. Keep the two in step: a kind missing here renders the
// fallback sentence, and a kind listed here that the backend never sends is a
// dead branch and a translation nobody reads.
const KNOWN_STREAM_ERRORS = new Set(["k8s-error", "cluster-auth-denied", "rbac-denied"]);

// The kinds that can come back *before* the stream opens — every writeError in
// StreamReleaseLogs and authorizeReleaseAccess, plus the three the BFF answers
// itself when it never reaches the Go API (app/api/v1/[...path]/route.ts).
// Same rule as above: keep it in step with those call sites.
const KNOWN_OPEN_ERRORS = new Set([
  "no-pods",
  "not-found",
  "unauthenticated",
  "demo-restricted",
  "rbac-denied",
  "validation-error",
  "internal",
  "k8s-error",
]);

// Kinds a retry can actually clear: the cluster was unreachable, or kubeport
// itself stumbled. Everything else is a verdict — no pods, not yours, gone,
// signed out — and offering [Reconnect] for those is what #134 was about.
const RETRYABLE_OPEN_ERRORS = new Set(["k8s-error", "internal"]);

// EventSource.readyState. Read off the instance rather than the constructor so
// the component does not depend on statics a stub may not define.
const ES_CLOSED = 2;

type Props = {
  releaseId: string;
  instances: { name: string }[];
  // Instance pre-selected by the page (from `?instance=`), already validated
  // against `instances`. Defaults to "all".
  initialInstance?: string;
};

// "disconnected" is a stream that was dropped and can be re-opened;
// "failed" is one the server refused, with the refusal in `failure`.
type Status = "connecting" | "connected" | "disconnected" | "failed";

// The Problem the server answered with before the SSE handshake. Only `title`
// and `request_id` are kept, for the reason spelled out at the error-frame
// listener: `detail` may carry the cluster's own words (#108).
type Failure = { title?: string; requestId?: string };

const LINE_CAP = 2000;

export function LogsPanel({ releaseId, instances, initialInstance = "all" }: Props) {
  const [instance, setInstance] = useState(initialInstance);
  const [autoscroll, setAutoscroll] = useState(true);
  // Bumped by the reconnect action and folded into Stream's key, so the remount
  // closes the dead EventSource, empties the buffer and puts the status dot
  // back to "connecting" — all by construction, with no setState in an effect.
  //
  // Emptying it is the point, not a side effect (#46). The backend opens each
  // stream with PodLogOptions{Follow: true} and no SinceTime, so a reconnect
  // replays the container log from the beginning: keeping the old lines would
  // show every one of them twice, and dropping them loses nothing, because the
  // replay brings them straight back.
  const [attempt, setAttempt] = useState(0);

  return (
    <div className="flex flex-col gap-2">
      <Toolbar
        instance={instance}
        onInstanceChange={setInstance}
        instances={instances}
        autoscroll={autoscroll}
        onAutoscrollChange={setAutoscroll}
      >
        <Stream
          key={`${releaseId}:${instance}:${attempt}`}
          releaseId={releaseId}
          instance={instance}
          autoscroll={autoscroll}
          onReconnect={() => setAttempt((n) => n + 1)}
        />
      </Toolbar>
    </div>
  );
}

type ToolbarProps = {
  instance: string;
  onInstanceChange: (v: string) => void;
  instances: { name: string }[];
  autoscroll: boolean;
  onAutoscrollChange: (v: boolean) => void;
  children: React.ReactNode;
};

// Toolbar lives in the parent so toggling Auto-scroll / Instance does
// not unmount the stream (Stream uses key= to remount on releaseId or
// instance change). The "Clear" action lives inside Stream.
function Toolbar({
  instance,
  onInstanceChange,
  instances,
  autoscroll,
  onAutoscrollChange,
  children,
}: ToolbarProps) {
  const t = useTranslations("logs");
  return (
    <>
      <div className="flex items-center gap-3 text-xs">
        <Select value={instance} onValueChange={(v) => onInstanceChange(v ?? "all")}>
          <SelectTrigger className="w-52">
            {/*
              The label is passed in rather than left to Base UI to infer from
              the matching SelectItem: it cannot resolve one before the popup
              content mounts, so the closed trigger rendered the raw value "all"
              (#46). A pod name happened to survive because the value *is* the
              label.
            */}
            <SelectValue>
              {instance === "all" ? t("allInstances") : instance}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("allInstances")}</SelectItem>
            {instances.map((i) => (
              <SelectItem key={i.name} value={i.name}>
                {i.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="ml-auto inline-flex items-center gap-1">
          <Switch checked={autoscroll} onCheckedChange={onAutoscrollChange} />
          {t("autoscroll")}
        </label>
      </div>
      {children}
    </>
  );
}

type StreamProps = {
  releaseId: string;
  instance: string;
  autoscroll: boolean;
  onReconnect: () => void;
};

function Stream({ releaseId, instance, autoscroll, onReconnect }: StreamProps) {
  const t = useTranslations("logs");
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<Status>("connecting");
  const [failure, setFailure] = useState<Failure | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // Monotonic id for stable React keys. Sliced lines (LINE_CAP) keep
  // their original id, so reconciliation only re-renders the new row.
  const seqRef = useRef(0);

  useEffect(() => {
    const url = `/api/v1/releases/${releaseId}/logs?instance=${encodeURIComponent(instance)}`;
    const es = new EventSource(url);
    // Guards the probe below: it resolves after the effect may have been torn
    // down by a remount (instance change, [Reconnect]).
    const probe = new AbortController();
    let live = true;
    const append = (entry: Omit<LogEntry, "id">) => {
      seqRef.current += 1;
      const next: LogEntry = { id: seqRef.current, ...entry };
      setLines((prev) => {
        const trimmed = prev.length >= LINE_CAP ? prev.slice(-LINE_CAP + 1) : prev;
        return [...trimmed, next];
      });
    };
    es.addEventListener("log", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { time: number; pod: string; text: string };
        append({ ...data, kind: "log" });
      } catch {
        /* malformed line — drop */
      }
    });
    // Backend emits named "error" events carrying a Problem — the same schema
    // as any other error response since #82. EventSource .onerror catches
    // connection errors only, not server-sent named events.
    //
    // Only `title` and `request_id` are rendered. `detail` used to be
    // client-go's raw text, which named the apiserver's address, the namespace
    // and the pod, and this pane showed it to whoever was looking — demo
    // visitors included (#108). The backend now withholds it, and rendering it
    // here anyway would put us back where we started the next time a new kind
    // arrives.
    es.addEventListener("error", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { title?: string; request_id?: string };
        append({
          time: Date.now(),
          pod: "kubeport",
          // Text is resolved at render time, not here: this effect must not
          // depend on `t`, or switching locale would tear down the stream.
          text: "",
          kind: "error",
          errorTitle: data.title,
          requestId: data.request_id,
        });
      } catch {
        /* connection-level error — handled by onerror below */
      }
    });
    es.onopen = () => setStatus("connected");
    // Two very different failures arrive here, and WHATWG is what tells them
    // apart. A non-2xx response or a wrong MIME type "fails the connection":
    // readyState goes to CLOSED and the browser will never retry. A drop on an
    // already-open stream goes back to CONNECTING and it retries by itself.
    //
    // Only the first has a Problem waiting to be read — and EventSource does
    // not hand us the response, so the body has to be fetched. Everything the
    // endpoint refuses with (no-pods, not-found, demo-restricted, ...) used to
    // collapse into "the connection dropped, press Reconnect", which named the
    // wrong cause and pointed at a button that could not succeed (#134).
    es.onerror = () => {
      if (es.readyState !== ES_CLOSED) {
        setStatus("disconnected");
        return;
      }
      es.close();
      void readRefusal(url, probe.signal).then((refusal) => {
        if (!live) return;
        // No refusal to read means the stream would open now, or we could not
        // ask. Either way the honest offer is to let the reader try again.
        setFailure(refusal);
        setStatus(refusal ? "failed" : "disconnected");
      });
    };
    return () => {
      live = false;
      probe.abort();
      es.close();
    };
  }, [releaseId, instance]);

  useEffect(() => {
    if (!autoscroll) return;
    const el = boxRef.current;
    if (el && typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [lines, autoscroll]);

  return (
    <>
      <div className="flex items-center gap-3 text-xs">
        <ConnectionDot status={status} />
        {canReconnect(status, failure) && (
          <Button size="sm" variant="outline" onClick={onReconnect}>
            {t("reconnect")}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => setLines([])}
        >
          {t("clear")}
        </Button>
      </div>
      <div
        ref={boxRef}
        className="h-[60vh] overflow-auto rounded bg-slate-950 p-3 font-mono text-[12px] leading-relaxed text-slate-100"
      >
        {lines.length === 0 && (
          <p className={status === "failed" ? "text-red-300" : "text-slate-400"}>
            {status === "failed"
              ? openErrorText(t, failure)
              : status === "disconnected"
                ? t("emptyDisconnected")
                : t("emptyWaiting")}
          </p>
        )}
        {lines.map((l) => (
          <div
            key={l.id}
            className={`whitespace-pre ${l.kind === "error" ? "text-red-300" : ""}`}
          >
            <span className="text-slate-500">
              [{new Date(l.time).toLocaleTimeString()}]
            </span>{" "}
            <span className="text-cyan-300">[{l.pod}]</span>{" "}
            {l.kind === "error" ? streamErrorText(t, l) : l.text}
          </div>
        ))}
      </div>
    </>
  );
}

// streamErrorText turns an error frame into the sentence the user reads.
//
// The backend deliberately sends no reason (#108), so all we have is the kind
// and the request id — which is the point: the id is what an admin looks the
// real reason up by, so it belongs on screen rather than buried in devtools.
function streamErrorText(t: ReturnType<typeof useTranslations>, l: LogEntry): string {
  const key = l.errorTitle && KNOWN_STREAM_ERRORS.has(l.errorTitle) ? l.errorTitle : "unknown";
  const message = t(`error.${key}`);
  return l.requestId ? t("error.withId", { message, requestId: l.requestId }) : message;
}

// readRefusal re-asks for the stream the browser just refused, to read the
// Problem body EventSource threw away.
//
// null means "we have nothing to show": either the refusal has already cleared
// (the pod started between the two requests) or we could not ask at all
// (offline, or a body that is not the Problem we expect).
async function readRefusal(url: string, signal: AbortSignal): Promise<Failure | null> {
  try {
    const res = await fetch(url, { signal });
    if (res.ok) {
      // This is the log stream, not an error — releasing it matters, or the
      // probe holds a second stream open for as long as the tab lives.
      void res.body?.cancel();
      return null;
    }
    const problem = (await res.json()) as { title?: string; request_id?: string };
    return { title: problem.title, requestId: problem.request_id };
  } catch {
    return null;
  }
}

// openErrorText turns a pre-stream refusal into the sentence the user reads.
// Same rule as streamErrorText: our own words keyed by `title`, plus the
// request id, never the server's `detail`.
function openErrorText(
  t: ReturnType<typeof useTranslations>,
  failure: Failure | null,
): string {
  const key =
    failure?.title && KNOWN_OPEN_ERRORS.has(failure.title) ? failure.title : "unknown";
  const message = t(`error.${key}`);
  return failure?.requestId
    ? t("error.withId", { message, requestId: failure.requestId })
    : message;
}

// A refused stream only gets a [Reconnect] button when a retry could plausibly
// succeed. "No pods", "not yours" and "signed out" are verdicts, and the button
// under them was an invitation to retry forever (#134, point 3).
function canReconnect(status: Status, failure: Failure | null): boolean {
  if (status === "disconnected") return true;
  if (status !== "failed") return false;
  const title = failure?.title;
  // Only a kind we recognise as a verdict withholds the button. A kind we have
  // no mapping for is a backend that moved ahead of this file — one wasted
  // request beats stranding the reader with no way back.
  return !title || !KNOWN_OPEN_ERRORS.has(title) || RETRYABLE_OPEN_ERRORS.has(title);
}

function ConnectionDot({ status }: { status: Status }) {
  const t = useTranslations("logs.status");
  const color =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-amber-500"
        : "bg-red-500";
  const label = t(status);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${color}`} aria-hidden />
      <span>{label}</span>
    </span>
  );
}
