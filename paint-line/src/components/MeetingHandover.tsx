import {
  DAY_META,
  SHIFT_META,
  formatLong,
  meetingIsFilled,
  type MeetingDay,
} from "../model";
import {
  MEETING_TRIGGERS,
  formatDueDate,
  type DueMeeting,
} from "../meetingSchedule";
import { FormLockBar } from "./FormLockBar";
import { MeetingDayFields } from "./DailyMeetingForm";

export function MeetingHandover({
  due,
  value,
  loading,
  onChange,
  onSubmit,
  onExit,
}: {
  due: DueMeeting;
  value: MeetingDay | null;
  loading?: boolean;
  onChange: (next: Partial<MeetingDay>) => void;
  onSubmit: () => void;
  onExit: () => void;
}) {
  const when = formatLong(formatDueDate(due.weekStart, due.day));
  const time = MEETING_TRIGGERS[due.shift].label;
  const canSubmit = Boolean(value && meetingIsFilled(value));

  return (
    <div className="meeting-popup no-print" role="dialog" aria-modal="true">
      <div className={`meeting-popup-card shift-theme-${due.shift}`}>
        <header className={`meeting-popup-banner shift-${due.shift}`}>
          <div className="meeting-popup-banner-top">
            <p className="kicker">Transfert de quart / Shift change</p>
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
            Cette page reste ouverte jusqu&apos;à ce que la réunion soit
            remplie et envoyée ({time}).
            <br />
            This page stays open until the meeting is filled and submitted
            ({time}).
          </p>
        </header>

        {loading || !value ? (
          <p className="meeting-popup-loading">Chargement / Loading…</p>
        ) : (
          <article
            className={`paper-form meeting-form meeting-popup-form shift-${due.shift}`}
          >
            <p className="meeting-hint">
              Veuillez noter les sujets abordés lors du transfert de quart. /
              Please write down the topics that have been discussed during the
              shift transfer.
            </p>
            <MeetingDayFields
              shift={due.shift}
              day={due.day}
              value={value}
              onChange={onChange}
            />
            <p className="meeting-popup-need">
              {canSubmit
                ? "Vérifiez, puis envoyez pour fermer cette fenêtre. / Review, then submit to close this window."
                : "Remplissez les sujets ou les conclusions avant d'envoyer. / Fill in topics or conclusions before submitting."}
            </p>
            <FormLockBar
              locked={false}
              disabled={!canSubmit}
              onSubmit={onSubmit}
            />
          </article>
        )}
      </div>
    </div>
  );
}

