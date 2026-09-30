import { createClient } from "@supabase/supabase-js";
import {
  emptyReport,
  mergeKeepSubmitted,
  normalizeReport,
  type WeeklyReport,
} from "./model";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

const supabase =
  supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const TABLE = "paint_line_weeks";

export class RemoteSaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteSaveError";
  }
}

const DB_NAME = "paintline-weekly";
const STORE = "reports";
const LAST_WEEK_KEY = "paintline-last-week";
const OPEN_WEEK_KEY = "paintline-open-week";

function openDb(): Promise<IDBDatabase> {
  return withTimeout(
    new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }),
    2_000,
    "IndexedDB",
  );
}

type LocalCopy = { report: WeeklyReport; savedAt: string };

function asLocalCopy(value: unknown, weekStart: string): LocalCopy | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<LocalCopy> & Partial<WeeklyReport>;
  const report = row.report?.weekStart ? row.report : (row as WeeklyReport);
  if (!report?.weekStart || report.weekStart !== weekStart) return null;
  return {
    report: normalizeReport(report, weekStart),
    savedAt: row.savedAt || "",
  };
}

async function readLocal(weekStart: string): Promise<LocalCopy | null> {
  try {
    const db = await openDb();
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(weekStart);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return asLocalCopy(value, weekStart);
  } catch {
    return null;
  }
}

async function writeLocal(report: WeeklyReport, savedAt: string): Promise<void> {
  const db = await openDb();
  const copy: LocalCopy = { report, savedAt };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(copy, report.weekStart);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  localStorage.setItem(LAST_WEEK_KEY, report.weekStart);
}

async function clearLocal(weekStart: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(weekStart);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // ignore
  }
}

const REMOTE_LOAD_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function readRemote(
  weekStart: string,
): Promise<{ report: WeeklyReport; updatedAt: string } | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from(TABLE)
    .select("report, updated_at")
    .eq("week_start", weekStart)
    .maybeSingle();
  if (error) {
    // No row yet for this week. That is an empty week, not a failed load.
    const code = "code" in error ? String(error.code) : "";
    if (code === "PGRST116") return null;
    throw new RemoteSaveError(error.message);
  }
  if (!data?.report) return null;
  return {
    report: normalizeReport(data.report as WeeklyReport, weekStart),
    updatedAt: String(data.updated_at ?? ""),
  };
}

async function loadReportInner(weekStart: string): Promise<WeeklyReport> {
  const local = await readLocal(weekStart);
  try {
    // Without a timeout, a hung Supabase/fetch leaves App saveState at
    // "loading" forever ("Chargement / Loading" in the chrome pill).
    const remote = await withTimeout(
      readRemote(weekStart),
      REMOTE_LOAD_TIMEOUT_MS,
      "Supabase loadReport",
    );
    // Re-read after the network call. A submit may have landed while we waited,
    // and writing the older remote row back would reopen that form.
    const freshLocal = (await readLocal(weekStart)) ?? local;
    if (!remote) {
      const fresh = emptyReport(weekStart);
      if (supabase) {
        await clearLocal(weekStart);
        return fresh;
      }
      return freshLocal?.report ?? fresh;
    }
    const newer =
      freshLocal && freshLocal.savedAt > remote.updatedAt
        ? freshLocal.report
        : remote.report;
    const older =
      freshLocal && freshLocal.savedAt > remote.updatedAt
        ? remote.report
        : freshLocal?.report;
    const merged = mergeKeepSubmitted(newer, older, weekStart);
    const savedAt =
      freshLocal && freshLocal.savedAt > remote.updatedAt
        ? freshLocal.savedAt
        : remote.updatedAt;
    await writeLocal(merged, savedAt || new Date().toISOString());
    return merged;
  } catch (err) {
    const fallback = (await readLocal(weekStart)) ?? local;
    if (fallback) return fallback.report;
    // No copy on the tablet and the server did not answer. Refuse to invent
    // an empty week — saving that would erase forms that were already sent.
    throw err instanceof Error ? err : new Error("loadReport failed");
  }
}

export async function loadReport(weekStart: string): Promise<WeeklyReport> {
  return withTimeout(loadReportInner(weekStart), 15_000, "loadReport");
}

let saveQueue: Promise<void> = Promise.resolve();

async function saveReportNow(report: WeeklyReport): Promise<void> {
  const savedAt = new Date().toISOString();
  const local = await readLocal(report.weekStart);
  let merged = mergeKeepSubmitted(report, local?.report, report.weekStart);
  if (supabase) {
    try {
      const remote = await withTimeout(
        readRemote(report.weekStart),
        3_000,
        "Supabase save merge",
      );
      if (remote) {
        merged = mergeKeepSubmitted(merged, remote.report, report.weekStart);
      }
    } catch {
      // Keep the local merge. A hung read must not block the tablet.
    }
  }
  await writeLocal(merged, savedAt);
  if (!supabase) {
    throw new RemoteSaveError("Supabase is not configured");
  }
  await withTimeout(
    Promise.resolve(
      supabase
        .from(TABLE)
        .upsert(
          { week_start: merged.weekStart, report: merged },
          { onConflict: "week_start" },
        ),
    ).then((result) => {
      if (result.error) throw new RemoteSaveError(result.error.message);
    }),
    REMOTE_LOAD_TIMEOUT_MS,
    "Supabase saveReport",
  );
}

export function saveReport(report: WeeklyReport): Promise<void> {
  const snapshot = report;
  const run = saveQueue.then(() => saveReportNow(snapshot));
  saveQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function getLastWeek(): string | null {
  return localStorage.getItem(LAST_WEEK_KEY);
}

/** Week the user chose to work on. Saving another week must not change this. */
export function getOpenWeek(): string | null {
  return localStorage.getItem(OPEN_WEEK_KEY);
}

export function setOpenWeek(weekStart: string): void {
  localStorage.setItem(OPEN_WEEK_KEY, weekStart);
}

export async function listWeeks(): Promise<string[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from(TABLE)
    .select("week_start")
    .order("week_start");
  if (error || !data) return [];
  return data.map((row) => String(row.week_start));
}

export function downloadJson(report: WeeklyReport): void {
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `paintline-week-${report.weekStart}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function readJsonFile(file: File): Promise<WeeklyReport> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result)) as WeeklyReport;
        if (!data?.weekStart || !data?.shifts) {
          reject(new Error("Invalid report file"));
          return;
        }
        resolve(normalizeReport(data, data.weekStart));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
