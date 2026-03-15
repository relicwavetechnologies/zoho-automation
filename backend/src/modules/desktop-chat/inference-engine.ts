import type { BootstrapResult } from './orchestrator.types';

export interface InferredInputs {
  objective?: string;
  date_scope?: string;
  [key: string]: string | undefined;
}

export class InferenceEngine {
  infer(skillId: string, userMessage: string, bootstrap: BootstrapResult): InferredInputs {
    const inferred: InferredInputs = {};
    const msg = userMessage.toLowerCase();

    if (msg.includes('today')) {
      inferred.date_scope = new Date().toISOString().split('T')[0];
    } else if (msg.includes('yesterday')) {
      inferred.date_scope = this.daysAgo(1);
    } else if (msg.includes('this week')) {
      inferred.date_scope = 'this_week';
    }

    const skillNamePattern = new RegExp(`use\\s+${skillId}|run\\s+${skillId}|${skillId}\\s+for`, 'i');
    if (skillNamePattern.test(userMessage) || bootstrap.skillQuery?.toLowerCase() === skillId.toLowerCase()) {
      const scope = inferred.date_scope ? ` for ${inferred.date_scope}` : '';
      inferred.objective = `Run the ${skillId} workflow${scope}`;
    }

    return inferred;
  }

  private daysAgo(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().split('T')[0];
  }
}
