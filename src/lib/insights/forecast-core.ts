/**
 * Deadline prediction (brief §29), without a model or a network: from how
 * fast each team has actually been clearing QA, and what is queued ahead.
 * Pure, so it is tested with plain numbers.
 *
 * For each team on a project:
 *   pace      — files that cleared final QA in the last WINDOW_DAYS, per day
 *   ahead     — the team's unfinished slots on live projects due no later
 *               than this one (earliest deadline first is how leads plan),
 *               this project's own included, plus slots promised but not yet
 *               created
 *   finish    — today + ahead ÷ pace
 * The project finishes when its slowest team does. It is "at risk" when that
 * lands after the deadline. With too little history there is no forecast,
 * rather than a confident guess.
 */
export const WINDOW_DAYS = 30;
export const MIN_HISTORY = 3;

export type ForecastStatus = 'done' | 'on_track' | 'at_risk' | 'no_history';

export interface TeamInput {
  departmentId: number;
  name: string;
  /** Unfinished slots on this project, plus planned slots not yet opened. */
  remaining: number;
  /** Unfinished slots queued ahead of and including this project's. */
  ahead: number;
  /** Approvals in the window. */
  approvedInWindow: number;
}

export interface TeamForecast extends TeamInput {
  perWeek: number;
  finish: string | null;
  status: ForecastStatus;
}

export interface ProjectForecast {
  finish: string | null;
  deadline: string | null;
  status: ForecastStatus;
  /** Positive when the forecast lands after the deadline. */
  daysLate: number | null;
  teams: TeamForecast[];
}

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function forecastProject(input: { today: string; deadline: string | null; teams: TeamInput[] }): ProjectForecast {
  const teams: TeamForecast[] = input.teams.map((t) => {
    const perDay = t.approvedInWindow / WINDOW_DAYS;
    const perWeek = Math.round(perDay * 7 * 10) / 10;
    if (t.remaining === 0) return { ...t, perWeek, finish: input.today, status: 'done' };
    if (t.approvedInWindow < MIN_HISTORY) return { ...t, perWeek, finish: null, status: 'no_history' };
    const finish = addDays(input.today, Math.ceil(Math.max(t.ahead, t.remaining) / perDay));
    const status: ForecastStatus = input.deadline && finish > input.deadline ? 'at_risk' : 'on_track';
    return { ...t, perWeek, finish, status };
  });

  const open = teams.filter((t) => t.status !== 'done');
  if (open.length === 0) return { finish: input.today, deadline: input.deadline, status: 'done', daysLate: null, teams };
  if (open.some((t) => t.status === 'no_history')) {
    return { finish: null, deadline: input.deadline, status: 'no_history', daysLate: null, teams };
  }
  const finish = open.map((t) => t.finish!).sort().at(-1)!;
  const daysLate = input.deadline ? daysBetween(input.deadline, finish) : null;
  return {
    finish, deadline: input.deadline, teams,
    status: daysLate !== null && daysLate > 0 ? 'at_risk' : 'on_track',
    daysLate: daysLate !== null && daysLate > 0 ? daysLate : null,
  };
}
