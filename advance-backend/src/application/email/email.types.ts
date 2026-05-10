export interface EmailAddress {
  readonly email: string;
  readonly name?: string;
}

export type DivoEmailTemplateVariant =
  | 'standard'
  | 'executive'
  | 'proposal'
  | 'follow_up'
  | 'report_delivery'
  | 'invoice_or_finance';

export interface DivoEmailSection {
  readonly heading?: string;
  readonly body: string;
  readonly bullets?: readonly string[];
}

export interface DivoEmailCta {
  readonly label: string;
  readonly url: string;
}

export interface DivoEmailTemplateData {
  readonly variant?: DivoEmailTemplateVariant;
  readonly preheader?: string;
  readonly eyebrow?: string;
  readonly title: string;
  readonly intro?: string;
  readonly sections?: readonly DivoEmailSection[];
  readonly cta?: DivoEmailCta;
  readonly metadata?: readonly { readonly label: string; readonly value: string }[];
  readonly signatureName?: string;
  readonly signatureTitle?: string;
  readonly footerNote?: string;
}

export interface RenderedEmailBody {
  readonly html: string;
  readonly text: string;
}

