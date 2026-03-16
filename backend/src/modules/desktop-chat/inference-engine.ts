import type { BootstrapResult } from './orchestrator.types';

export interface InferredInputs {
  objective?: string;
  date_scope?: string;
  [key: string]: string | undefined;
}

const DEFAULT_TIME_ZONE = 'Asia/Kolkata';
const EXPLICIT_DATE_PATTERN = /\b(\d{4}-\d{2}-\d{2})\b/;

export class InferenceEngine {
  infer(skillId: string | null | undefined, userMessage: string, bootstrap: BootstrapResult): InferredInputs {
    const inferred: InferredInputs = {};
    const msg = userMessage.toLowerCase();

    const explicitDate = userMessage.match(EXPLICIT_DATE_PATTERN)?.[1];
    if (explicitDate) {
      inferred.date_scope = explicitDate;
    } else if (msg.includes('today')) {
      inferred.date_scope = this.localDateFromOffset(0);
    } else if (msg.includes('tomorrow')) {
      inferred.date_scope = this.localDateFromOffset(1);
    } else if (msg.includes('yesterday')) {
      inferred.date_scope = this.localDateFromOffset(-1);
    } else if (msg.includes('this week')) {
      inferred.date_scope = 'this_week';
    }

    if (!skillId) {
      return inferred;
    }

    const skillNamePattern = new RegExp(`use\\s+${skillId}|run\\s+${skillId}|${skillId}\\s+for`, 'i');
    if (skillNamePattern.test(userMessage)) {
      inferred.objective = bootstrap.summary?.trim() || userMessage.trim();
    }

    return inferred;
  }

  private localDateFromOffset(days: number): string {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + days);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: DEFAULT_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const year = parts.find((part) => part.type === 'year')?.value ?? '0000';
    const month = parts.find((part) => part.type === 'month')?.value ?? '00';
    const day = parts.find((part) => part.type === 'day')?.value ?? '00';
    return `${year}-${month}-${day}`;
  }
}
