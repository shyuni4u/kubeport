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

// Of those, the ones another attempt could clear. `k8s-error` is the default
// branch of streamErrorKind — transport, a dropped apiserver connection — and
// is worth one more try. The other two are the cluster's verdict on the token
// this user is holding: nothing changes until someone edits RBAC or signs in
// again, so retrying is only load.
const RETRYABLE_STREAM_ERRORS = new Set(["k8s-error"]);

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
  "cluster-auth-denied",
  "validation-error",
  "internal",
  "k8s-error",
  "rate-limited",
]);

// Kinds a retry can actually clear. `no-pods` belongs here even though it is
// what #134 was reported against: it is an observation, not a verdict — the
// backend writes it whenever ListInstances comes back empty, which is every
// pod that is still Pending or pulling, and every Job between runs. Nothing
// re-checks on its own (the stream is closed, the browser will not retry, the
// page is a server component), so taking the button away left "deploy, open
// logs" — the demo's most-walked path — with F5 as the only way forward.
//
// The rest are verdicts: not yours, gone, signed out, the cluster refused the
// token. Those keep the button hidden, which is the half of #134 point 3 that
// still holds.
const RETRYABLE_OPEN_ERRORS = new Set([
  "k8s-error",
  "internal",
  "no-pods",
  "rate-limited",
]);

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

// "disconnected" is a stream that was dropped and can be re-opened; "failed" is
// one the server refused, with the refusal in `failure`; "ended" is one that
// ran to completion — every pod stopped emitting and the server said so.
//
// "ended" is its own state rather than a flavour of "failed" because a finished
// Job is the ordinary outcome, not a fault: reusing "failed" put a red dot and
// "Something went wrong with the log stream." over a container that had simply
// done its work.
type Status = "connecting" | "connected" | "disconnected" | "failed" | "ended";

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
  // Emptying it is the point, not a side effect (#46). A fresh EventSource
  // carries no Last-Event-ID, so the backend sends the container log from the
  // beginning: keeping the old lines would show every one of them twice, and
  // dropping them loses nothing, because the replay brings them straight back.
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
  // Set once the server has said the stream is over. Carries the last error
  // frame's kind and request id when there was one, so the Reconnect button can
  // be gated on it; an empty object means the stream simply finished.
  //
  // Separate from `failure`, which is a refusal read back off the wire before
  // the stream ever opened.
  const [terminated, setTerminated] = useState<Failure | null>(null);
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
    // The last error frame seen on this stream, if any. Read when the `end`
    // frame arrives, to say why it ended. A closure variable rather than state
    // because the two frames can land in the same task and the second must see
    // what the first wrote, not the previous render's value.
    let lastError: Failure | null = null;
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
        // Remembered, not acted on: an error frame ends one pod, not the
        // stream. With ?instance=all the handler goes on following the healthy
        // ones. The `end` frame below is what says the stream is over, and this
        // is what it will report as the reason.
        lastError = { title: data.title ?? "unknown", requestId: data.request_id };
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
    // The server saying it is done. This is the only way to know: WHATWG gives
    // EventSource no way to tell a finished stream from a dropped one, so
    // without this frame the browser reopens on its own 3s timer, forever —
    // and on `instance=all`, which has no resume point, is served the whole
    // container log every round (#157, #162).
    es.addEventListener("end", () => {
      es.close();
      setTerminated(lastError ?? {});
      // A stream that carried an error ends in failure; one that did not simply
      // finished, and calling that "failed" would be a lie about a completed Job.
      setStatus(lastError ? "failed" : "ended");
    });
    // Whether this EventSource has connected before. Every open after the first
    // is the browser reconnecting by itself after a drop.
    let opened = false;
    es.onopen = () => {
      // A new HTTP stream on the same EventSource. `lastError` belongs to the
      // stream that just ended, so carrying it over would let an old pod failure
      // describe this one: a clean finish reported as a failure, and an
      // rbac-denied that has since been granted still hiding the Reconnect
      // button.
      lastError = null;
      // On `all` the reconnect cannot resume — the backend emits no ids there
      // (one cursor cannot stand for several pods, #172) — so it replays the
      // container log from the top into a pane the browser does not clear.
      // That was #107's duplicate pile-up, and `all` is the default view, so
      // resuming only named instances left the symptom where most readers are.
      // Clearing here is the same trade the Reconnect button makes (#46): the
      // replay brings every line straight back, minus scrollback past LINE_CAP.
      // A named instance resumes instead, so its pane is kept.
      if (opened && instance === "all") setLines([]);
      opened = true;
      setStatus("connected");
    };
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
    es.onerror = (e: Event) => {
      // A server-sent `error` frame is dispatched here too — same event type,
      // so onerror and the listener above both see it — but it is not a
      // connection failure and must not be treated as one.
      //
      // Tested on the payload's type, not on the property existing: `in` walks
      // the prototype chain, so any MessageEvent passes it, `data: null`
      // included. A runtime that reports a lost connection as a MessageEvent
      // (a polyfill, a proxy shim) would then be silently swallowed here — the
      // dot would stay green over a stream that had stopped. Since `end` closes
      // the socket itself, this branch is now the only place a drop is noticed,
      // so it has to fail towards "assume it dropped".
      if (e && typeof (e as MessageEvent).data === "string") return;
      // Past this point the connection really did go. If `end` had arrived we
      // would already have closed, so anything here is a drop: let the browser
      // retry, which is what its automatic reconnect is for.
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

  // `status` is in the deps because the refusal notice is appended by a status
  // change, not by a new line — without it the one row that says why the stream
  // stopped is the one row autoscroll does not bring into view.
  useEffect(() => {
    if (!autoscroll) return;
    const el = boxRef.current;
    if (el && typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [lines, status, autoscroll]);

  // Which refusal, if any, the pane spells out under the log rows.
  //
  // A pre-stream refusal always speaks for itself. It is the newest thing that
  // happened and nothing else on screen says it — and it can arrive with an
  // older pod error still sitting in the buffer, in which case letting that row
  // stand in for it would show yesterday's cluster error to someone whose
  // session has just expired, request id and all.
  //
  // A terminal error is the other way round: the error row already printed it,
  // so repeating it in the footer reads as two separate failures. The footer
  // takes over only once that row is gone — [Clear] removes it, and so does
  // LINE_CAP after healthy pods write 2000 lines past it.
  const footer =
    status !== "failed"
      ? null
      : (failure ??
        (terminated?.title &&
        !lines.some((l) => l.kind === "error" && l.requestId === terminated.requestId)
          ? terminated
          : null));

  return (
    <>
      <div className="flex items-center gap-3 text-xs">
        <ConnectionDot status={status} />
        {canReconnect(status, failure, terminated) && (
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
        {/*
          "ended" is excluded alongside "failed": the completion notice below
          says what happened, and "No output yet" under it would contradict it.
          A pod that produced nothing at all and then finished is a real case —
          a Job that exits silently — and it reads as one sentence, not two.
        */}
        {lines.length === 0 && status !== "failed" && status !== "ended" && (
          <p className="text-slate-400">
            {status === "disconnected" ? t("emptyDisconnected") : t("emptyWaiting")}
          </p>
        )}
        {lines.map((l) => (
          <div
            key={l.id}
            className={`whitespace-pre ${l.kind === "error" ? "text-red-300" : ""}`}
          >
            {/*
              slate-400, not slate-500: the timestamp is meant to recede, but
              500 on this ground is 4.23:1 and 12px is ordinary text, so it was
              under the 4.5:1 bar (#131) — the same figure the issue read off
              live pixels. 400 is 7.66:1 and still well below the log text's
              18.40:1, which is the distinction that was wanted. Ratios are for
              Tailwind v4's OKLCH palette; LogsPanel.contrast.test.ts reads
              those values from node_modules and holds both ends.
            */}
            <span className="text-slate-400">
              [{new Date(l.time).toLocaleTimeString()}]
            </span>{" "}
            <span className="text-cyan-300">[{l.pod}]</span>{" "}
            {l.kind === "error" ? streamErrorText(t, l) : l.text}
          </div>
        ))}
        {/*
          Last row rather than an empty state: a refusal is not always the first
          thing that happens. The stream can open, buffer lines, drop, and then
          be refused on the browser's own reconnect — an expired session, a
          release someone deleted. Hanging this off "the buffer is empty" hid
          the reason in exactly that case, leaving stale logs under a bare
          "Not connected".
        */}
        {footer && (
          <p className="whitespace-pre-wrap text-red-300">{openErrorText(t, footer)}</p>
        )}
        {status === "ended" && (
          <p className="whitespace-pre-wrap text-slate-400">{t("ended")}</p>
        )}
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
function canReconnect(
  status: Status,
  failure: Failure | null,
  terminated: Failure | null,
): boolean {
  if (status === "disconnected") return true;
  // A stream that finished cleanly: the pod may run again — a CronJob will —
  // and re-opening is the only way to find out.
  if (status === "ended") return true;
  if (status !== "failed") return false;
  // A stream the server ended is judged by its own vocabulary: the kinds an
  // error frame can carry are not the kinds a pre-stream refusal can, and only
  // one of the three is worth another attempt.
  if (terminated?.title) {
    const kind = terminated.title;
    return !KNOWN_STREAM_ERRORS.has(kind) || RETRYABLE_STREAM_ERRORS.has(kind);
  }
  const title = failure?.title;
  // Only a kind we recognise as a verdict withholds the button. A kind we have
  // no mapping for is a backend that moved ahead of this file — one wasted
  // request beats stranding the reader with no way back.
  return !title || !KNOWN_OPEN_ERRORS.has(title) || RETRYABLE_OPEN_ERRORS.has(title);
}

function ConnectionDot({ status }: { status: Status }) {
  const t = useTranslations("logs.status");
  // "ended" is grey, not red: the stream finished, which is what a completed
  // Job is supposed to do. Red is reserved for something having gone wrong.
  const color =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-amber-500"
        : status === "ended"
          ? "bg-slate-400"
          : "bg-red-500";
  const label = t(status);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${color}`} aria-hidden />
      <span>{label}</span>
    </span>
  );
}
