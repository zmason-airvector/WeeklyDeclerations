import {
  DAY_META,
  SHIFT_META,
  formatLong,
  repaintDayCanSubmit,
  type RepaintDay,
} from "../model";
import {
  REPAINT_TRIGGERS,
  formatDueDate,
  type DueSlot,
} from "../meetingSchedule";
import { RepaintDayFields, repaintSubmitHint } from "./RepaintForm";

export function RepaintHandover({
  due,
  value,
  loading,
  onChange,
  onSubmit,
  onExit,
}: {
  due: DueSlot;
  value: RepaintDay | null;
  loading?: boolean;
  onChange: (next: RepaintDay) => void;
  onSubmit: () => void;
  onExit: () => void;
}) {
  const when = formatLong(formatDueDate(due.weekStart, due.day));
  const time = REPAINT_TRIGGERS[due.shift].label;
  const canSubmit = Boolean(value && repaintDayCanSubmit(value));

  return (
    <div className="meeting-popup no-print" role="dialog" aria-modal="true">
      <div className={`meeting-popup-card shift-theme-${due.shift}`}>
        <header className={`meeting-popup-banner shift-${due.shift}`}>
          <div className="meeting-popup-banner-top">
            <p className="kicker">Fin de quart / End of shift</p>
            <button
              type="button"
              className="meeting-popup-exit"
              onClick={onExit}
            >
              Quitter / Exit
            </button>
          </div>
          <h2>
            {SHIFT_META[due.shift].icon} {SHIFT_META[due.shift].fr}{" "}
            <small>{SHIFT_META[due.shift].en}</small>
          </h2>
          <p>
            {DAY_META[due.day].fr} / {DAY_META[due.day].en} · {when}
            <br />
            Repeinture et matériel défectueux. Cette page s&apos;ouvre 30
            minutes avant la fin du quart et reste ouverte jusqu&apos;à ce que
            la déclaration soit remplie et envoyée ({time}).
            <br />
            Repaint and bad material. This page opens 30 minutes before the
            shift ends and stays open until the declaration is filled and
            submitted ({time}).
          </p>
        </header>

        {loading || !value ? (
          <p className="meeting-popup-loading">Chargement / Loading…</p>
        ) : (
          <article className={`paper-form repaint-form meeting-popup-form shift-${due.shift}`}>
            <RepaintDayFields day={due.day} value={value} onChange={onChange} />
            <p className="form-need">{repaintSubmitHint(value)}</p>
            <button
              type="button"
              className="submit-btn popup-submit"
              disabled={!canSubmit}
              onClick={onSubmit}
            >
              Envoyer / Submit
            </button>
          </article>
        )}
      </div>
    </div>
  );
}
