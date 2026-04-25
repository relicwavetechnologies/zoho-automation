export type ShareLabel = 'safe' | 'review' | 'critical';

const CRITICAL_PATTERNS = [
  /\bpayroll\b/i,
  /\bsalary\b/i,
  /\bssn\b/i,
  /\bsocial.?security/i,
  /\bpassport\b/i,
  /\bcredit.?card\b/i,
  /\bpersonal.?data\b/i,
  /\bpii\b/i,
  /\bmedical.?record\b/i,
  /\bpatient.?data\b/i,
  /\bconfidential\b/i,
  /\btop.?secret\b/i,
  /\bfinancial.?statement\b/i,
  /\bbalance.?sheet\b/i,
  /\bprofit.?loss\b/i,
  /\btax.?return\b/i,
  /\bbank.?statement\b/i,
  /\bpassword\b/i,
  /\bprivate.?key\b/i,
  /\bapi.?secret\b/i,
];

const REVIEW_PATTERNS = [
  /\bemployee\b/i,
  /\bperformance.?review\b/i,
  /\bhr\b/i,
  /\bhuman.?resources\b/i,
  /\bcontract\b/i,
  /\bnda\b/i,
  /\bnon.?disclosure\b/i,
  /\bpersonnel\b/i,
  /\bcustomer.?data\b/i,
  /\bpayment\b/i,
  /\binvoice\b/i,
  /\binternal.?only\b/i,
  /\bstrategic.?plan\b/i,
  /\bcompetitor\b/i,
  /\bunpublished\b/i,
  /\brecruitment\b/i,
  /\bcandidate\b/i,
  /\bpricing\b/i,
];

export function classifyForShare(input: {
  fileName: string;
  mimeType: string;
  sampleText?: string;
}): ShareLabel {
  const haystack = [input.fileName, input.sampleText ?? ''].join(' ');

  for (const pattern of CRITICAL_PATTERNS) {
    if (pattern.test(haystack)) return 'critical';
  }

  for (const pattern of REVIEW_PATTERNS) {
    if (pattern.test(haystack)) return 'review';
  }

  return 'safe';
}
