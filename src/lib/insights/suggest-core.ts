/**
 * Who should take this work (brief §29, task assignment)? A ranking, not a
 * decision: the Team Lead still chooses. Every suggestion says why, from
 * facts the lead can check. Pure, so the weighting is tested directly.
 *
 *   workload   — unfinished slots they hold now (fewer is better)
 *   first pass — share of their approved files never sent back, last 90 days
 *   on time    — share approved by the slot's due date, last 90 days
 *   the client — whether they have worked for this client before
 */
export interface Candidate {
  userId: number;
  name: string;
  openSlots: number;
  approved90: number;
  firstPass90: number;
  withDue90: number;
  onTime90: number;
  clientAssignments: number;
}

export interface Suggestion extends Candidate {
  score: number;
  reasons: string[];
}

const pct = (a: number, b: number) => Math.round((a / b) * 100);

export function rankCandidates(candidates: Candidate[]): Suggestion[] {
  return candidates.map((c) => {
    const reasons: string[] = [];
    let score = -c.openSlots;
    reasons.push(c.openSlots === 0 ? 'nothing open right now' : `${c.openSlots} slot${c.openSlots === 1 ? '' : 's'} open`);
    if (c.approved90 >= 3) {
      score += 3 * (c.firstPass90 / c.approved90);
      reasons.push(`${pct(c.firstPass90, c.approved90)}% passed QA first time`);
    }
    if (c.withDue90 >= 3) {
      score += 2 * (c.onTime90 / c.withDue90);
      reasons.push(`${pct(c.onTime90, c.withDue90)}% on time`);
    }
    if (c.clientAssignments > 0) {
      score += 1.5;
      reasons.push('has worked for this client before');
    }
    return { ...c, score: Math.round(score * 100) / 100, reasons };
  }).sort((a, b) => b.score - a.score || a.openSlots - b.openSlots || a.name.localeCompare(b.name));
}
