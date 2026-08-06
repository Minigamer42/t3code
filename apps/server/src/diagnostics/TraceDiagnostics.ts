import type {
  ServerTraceDiagnosticsErrorKind,
  ServerTraceDiagnosticsFailureSummary,
  ServerTraceDiagnosticsLogEvent,
  ServerTraceDiagnosticsRecentFailure,
  ServerTraceDiagnosticsResult,
  ServerTraceDiagnosticsSpanOccurrence,
  ServerTraceDiagnosticsSpanSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

interface TraceRecordLike {
  readonly name?: unknown;
  readonly traceId?: unknown;
  readonly spanId?: unknown;
  readonly startTimeUnixNano?: unknown;
  readonly endTimeUnixNano?: unknown;
  readonly durationMs?: unknown;
  readonly exit?: unknown;
  readonly events?: unknown;
}

interface TraceEventLike {
  readonly name?: unknown;
  readonly timeUnixNano?: unknown;
  readonly attributes?: unknown;
}

export interface TraceDiagnosticsOptions {
  readonly traceFilePath: string;
  readonly maxFiles: number;
  readonly slowSpanThresholdMs?: number;
  readonly readAt?: DateTime.Utc;
}

export class TraceFileReadError extends Schema.TaggedErrorClass<TraceFileReadError>()(
  "TraceFileReadError",
  {
    traceFilePath: Schema.String,
    causeTag: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read local trace file '${this.traceFilePath}'.`;
  }
}

export class TraceDiagnostics extends Context.Service<
  TraceDiagnostics,
  {
    readonly read: (
      options: TraceDiagnosticsOptions,
    ) => Effect.Effect<ServerTraceDiagnosticsResult>;
  }
>()("t3/diagnostics/TraceDiagnostics") {}

interface TraceDiagnosticsInput {
  readonly traceFilePath: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly text: string }>;
  readonly scannedFilePaths?: ReadonlyArray<string>;
  readonly slowSpanThresholdMs?: number;
  readonly readAt: DateTime.Utc;
  readonly error?: TraceDiagnosticsErrorSummary;
  readonly partialFailure?: boolean;
}

interface TraceDiagnosticsErrorSummary {
  readonly kind: ServerTraceDiagnosticsErrorKind;
  readonly message: string;
}

const DEFAULT_SLOW_SPAN_THRESHOLD_MS = 1_000;
const TOP_LIMIT = 10;
const RECENT_LIMIT = 20;
function toRotatedTracePaths(traceFilePath: string, maxFiles: number): ReadonlyArray<string> {
  const backupCount = Math.max(0, Math.floor(maxFiles));
  const backups = Array.from(
    { length: backupCount },
    (_, index) => `${traceFilePath}.${backupCount - index}`,
  );
  return [...backups, traceFilePath];
}

function isRecordObject(value: unknown): value is TraceRecordLike {
  return typeof value === "object" && value !== null;
}

function toStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toNumberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function unixNanoToDateTime(value: unknown): DateTime.Utc | null {
  const text = toStringValue(value);
  if (!text) return null;
  try {
    const millis = Number(BigInt(text) / 1_000_000n);
    return Option.getOrNull(DateTime.make(millis));
  } catch {
    return null;
  }
}

function readExitTag(exit: unknown): string | null {
  if (!isRecordObject(exit) || !("_tag" in exit)) return null;
  return toStringValue(exit._tag);
}

function readExitCause(exit: unknown): string {
  if (!isRecordObject(exit) || !("cause" in exit)) return "Failure";
  return toStringValue(exit.cause)?.trim() ?? "Failure";
}

function isTraceEvent(value: unknown): value is TraceEventLike {
  return typeof value === "object" && value !== null;
}

function readEventAttributes(event: TraceEventLike): Readonly<Record<string, unknown>> {
  return typeof event.attributes === "object" && event.attributes !== null
    ? (event.attributes as Readonly<Record<string, unknown>>)
    : {};
}

function makeEmptyDiagnostics(input: {
  readonly traceFilePath: string;
  readonly scannedFilePaths: ReadonlyArray<string>;
  readonly readAt: DateTime.Utc;
  readonly slowSpanThresholdMs: number;
  readonly error?: TraceDiagnosticsErrorSummary;
  readonly partialFailure?: boolean;
}): ServerTraceDiagnosticsResult {
  return {
    traceFilePath: input.traceFilePath,
    scannedFilePaths: [...input.scannedFilePaths],
    readAt: input.readAt,
    recordCount: 0,
    parseErrorCount: 0,
    firstSpanAt: Option.none(),
    lastSpanAt: Option.none(),
    failureCount: 0,
    interruptionCount: 0,
    slowSpanThresholdMs: input.slowSpanThresholdMs,
    slowSpanCount: 0,
    logLevelCounts: {},
    topSpansByCount: [],
    slowestSpans: [],
    commonFailures: [],
    latestFailures: [],
    latestWarningAndErrorLogs: [],
    partialFailure: input.partialFailure ? Option.some(true) : Option.none(),
    error: Option.fromNullishOr(input.error),
  };
}

function isNotFoundError(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "NotFound";
}

function insertBoundedSlowestSpan(
  slowestSpans: ServerTraceDiagnosticsSpanOccurrence[],
  span: ServerTraceDiagnosticsSpanOccurrence,
): void {
  if (
    slowestSpans.length >= TOP_LIMIT &&
    span.durationMs <= slowestSpans[slowestSpans.length - 1]!.durationMs
  ) {
    return;
  }

  slowestSpans.push(span);
  slowestSpans.sort((left, right) => right.durationMs - left.durationMs);
  if (slowestSpans.length > TOP_LIMIT) {
    slowestSpans.length = TOP_LIMIT;
  }
}

function insertBoundedLatest<T>(items: T[], item: T, toEpochMillis: (item: T) => number): void {
  if (
    items.length >= RECENT_LIMIT &&
    toEpochMillis(item) <= toEpochMillis(items[items.length - 1]!)
  ) {
    return;
  }

  items.push(item);
  items.sort((left, right) => toEpochMillis(right) - toEpochMillis(left));
  if (items.length > RECENT_LIMIT) {
    items.length = RECENT_LIMIT;
  }
}

interface TraceDiagnosticsAccumulator {
  parseErrorCount: number;
  recordCount: number;
  failureCount: number;
  interruptionCount: number;
  slowSpanCount: number;
  firstSpanAt: DateTime.Utc | null;
  lastSpanAt: DateTime.Utc | null;
  readonly spansByName: Map<
    string,
    { count: number; failureCount: number; totalDurationMs: number; maxDurationMs: number }
  >;
  readonly failuresByKey: Map<string, ServerTraceDiagnosticsFailureSummary>;
  readonly latestFailures: ServerTraceDiagnosticsRecentFailure[];
  readonly slowestSpans: ServerTraceDiagnosticsSpanOccurrence[];
  readonly latestWarningAndErrorLogs: ServerTraceDiagnosticsLogEvent[];
  readonly logLevelCounts: Record<string, number>;
}

function makeTraceDiagnosticsAccumulator(): TraceDiagnosticsAccumulator {
  return {
    parseErrorCount: 0,
    recordCount: 0,
    failureCount: 0,
    interruptionCount: 0,
    slowSpanCount: 0,
    firstSpanAt: null,
    lastSpanAt: null,
    spansByName: new Map(),
    failuresByKey: new Map(),
    latestFailures: [],
    slowestSpans: [],
    latestWarningAndErrorLogs: [],
    logLevelCounts: {},
  };
}

function accumulateTraceLine(
  accumulator: TraceDiagnosticsAccumulator,
  line: string,
  slowSpanThresholdMs: number,
): void {
  if (line.trim().length === 0) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    accumulator.parseErrorCount += 1;
    return;
  }

  if (!isRecordObject(parsed)) {
    accumulator.parseErrorCount += 1;
    return;
  }

  const name = toStringValue(parsed.name);
  const traceId = toStringValue(parsed.traceId);
  const spanId = toStringValue(parsed.spanId);
  const durationMs = toNumberValue(parsed.durationMs);
  const endedAt = unixNanoToDateTime(parsed.endTimeUnixNano);
  const startedAt = unixNanoToDateTime(parsed.startTimeUnixNano);

  if (!name || !traceId || !spanId || durationMs === null || !endedAt) {
    accumulator.parseErrorCount += 1;
    return;
  }

  accumulator.recordCount += 1;
  accumulator.firstSpanAt =
    startedAt &&
    (accumulator.firstSpanAt === null || DateTime.isLessThan(startedAt, accumulator.firstSpanAt))
      ? startedAt
      : accumulator.firstSpanAt;
  accumulator.lastSpanAt =
    accumulator.lastSpanAt === null || DateTime.isGreaterThan(endedAt, accumulator.lastSpanAt)
      ? endedAt
      : accumulator.lastSpanAt;

  const exitTag = readExitTag(parsed.exit);
  const isFailure = exitTag === "Failure";
  const isInterrupted = exitTag === "Interrupted";
  if (isFailure) accumulator.failureCount += 1;
  if (isInterrupted) accumulator.interruptionCount += 1;

  const spanSummary = accumulator.spansByName.get(name) ?? {
    count: 0,
    failureCount: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
  };
  spanSummary.count += 1;
  spanSummary.totalDurationMs += durationMs;
  spanSummary.maxDurationMs = Math.max(spanSummary.maxDurationMs, durationMs);
  if (isFailure) spanSummary.failureCount += 1;
  accumulator.spansByName.set(name, spanSummary);

  const spanItem = { name, durationMs, endedAt, traceId, spanId };
  if (durationMs >= slowSpanThresholdMs) {
    accumulator.slowSpanCount += 1;
  }
  insertBoundedSlowestSpan(accumulator.slowestSpans, spanItem);

  if (isFailure) {
    const cause = readExitCause(parsed.exit);
    insertBoundedLatest(accumulator.latestFailures, { ...spanItem, cause }, (failure) =>
      DateTime.toEpochMillis(failure.endedAt),
    );

    const failureKey = `${name}\0${cause}`;
    const existing = accumulator.failuresByKey.get(failureKey);
    const isLatestFailure = !existing || DateTime.isGreaterThan(endedAt, existing.lastSeenAt);
    accumulator.failuresByKey.set(failureKey, {
      name,
      cause,
      count: (existing?.count ?? 0) + 1,
      lastSeenAt: isLatestFailure ? endedAt : existing!.lastSeenAt,
      traceId: isLatestFailure ? traceId : existing!.traceId,
      spanId: isLatestFailure ? spanId : existing!.spanId,
    });
  }

  if (!Array.isArray(parsed.events)) return;

  for (const rawEvent of parsed.events) {
    if (!isTraceEvent(rawEvent)) continue;
    const attributes = readEventAttributes(rawEvent);
    const level = toStringValue(attributes["effect.logLevel"]);
    if (!level) continue;

    accumulator.logLevelCounts[level] = (accumulator.logLevelCounts[level] ?? 0) + 1;
    const normalizedLevel = level.toLowerCase();
    if (
      normalizedLevel !== "warning" &&
      normalizedLevel !== "warn" &&
      normalizedLevel !== "error" &&
      normalizedLevel !== "fatal"
    ) {
      continue;
    }

    const seenAt = unixNanoToDateTime(rawEvent.timeUnixNano) ?? endedAt;
    const message = toStringValue(rawEvent.name)?.trim() ?? "Log event";
    insertBoundedLatest(
      accumulator.latestWarningAndErrorLogs,
      {
        spanName: name,
        level,
        message,
        seenAt,
        traceId,
        spanId,
      },
      (event) => DateTime.toEpochMillis(event.seenAt),
    );
  }
}

function finalizeTraceDiagnostics(input: {
  readonly traceFilePath: string;
  readonly scannedFilePaths: ReadonlyArray<string>;
  readonly readAt: DateTime.Utc;
  readonly slowSpanThresholdMs: number;
  readonly hasLoadedFiles: boolean;
  readonly accumulator: TraceDiagnosticsAccumulator;
  readonly error?: TraceDiagnosticsErrorSummary;
  readonly partialFailure?: boolean;
}): ServerTraceDiagnosticsResult {
  if (!input.hasLoadedFiles) {
    return makeEmptyDiagnostics({
      traceFilePath: input.traceFilePath,
      scannedFilePaths: input.scannedFilePaths,
      readAt: input.readAt,
      slowSpanThresholdMs: input.slowSpanThresholdMs,
      error: input.error ?? {
        kind: "trace-file-not-found",
        message: "No local trace files were found.",
      },
      ...(input.partialFailure ? { partialFailure: true } : {}),
    });
  }

  const { accumulator } = input;
  const topSpansByCount: ServerTraceDiagnosticsSpanSummary[] = [
    ...accumulator.spansByName.entries(),
  ]
    .map(([name, span]) => ({
      name,
      count: span.count,
      failureCount: span.failureCount,
      totalDurationMs: span.totalDurationMs,
      averageDurationMs: span.count > 0 ? span.totalDurationMs / span.count : 0,
      maxDurationMs: span.maxDurationMs,
    }))
    .toSorted((left, right) => right.count - left.count || right.maxDurationMs - left.maxDurationMs)
    .slice(0, TOP_LIMIT);

  return {
    traceFilePath: input.traceFilePath,
    scannedFilePaths: input.scannedFilePaths,
    readAt: input.readAt,
    recordCount: accumulator.recordCount,
    parseErrorCount: accumulator.parseErrorCount,
    firstSpanAt: Option.fromNullishOr(accumulator.firstSpanAt),
    lastSpanAt: Option.fromNullishOr(accumulator.lastSpanAt),
    failureCount: accumulator.failureCount,
    interruptionCount: accumulator.interruptionCount,
    slowSpanThresholdMs: input.slowSpanThresholdMs,
    slowSpanCount: accumulator.slowSpanCount,
    logLevelCounts: accumulator.logLevelCounts,
    topSpansByCount,
    slowestSpans: accumulator.slowestSpans,
    commonFailures: [...accumulator.failuresByKey.values()]
      .toSorted(
        (left, right) =>
          right.count - left.count ||
          DateTime.toEpochMillis(right.lastSeenAt) - DateTime.toEpochMillis(left.lastSeenAt),
      )
      .slice(0, TOP_LIMIT),
    latestFailures: accumulator.latestFailures,
    latestWarningAndErrorLogs: accumulator.latestWarningAndErrorLogs,
    partialFailure: input.partialFailure ? Option.some(true) : Option.none(),
    error: Option.fromNullishOr(input.error),
  };
}

export function aggregateTraceDiagnostics(
  input: TraceDiagnosticsInput,
): ServerTraceDiagnosticsResult {
  const readAt = input.readAt;
  const slowSpanThresholdMs = input.slowSpanThresholdMs ?? DEFAULT_SLOW_SPAN_THRESHOLD_MS;
  const scannedFilePaths = input.scannedFilePaths ?? input.files.map((file) => file.path);
  const accumulator = makeTraceDiagnosticsAccumulator();

  for (const file of input.files) {
    for (const line of file.text.split(/\r?\n/)) {
      accumulateTraceLine(accumulator, line, slowSpanThresholdMs);
    }
  }

  return finalizeTraceDiagnostics({
    traceFilePath: input.traceFilePath,
    scannedFilePaths,
    readAt,
    slowSpanThresholdMs,
    hasLoadedFiles: input.files.length > 0,
    accumulator,
    ...(input.error ? { error: input.error } : {}),
    ...(input.partialFailure ? { partialFailure: true } : {}),
  });
}

type TraceFileReadResult =
  | { readonly _tag: "Loaded"; readonly path: string }
  | { readonly _tag: "Missing"; readonly path: string };

function readTraceFile(
  fileSystem: FileSystem.FileSystem,
  path: string,
  onLine: (line: string) => void,
): Effect.Effect<TraceFileReadResult, TraceFileReadError> {
  return fileSystem.stream(path).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => Effect.sync(() => onLine(line))),
    Effect.as<TraceFileReadResult>({ _tag: "Loaded", path }),
    Effect.catchTags({
      PlatformError: (cause) =>
        isNotFoundError(cause)
          ? Effect.succeed<TraceFileReadResult>({ _tag: "Missing", path })
          : Effect.fail(
              new TraceFileReadError({
                traceFilePath: path,
                causeTag: cause.reason._tag,
                cause,
              }),
            ),
    }),
  );
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;

  const read: TraceDiagnostics["Service"]["read"] = Effect.fn("TraceDiagnostics.read")(
    function* (options) {
      const readAt = options.readAt ?? (yield* DateTime.now);
      const slowSpanThresholdMs = options.slowSpanThresholdMs ?? DEFAULT_SLOW_SPAN_THRESHOLD_MS;
      const paths = toRotatedTracePaths(options.traceFilePath, options.maxFiles);
      const accumulator = makeTraceDiagnosticsAccumulator();
      const results = yield* Effect.all(
        paths.map((path) =>
          readTraceFile(fileSystem, path, (line) =>
            accumulateTraceLine(accumulator, line, slowSpanThresholdMs),
          ).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Failed to read local trace file.").pipe(
                Effect.annotateLogs({
                  traceFilePath: cause.traceFilePath,
                  errorTag: cause._tag,
                  causeTag: cause.causeTag,
                }),
              ),
            ),
            Effect.result,
          ),
        ),
        {
          concurrency: 1,
        },
      );
      const hasLoadedFiles = results.some(
        (result) => Result.isSuccess(result) && result.success._tag === "Loaded",
      );
      const readFailure = results.find(Result.isFailure);
      const readFailureError = readFailure
        ? ({
            kind: "trace-file-read-failed",
            message: readFailure.failure.message,
          } satisfies TraceDiagnosticsErrorSummary)
        : undefined;

      return finalizeTraceDiagnostics({
        traceFilePath: options.traceFilePath,
        scannedFilePaths: paths,
        readAt,
        slowSpanThresholdMs,
        hasLoadedFiles,
        accumulator,
        ...(readFailureError ? { partialFailure: hasLoadedFiles, error: readFailureError } : {}),
      });
    },
  );

  return TraceDiagnostics.of({ read });
});

export const layer = Layer.effect(TraceDiagnostics, make);

export function readTraceDiagnostics(
  options: TraceDiagnosticsOptions,
): Effect.Effect<ServerTraceDiagnosticsResult, never, TraceDiagnostics> {
  return Effect.gen(function* () {
    const diagnostics = yield* TraceDiagnostics;
    return yield* diagnostics.read(options);
  });
}
