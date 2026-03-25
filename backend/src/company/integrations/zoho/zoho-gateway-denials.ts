const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

export type ZohoGatewayDeniedMessage = {
  summary: string;
  errorKind: 'permission' | 'missing_input' | 'unsupported' | 'api_failure';
  userAction?: string;
};

export const formatZohoGatewayDeniedMessage = (
  authResult: Record<string, unknown>,
  fallbackSummary: string,
): ZohoGatewayDeniedMessage => {
  const denialReason = asString(authResult.denialReason);
  const moduleName = asString(authResult.module);
  const principal = (
    typeof authResult.principal === 'object' && authResult.principal !== null && !Array.isArray(authResult.principal)
      ? authResult.principal as Record<string, unknown>
      : undefined
  );
  const requesterEmail = asString(principal?.normalizedRequesterEmail) ?? asString(principal?.requesterEmail);

  if (denialReason === 'books_principal_not_resolved') {
    return {
      summary: requesterEmail
        ? `No Zoho Books contact matched requester email ${requesterEmail}, so I cannot safely read ${moduleName ?? 'Zoho Books'} data in self-scoped mode.`
        : `No requester email was available to match a Zoho Books contact, so I cannot safely read ${moduleName ?? 'Zoho Books'} data in self-scoped mode.`,
      errorKind: 'missing_input',
      userAction: 'Please confirm the exact Zoho Books contact email, or tell me if you want company-scoped access instead.',
    };
  }

  if (denialReason === 'missing_requester_email') {
    return {
      summary: 'Requester email is missing, so self-scoped Zoho access cannot be resolved safely.',
      errorKind: 'missing_input',
      userAction: 'Please tell me which requester email I should use for self-scoped Zoho access.',
    };
  }

  if (denialReason === 'books_module_requires_company_scope') {
    return {
      summary: `${moduleName ?? 'This Zoho Books module'} requires company-scoped Zoho Books access and cannot be read in self-scoped mode.`,
      errorKind: 'permission',
      userAction: 'This Zoho Books module needs company-scoped access. If you want, I can continue once that access is available.',
    };
  }

  if (denialReason === 'record_not_in_self_scope' || denialReason === 'ownership_not_matched') {
    return {
      summary: `${moduleName ?? 'This Zoho record'} does not belong to the requester’s self-scoped Zoho access.`,
      errorKind: 'permission',
      userAction: 'That record is outside your self-scoped Zoho access. If you think it should be yours, tell me the correct contact, customer, or record reference.',
    };
  }

  if (denialReason === 'unsupported_books_module' || denialReason === 'unsupported_crm_module') {
    return {
      summary: fallbackSummary,
      errorKind: 'unsupported',
    };
  }

  return {
    summary: denialReason ?? fallbackSummary,
    errorKind: denialReason?.includes('unsupported') ? 'unsupported' : 'api_failure',
  };
};
