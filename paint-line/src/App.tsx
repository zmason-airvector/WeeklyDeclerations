import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmSubmit } from "./components/ConfirmSubmit";
import { DailyMeetingForm } from "./components/DailyMeetingForm";
import { DailyOrderForm } from "./components/DailyOrderForm";
import { MeetingHandover } from "./components/MeetingHandover";
import { RepaintForm } from "./components/RepaintForm";
import { RepaintHandover } from "./components/RepaintHandover";
import {
  clockNow,
  dueMeetingCandidates,
  dueRepaintCandidates,
  previousWeekStart,
  weekHasPendingSubmissions,
  weekWasStarted,
  type DueSlot,
} from "./meetingSchedule";
import {
  DAYS,
  DAY_META,
  SHIFTS,
  SHIFT_META,
  addDays,
  emptyReport,
  formatShort,
  getMonday,
  isoDate,
  meetingPageHasContent,
  meetingSubmittedCount,
  orderCanSubmit,
  orderHasContent,
  mergeKeepSubmitted,
  orderIsLocked,
  parseIso,
  repaintDayCanSubmit,
  repaintPageHasContent,
  repaintSubmittedCount,
  shiftFillCount,
  sundayOf,
  withMeetingDaySubmitted,
  withRepaintDaySubmitted,
  type DayId,
  type MeetingDay,
  type RepaintDay,
  type Screen,
  type ShiftId,
  type WeeklyReport,
} from "./model";
import { getLastWeek, getOpenWeek, loadReport, saveReport, setOpenWeek } from "./storage";

type PendingSubmit =
  | { kind: "orders" }
  | { kind: "repaint-day"; shift: ShiftId; day: DayId; weekStart: string }
  | { kind: "meeting-day"; shift: ShiftId; day: DayId; weekStart: string };

type SlotChoice = DueSlot & { pendingLoad?: boolean };

export type PopupKind = "repaint" | "meeting";

export function popupDismissKey(kind: PopupKind, slot: DueSlot): string {
  return `${kind}:${slot.weekStart}:${slot.shift}:${slot.day}`;
}

function firstOpenSlot(
  candidates: DueSlot[],
  weekStart: string,
  report: WeeklyReport,
  handover: WeeklyReport | null,
  blockedWeeks: readonly string[],
  dismissed: ReadonlySet<string>,
  kind: PopupKind,
  isSubmitted: (source: WeeklyReport, slot: DueSlot) => boolean,
): SlotChoice | null {
  for (const candidate of candidates) {
    if (dismissed.has(popupDismissKey(kind, candidate))) continue;
    if (candidate.weekStart === weekStart) {
      if (!isSubmitted(report, candidate)) return candidate;
      continue;
    }
    if (blockedWeeks.includes(candidate.weekStart)) continue;
    if (handover?.weekStart === candidate.weekStart) {
      if (!isSubmitted(handover, candidate)) return candidate;
      continue;
    }
    // The other week is not loaded yet. Ask for a load, but do not open a
    // form we have not read — that is what flashed "Loading…" and then
    // reopened a form that was already sent.
    return { ...candidate, pendingLoad: true };
  }
  return null;
}

function initialWeek(): string {
  const calendar = getMonday(clockNow());
  const previous = previousWeekStart(calendar);
  const open = getOpenWeek();
  // After "Go to Next Week", stay on that week. A later save of the finished
  // week must not pull the tablet back.
  if (open === calendar) return calendar;
  if (open === previous) return previous;
  const last = getLastWeek();
  if (last === previous) return previous;
  return calendar;
}

export default function App() {
  const [weekStart, setWeekStart] = useState(initialWeek);
  const [report, setReport] = useState<WeeklyReport>(() =>
    emptyReport(weekStart),
  );
  const [screen, setScreen] = useState<Screen>("overview");
  const [shift, setShift] = useState<ShiftId>("morning");
  const [day, setDay] = useState<DayId>("monday");
  const [saveState, setSaveState] = useState<
    "saved" | "saving" | "loading" | "local"
  >("loading");
  const skipSave = useRef(true);
  const [pendingSubmit, setPendingSubmit] = useState<PendingSubmit | null>(
    null,
  );
  const [handoverReport, setHandoverReport] = useState<WeeklyReport | null>(
    null,
  );
  const [blockedWeeks, setBlockedWeeks] = useState<string[]>([]);
  const [dismissedPopups, setDismissedPopups] = useState<Set<string>>(
    () => new Set(),
  );
  const [loadFailed, setLoadFailed] = useState(false);
  const [nowTick, setNowTick] = useState(() => clockNow().getTime());
  const reportRef = useRef(report);
  reportRef.current = report;
  const handoverRef = useRef(handoverReport);
  handoverRef.current = handoverReport;
  // Equal tokens mean the handover on screen was loaded, not edited, so it
  // must not be saved back over a submit.
  const handoverLoadToken = useRef(0);
  const appliedLoadToken = useRef(0);

  useEffect(() => {
    let cancelled = false;
    skipSave.current = true;
    setSaveState("loading");
    setLoadFailed(false);
    const giveUp = window.setTimeout(() => {
      if (cancelled) return;
      // Stop the pill on "Chargement / Loading". Do not save the empty
      // placeholder — that would wipe the week on the server.
      setLoadFailed(true);
      setSaveState((state) => (state === "loading" ? "local" : state));
    }, 15_000);
    loadReport(weekStart)
      .then((loaded) => {
        if (cancelled) return;
        const current = reportRef.current;
        const merged = mergeKeepSubmitted(
          loaded,
          current.weekStart === loaded.weekStart ? current : null,
          weekStart,
        );
        reportRef.current = merged;
        setReport(merged);
        setLoadFailed(false);
        setSaveState("saved");
        skipSave.current = false;
      })
      .catch(() => {
        if (cancelled) return;
        setLoadFailed(true);
        setSaveState("local");
      })
      .finally(() => {
        window.clearTimeout(giveUp);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(giveUp);
    };
  }, [weekStart]);

  useEffect(() => {
    if (skipSave.current) return;
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      saveReport(report)
        .then(() => setSaveState("saved"))
        .catch(() => setSaveState("local"));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [report]);

  useEffect(() => {
    if (!handoverReport || handoverReport.weekStart === weekStart) return;
    if (appliedLoadToken.current === handoverLoadToken.current) return;
    const timer = window.setTimeout(() => {
      saveReport(handoverReport)
        .then(() => setSaveState("saved"))
        .catch(() => setSaveState("local"));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [handoverReport, weekStart]);

  useEffect(() => {
    const id = window.setInterval(() => setNowTick(clockNow().getTime()), 15_000);
    const onVis = () => {
      if (document.visibilityState === "visible") setNowTick(clockNow().getTime());
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, []);

  const pendingHold = useMemo(
    () => weekHasPendingSubmissions(report, clockNow()),
    [report, nowTick],
  );
  const calendarWeek = useMemo(() => getMonday(clockNow()), [nowTick]);
  const holdingLastWeek = weekStart < calendarWeek;
  const startedWeek = useMemo(() => weekWasStarted(report), [report]);
  const canGoToNextWeek =
    holdingLastWeek &&
    report.weekStart === weekStart &&
    startedWeek &&
    !pendingHold &&
    saveState !== "loading";

  useEffect(() => {
    if (saveState === "loading") return;
    const previous = previousWeekStart(calendarWeek);

    if (weekStart === previous) {
      // Only auto-leave an empty/unstarted prior week. A started week that is
      // fully submitted waits for an explicit "Go to next week" tap so the
      // last save is not cancelled by a weekStart reload race.
      if (report.weekStart === previous && !pendingHold && !startedWeek) {
        setWeekStart(calendarWeek);
        setScreen("overview");
      }
      return;
    }

    if (weekStart < previous) {
      setWeekStart(previous);
      setScreen("overview");
    }
  }, [
    weekStart,
    saveState,
    pendingHold,
    calendarWeek,
    report.weekStart,
    startedWeek,
  ]);

  useEffect(() => {
    if (saveState === "loading") return;
    if (weekStart !== calendarWeek) return;
    // The user already left the finished week. Do not send them back.
    if (getOpenWeek() === calendarWeek) return;
    let cancelled = false;
    const previous = previousWeekStart(calendarWeek);
    loadReport(previous).then((previousReport) => {
      if (cancelled) return;
      if (getOpenWeek() === calendarWeek) return;
      if (weekHasPendingSubmissions(previousReport, clockNow())) {
        setWeekStart(previous);
        setScreen("overview");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [weekStart, saveState, calendarWeek]);

  useEffect(() => {
    const previous = previousWeekStart(calendarWeek);
    if (saveState === "loading") return;
    if (weekStart !== previous) return;
    if (report.weekStart !== previous || pendingHold || !startedWeek) return;
    if (getOpenWeek() === calendarWeek) {
      setWeekStart(calendarWeek);
      setScreen("overview");
      return;
    }
    // The finished week is on screen only until the next week has been opened.
    // Work already saved on the next week means that open already happened.
    let cancelled = false;
    loadReport(calendarWeek).then((nextReport) => {
      if (cancelled) return;
      if (!weekWasStarted(nextReport)) return;
      setOpenWeek(calendarWeek);
      setWeekStart(calendarWeek);
      setScreen("overview");
    });
    return () => {
      cancelled = true;
    };
  }, [
    weekStart,
    saveState,
    calendarWeek,
    report.weekStart,
    pendingHold,
    startedWeek,
  ]);

  const dueRepaint = useMemo(() => {
    void nowTick;
    return firstOpenSlot(
      dueRepaintCandidates(clockNow(), weekStart),
      weekStart,
      report,
      handoverReport,
      blockedWeeks,
      dismissedPopups,
      "repaint",
      (source, slot) => source.shifts[slot.shift].repaint[slot.day].submitted,
    );
  }, [nowTick, report, handoverReport, weekStart, blockedWeeks, dismissedPopups]);

  const dueMeeting = useMemo(() => {
    void nowTick;
    return firstOpenSlot(
      dueMeetingCandidates(clockNow(), weekStart),
      weekStart,
      report,
      handoverReport,
      blockedWeeks,
      dismissedPopups,
      "meeting",
      (source, slot) => source.shifts[slot.shift].meeting[slot.day].submitted,
    );
  }, [nowTick, report, handoverReport, weekStart, blockedWeeks, dismissedPopups]);

  const dueRepaintOpen =
    dueRepaint && !dueRepaint.pendingLoad ? dueRepaint : null;
  // Do not open the meeting while an earlier repaint form is still being read.
  const dueMeetingOpen =
    dueRepaint?.pendingLoad || !dueMeeting || dueMeeting.pendingLoad
      ? null
      : dueMeeting;

  const dismissBlockingPopup = useCallback(() => {
    if (dueRepaintOpen) {
      setDismissedPopups((prev) => {
        const next = new Set(prev);
        next.add(popupDismissKey("repaint", dueRepaintOpen));
        return next;
      });
      return;
    }
    if (dueMeetingOpen) {
      setDismissedPopups((prev) => {
        const next = new Set(prev);
        next.add(popupDismissKey("meeting", dueMeetingOpen));
        return next;
      });
    }
  }, [dueRepaintOpen, dueMeetingOpen]);

  const blockingSlot = dueRepaint ?? dueMeeting;
  const blockingKind = dueRepaintOpen
    ? "repaint"
    : dueMeetingOpen
      ? "meeting"
      : null;
  const popupOpen =
    Boolean(blockingKind) && saveState !== "loading" && !loadFailed;

  useEffect(() => {
    // The week on screen is saved as `report`. Drop a handover only when it is
    // that same week, so a stale copy cannot be written back over a submit.
    // Keep a handover of a different week: clearing it made finished
    // September 27 forms look unsent and opened the night meeting again.
    if (!blockingSlot) return;
    if (blockingSlot.weekStart === weekStart) {
      setHandoverReport((prev) =>
        prev && prev.weekStart === weekStart ? null : prev,
      );
      return;
    }
    const targetWeek = blockingSlot.weekStart;
    if (handoverRef.current?.weekStart === targetWeek) return;
    let cancelled = false;
    const token = ++handoverLoadToken.current;
    const giveUp = window.setTimeout(() => {
      if (cancelled) return;
      if (handoverRef.current?.weekStart === targetWeek) return;
      setBlockedWeeks((prev) =>
        prev.includes(targetWeek) ? prev : [...prev, targetWeek],
      );
    }, 15_000);
    loadReport(targetWeek)
      .then((loaded) => {
        if (cancelled) return;
        window.clearTimeout(giveUp);
        const current = handoverRef.current;
        const merged = mergeKeepSubmitted(
          current?.weekStart === loaded.weekStart ? current : loaded,
          current?.weekStart === loaded.weekStart ? loaded : current,
          targetWeek,
        );
        appliedLoadToken.current = token;
        handoverRef.current = merged;
        setHandoverReport(merged);
        setBlockedWeeks((prev) => prev.filter((week) => week !== targetWeek));
      })
      .catch(() => {
        if (cancelled) return;
        window.clearTimeout(giveUp);
        setBlockedWeeks((prev) =>
          prev.includes(targetWeek) ? prev : [...prev, targetWeek],
        );
      });
    return () => {
      cancelled = true;
      window.clearTimeout(giveUp);
    };
  }, [blockingSlot?.weekStart, weekStart]);

  useEffect(() => {
    if (!popupOpen) return;

    const scrollY = window.scrollY;
    const body = document.body;
    const previous = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
    };
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    document.documentElement.classList.add("meeting-handover-open");

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.closest(".meeting-popup")) return;
      window.setTimeout(() => {
        target.scrollIntoView({ block: "center", inline: "nearest" });
      }, 250);
    };
    document.addEventListener("focusin", onFocusIn);

    return () => {
      document.removeEventListener("focusin", onFocusIn);
      body.style.position = previous.position;
      body.style.top = previous.top;
      body.style.left = previous.left;
      body.style.right = previous.right;
      body.style.width = previous.width;
      document.documentElement.classList.remove("meeting-handover-open");
      window.scrollTo(0, scrollY);
    };
  }, [popupOpen]);

  const openForm = useCallback(
    (nextShift: ShiftId, nextScreen: Screen, nextDay: DayId = "monday") => {
      setShift(nextShift);
      setDay(nextDay);
      setScreen(nextScreen);
      window.scrollTo({ top: 0, behavior: "auto" });
    },
    [],
  );

  const weekLabel = useMemo(() => {
    const start = formatShort(weekStart, "en-CA");
    const end = formatShort(sundayOf(weekStart), "en-CA");
    const startFr = formatShort(weekStart, "fr-CA");
    const endFr = formatShort(sundayOf(weekStart), "fr-CA");
    return `${startFr} – ${endFr}  ·  ${start} – ${end}`;
  }, [weekStart]);

  async function goToNextWeek() {
    if (!canGoToNextWeek) return;
    // Remember the choice before the save, so a refresh stays on the new week
    // even if that save records the finished week as the latest write.
    setOpenWeek(calendarWeek);
    // Flush the held week's last submission before swapping weekStart so the
    // load effect cannot cancel the debounced save and reload stale data.
    setSaveState("saving");
    try {
      await saveReport(reportRef.current);
      setSaveState("saved");
    } catch {
      setSaveState("local");
    }
    setWeekStart(calendarWeek);
    setScreen("overview");
  }

  function commitReport(next: WeeklyReport) {
    reportRef.current = next;
    setReport(next);
    void saveReport(next);
  }

  function commitHandover(next: WeeklyReport) {
    appliedLoadToken.current = -1;
    handoverRef.current = next;
    setHandoverReport(next);
    void saveReport(next);
  }

  function confirmSubmit() {
    if (!pendingSubmit) return;
    const submittedAt = new Date().toISOString();
    const pending = pendingSubmit;
    if (pending.kind === "orders") {
      const current = reportRef.current;
      if (!orderCanSubmit(current.shifts[shift].orders[day])) {
        setPendingSubmit(null);
        return;
      }
      commitReport({
        ...current,
        shifts: {
          ...current.shifts,
          [shift]: {
            ...current.shifts[shift],
            orders: {
              ...current.shifts[shift].orders,
              [day]: {
                ...current.shifts[shift].orders[day],
                submitted: true,
                submittedAt,
              },
            },
          },
        },
      });
    } else if (pending.kind === "meeting-day") {
      if (pending.weekStart === weekStart) {
        commitReport(
          withMeetingDaySubmitted(
            reportRef.current,
            pending.shift,
            pending.day,
            submittedAt,
          ),
        );
      } else if (handoverRef.current?.weekStart === pending.weekStart) {
        commitHandover(
          withMeetingDaySubmitted(
            handoverRef.current,
            pending.shift,
            pending.day,
            submittedAt,
          ),
        );
      }
    } else if (pending.kind === "repaint-day") {
      const source =
        pending.weekStart === weekStart
          ? reportRef.current
          : handoverRef.current?.weekStart === pending.weekStart
            ? handoverRef.current
            : null;
      if (
        !source ||
        !repaintDayCanSubmit(source.shifts[pending.shift].repaint[pending.day])
      ) {
        setPendingSubmit(null);
        return;
      }
      const next = withRepaintDaySubmitted(
        source,
        pending.shift,
        pending.day,
        submittedAt,
      );
      if (pending.weekStart === weekStart) commitReport(next);
      else commitHandover(next);
    }
    setPendingSubmit(null);
  }

  function patchDueMeeting(next: Partial<MeetingDay>) {
    if (!dueMeeting) return;
    const apply = (prev: WeeklyReport): WeeklyReport => {
      const current = prev.shifts[dueMeeting.shift].meeting[dueMeeting.day];
      if (current.submitted) return prev;
      return {
        ...prev,
        shifts: {
          ...prev.shifts,
          [dueMeeting.shift]: {
            ...prev.shifts[dueMeeting.shift],
            meeting: {
              ...prev.shifts[dueMeeting.shift].meeting,
              [dueMeeting.day]: { ...current, ...next },
            },
          },
        },
      };
    };
    if (dueMeeting.weekStart === weekStart) setReport(apply);
    else {
      appliedLoadToken.current = -1;
      setHandoverReport((prev) => {
        if (!prev) return prev;
        const next = apply(prev);
        handoverRef.current = next;
        return next;
      });
    }
  }

  function patchDueRepaint(next: RepaintDay) {
    if (!dueRepaint) return;
    const apply = (prev: WeeklyReport): WeeklyReport => {
      const current = prev.shifts[dueRepaint.shift].repaint[dueRepaint.day];
      if (current.submitted) return prev;
      return {
        ...prev,
        shifts: {
          ...prev.shifts,
          [dueRepaint.shift]: {
            ...prev.shifts[dueRepaint.shift],
            repaint: {
              ...prev.shifts[dueRepaint.shift].repaint,
              [dueRepaint.day]: next,
            },
          },
        },
      };
    };
    if (dueRepaint.weekStart === weekStart) setReport(apply);
    else {
      appliedLoadToken.current = -1;
      setHandoverReport((prev) => {
        if (!prev) return prev;
        const next = apply(prev);
        handoverRef.current = next;
        return next;
      });
    }
  }

  const currentShift = report.shifts[shift];
  const orderLocked = orderIsLocked(currentShift.orders[day]);

  return (
    <div className={`app shift-theme-${shift}`}>
      <div className="app-head no-print">
      <header className="chrome">
        <div className="chrome-top">
          <div className="chrome-leading">
            {screen === "overview" ? null : (
              <button
                type="button"
                className="back-btn"
                onClick={() => setScreen("overview")}
              >
                ← Retour / Back
              </button>
            )}
            <div>
              <p className="kicker">Ligne de peinture / Paint Line</p>
              <h1>Rapport hebdomadaire / Weekly Report</h1>
            </div>
          </div>
          <div className="week-label">
            <span>
              {holdingLastWeek
                ? "Semaine précédente / Previous week"
                : "Semaine en cours / Current week"}
            </span>
            <strong>{weekLabel}</strong>
            {holdingLastWeek && !canGoToNextWeek ? (
              <em className="week-hold">
                Envoyez les formulaires restants pour ouvrir la nouvelle
                semaine. / Submit remaining forms to open the new week.
              </em>
            ) : null}
            {canGoToNextWeek ? (
              <em className="week-hold week-hold-ready">
                Semaine complète — passez à la suivante. / Week complete —
                Go to Next Week.
              </em>
            ) : null}
            {loadFailed ? (
              <em className="week-hold">
                Chargement interrompu — les formulaires déjà envoyés restent
                fermés. / Loading stopped — forms already sent stay closed.
              </em>
            ) : null}
          </div>
        </div>

        <div className="chrome-actions">
          <span className={`save-pill ${saveState}`}>
            {saveState === "loading"
              ? "Chargement / Loading"
              : saveState === "saving"
                ? "Enregistrement… / Saving"
                : saveState === "local"
                ? "Tablette seulement / Saved on tablet"
                : "Enregistré / Saved"}
          </span>
          {canGoToNextWeek ? (
            <button
              type="button"
              className="primary-btn next-week-btn"
              onClick={() => {
                void goToNextWeek();
              }}
            >
              Aller à la semaine suivante / Go to Next Week
            </button>
          ) : null}
        </div>
      </header>

      </div>

      {screen === "overview" ? (
        <Overview
          report={report}
          canGoToNextWeek={canGoToNextWeek}
          onGoToNextWeek={() => {
            void goToNextWeek();
          }}
          onOpen={openForm}
        />
      ) : (
        <>
          <main className={`form-stage shift-${shift}`}>
            {screen === "orders" ? (
              <DailyOrderForm
                shift={shift}
                value={currentShift.orders[day]}
                locked={orderLocked}
                onSubmit={() => setPendingSubmit({ kind: "orders" })}
                onChange={(orders) => {
                  if (orderIsLocked(currentShift.orders[day])) return;
                  setReport((prev) => ({
                    ...prev,
                    shifts: {
                      ...prev.shifts,
                      [shift]: {
                        ...prev.shifts[shift],
                        orders: { ...prev.shifts[shift].orders, [day]: orders },
                      },
                    },
                  }));
                }}
              />
            ) : null}
            {screen === "meeting" ? (
              <DailyMeetingForm
                shift={shift}
                value={currentShift.meeting}
                highlightDay={
                  dueMeeting &&
                  dueMeeting.weekStart === weekStart &&
                  dueMeeting.shift === shift
                    ? dueMeeting.day
                    : undefined
                }
                onSubmitDay={(meetingDay) =>
                  setPendingSubmit({
                    kind: "meeting-day",
                    shift,
                    day: meetingDay,
                    weekStart,
                  })
                }
                onChange={(meeting) => {
                  setReport((prev) => ({
                    ...prev,
                    shifts: {
                      ...prev.shifts,
                      [shift]: { ...prev.shifts[shift], meeting },
                    },
                  }));
                }}
              />
            ) : null}
            {screen === "repaint" ? (
              <RepaintForm
                shift={shift}
                value={currentShift.repaint}
                highlightDay={
                  dueRepaint &&
                  dueRepaint.weekStart === weekStart &&
                  dueRepaint.shift === shift
                    ? dueRepaint.day
                    : undefined
                }
                onSubmitDay={(repaintDay) =>
                  setPendingSubmit({
                    kind: "repaint-day",
                    shift,
                    day: repaintDay,
                    weekStart,
                  })
                }
                onChange={(repaint) => {
                  setReport((prev) => ({
                    ...prev,
                    shifts: {
                      ...prev.shifts,
                      [shift]: { ...prev.shifts[shift], repaint },
                    },
                  }));
                }}
              />
            ) : null}
          </main>
        </>
      )}

      <ConfirmSubmit
        open={pendingSubmit !== null}
        onCancel={() => setPendingSubmit(null)}
        onConfirm={confirmSubmit}
      />

      {blockingKind === "repaint" &&
      dueRepaintOpen &&
      saveState !== "loading" &&
      !loadFailed ? (
        <RepaintHandover
          key={`${dueRepaintOpen.weekStart}-${dueRepaintOpen.shift}-${dueRepaintOpen.day}`}
          due={dueRepaintOpen}
          loading={false}
          value={
            dueRepaintOpen.weekStart === weekStart
              ? report.shifts[dueRepaintOpen.shift].repaint[dueRepaintOpen.day]
              : (handoverReport?.shifts[dueRepaintOpen.shift].repaint[
                  dueRepaintOpen.day
                ] ?? null)
          }
          onChange={patchDueRepaint}
          onSubmit={() =>
            setPendingSubmit({
              kind: "repaint-day",
              shift: dueRepaintOpen.shift,
              day: dueRepaintOpen.day,
              weekStart: dueRepaintOpen.weekStart,
            })
          }
          onExit={dismissBlockingPopup}
        />
      ) : null}

      {blockingKind === "meeting" &&
      dueMeetingOpen &&
      saveState !== "loading" &&
      !loadFailed ? (
        <MeetingHandover
          key={`${dueMeetingOpen.weekStart}-${dueMeetingOpen.shift}-${dueMeetingOpen.day}`}
          due={dueMeetingOpen}
          loading={false}
          value={
            dueMeetingOpen.weekStart === weekStart
              ? report.shifts[dueMeetingOpen.shift].meeting[dueMeetingOpen.day]
              : (handoverReport?.shifts[dueMeetingOpen.shift].meeting[
                  dueMeetingOpen.day
                ] ?? null)
          }
          onChange={patchDueMeeting}
          onSubmit={() =>
            setPendingSubmit({
              kind: "meeting-day",
              shift: dueMeetingOpen.shift,
              day: dueMeetingOpen.day,
              weekStart: dueMeetingOpen.weekStart,
            })
          }
          onExit={dismissBlockingPopup}
        />
      ) : null}

    </div>
  );
}

function Overview({
  report,
  canGoToNextWeek,
  onGoToNextWeek,
  onOpen,
}: {
  report: WeeklyReport;
  canGoToNextWeek: boolean;
  onGoToNextWeek: () => void;
  onOpen: (shift: ShiftId, screen: Screen, day?: DayId) => void;
}) {
  return (
    <main className="overview">
      <p className="overview-lead">
        Chaque quart a 7 listes de commandes (lundi–dimanche), 1 réunion
        quotidienne et 1 formulaire de repeinture / matériel défectueux par jour.
        <br />
        Each shift has 7 daily order lists (Monday–Sunday), 1 daily meeting page
        and a daily repaint &amp; bad material form.
      </p>
      {canGoToNextWeek ? (
        <div className="next-week-banner">
          <p>
            Tous les formulaires de la semaine sont envoyés. /
            All forms for this week are submitted.
          </p>
          <button
            type="button"
            className="primary-btn next-week-btn"
            onClick={onGoToNextWeek}
          >
            Aller à la semaine suivante / Go to Next Week
          </button>
        </div>
      ) : null}
      <div className="shift-columns">
        {SHIFTS.map((id) => {
          const data = report.shifts[id];
          const fill = shiftFillCount(data);
          return (
            <section className={`shift-card shift-${id}`} key={id}>
              <header>
                <h2>
                  {SHIFT_META[id].icon} {SHIFT_META[id].fr}
                  <small>{SHIFT_META[id].en}</small>
                </h2>
                <span className="fill-count">
                  {fill.done}/{fill.total}
                </span>
              </header>
              <ol>
                {DAYS.map((dayId) => {
                  const date = isoDate(
                    addDays(report.weekStart, DAY_META[dayId].offset),
                  );
                  const filled = orderHasContent(data.orders[dayId]);
                  const locked = orderIsLocked(data.orders[dayId]);
                  return (
                    <li key={dayId}>
                      <button
                        type="button"
                        className={locked ? "submitted" : filled ? "filled" : ""}
                        onClick={() => onOpen(id, "orders", dayId)}
                      >
                        <span>
                          {DAY_META[dayId].fr} / {DAY_META[dayId].en}
                          <small>{parseIso(date).toLocaleDateString("en-CA")}</small>
                        </span>
                        <em>
                          {locked
                            ? "Soumis / Submitted"
                            : filled
                              ? "Saisi / Filled"
                              : "Vide / Empty"}
                        </em>
                      </button>
                    </li>
                  );
                })}
                <li>
                  <button
                    type="button"
                    className={
                      meetingSubmittedCount(data.meeting) === DAYS.length
                        ? "submitted"
                        : meetingPageHasContent(data.meeting) ||
                            meetingSubmittedCount(data.meeting) > 0
                          ? "filled"
                          : ""
                    }
                    onClick={() => onOpen(id, "meeting")}
                  >
                    <span>Réunion quotidienne / Daily Meeting</span>
                    <em>
                      {meetingSubmittedCount(data.meeting) === DAYS.length
                        ? "Soumis / Submitted"
                        : meetingSubmittedCount(data.meeting) > 0
                          ? `${meetingSubmittedCount(data.meeting)}/${DAYS.length} soumis / submitted`
                          : meetingPageHasContent(data.meeting)
                            ? "Saisi / Filled"
                            : "Vide / Empty"}
                    </em>
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    className={
                      repaintSubmittedCount(data.repaint) === DAYS.length
                        ? "submitted"
                        : repaintSubmittedCount(data.repaint) > 0 ||
                            repaintPageHasContent(data.repaint)
                          ? "filled"
                          : ""
                    }
                    onClick={() => onOpen(id, "repaint")}
                  >
                    <span>Repeinture et matériel défectueux / Repaint &amp; Bad material</span>
                    <em>
                      {repaintSubmittedCount(data.repaint) === DAYS.length
                        ? "Soumis / Submitted"
                        : repaintSubmittedCount(data.repaint) > 0
                          ? `${repaintSubmittedCount(data.repaint)}/${DAYS.length} soumis / submitted`
                          : repaintPageHasContent(data.repaint)
                            ? "Saisi / Filled"
                            : "Vide / Empty"}
                    </em>
                  </button>
                </li>
              </ol>
            </section>
          );
        })}
      </div>
    </main>
  );
}
