/**
 * Zoho CRM field registry — static, global, zero runtime cost.
 *
 * CRM field names are defined by Zoho's API and are consistent across orgs
 * (custom fields exist but are separate from standard fields).
 *
 * Mirrors zoho-books-schema.cache.ts pattern for script mode support.
 */

export interface ZohoCrmModuleSchema {
  readonly module:          string;
  readonly primaryAmount:   string;
  readonly primaryDate:     string;
  readonly primaryId:       string;
  readonly allAmountFields: readonly string[];
  readonly allDateFields:   readonly string[];
  readonly nameFields:      readonly string[];
  readonly statusField:     string | null;
  readonly ownerField:      string;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const REGISTRY: Record<string, ZohoCrmModuleSchema> = {
  Leads: {
    module:          'Leads',
    primaryAmount:   'Annual_Revenue',
    primaryDate:     'Created_Time',
    primaryId:       'id',
    allAmountFields: ['Annual_Revenue'],
    allDateFields:   ['Created_Time', 'Modified_Time'],
    nameFields:      ['First_Name', 'Last_Name', 'Full_Name', 'Email', 'Company'],
    statusField:     'Lead_Status',
    ownerField:      'Owner',
  },
  Contacts: {
    module:          'Contacts',
    primaryAmount:   'Annual_Revenue',
    primaryDate:     'Created_Time',
    primaryId:       'id',
    allAmountFields: [],
    allDateFields:   ['Created_Time', 'Modified_Time', 'Date_of_Birth'],
    nameFields:      ['First_Name', 'Last_Name', 'Full_Name', 'Email', 'Account_Name'],
    statusField:     null,
    ownerField:      'Owner',
  },
  Accounts: {
    module:          'Accounts',
    primaryAmount:   'Annual_Revenue',
    primaryDate:     'Created_Time',
    primaryId:       'id',
    allAmountFields: ['Annual_Revenue'],
    allDateFields:   ['Created_Time', 'Modified_Time'],
    nameFields:      ['Account_Name', 'Website', 'Phone'],
    statusField:     'Account_Type',
    ownerField:      'Owner',
  },
  Deals: {
    module:          'Deals',
    primaryAmount:   'Amount',
    primaryDate:     'Closing_Date',
    primaryId:       'id',
    allAmountFields: ['Amount'],
    allDateFields:   ['Closing_Date', 'Created_Time', 'Modified_Time'],
    nameFields:      ['Deal_Name', 'Account_Name', 'Contact_Name'],
    statusField:     'Stage',
    ownerField:      'Owner',
  },
  Tasks: {
    module:          'Tasks',
    primaryAmount:   'Duration',
    primaryDate:     'Due_Date',
    primaryId:       'id',
    allAmountFields: [],
    allDateFields:   ['Due_Date', 'Created_Time', 'Modified_Time', 'Closed_Time'],
    nameFields:      ['Subject', 'Who_Id', 'What_Id'],
    statusField:     'Status',
    ownerField:      'Owner',
  },
};

// ─── Public API ───────────────────────────────────────────────────────────────

export function getCrmModuleSchema(module: string): ZohoCrmModuleSchema {
  return REGISTRY[module] ?? {
    module,
    primaryAmount:   'Amount',
    primaryDate:     'Created_Time',
    primaryId:       'id',
    allAmountFields: ['Amount'],
    allDateFields:   ['Created_Time'],
    nameFields:      ['Name'],
    statusField:     'Status',
    ownerField:      'Owner',
  };
}

export function injectCrmSyntheticFields(
  items:  Array<Record<string, unknown>>,
  schema: ZohoCrmModuleSchema,
): Array<Record<string, unknown>> {
  return items.map(item => {
    const owner = item[schema.ownerField];
    const ownerName = owner && typeof owner === 'object' && !Array.isArray(owner)
      ? (owner as Record<string, unknown>)['name'] ?? ''
      : '';
    return {
      ...item,
      _amount: Number(item[schema.primaryAmount] ?? 0),
      _date:   String(item[schema.primaryDate] ?? ''),
      _id:     String(item[schema.primaryId] ?? ''),
      _status: String(item[schema.statusField ?? 'Status'] ?? ''),
      _owner:  String(ownerName),
    };
  });
}

export function toCrmSchemaHint(
  schema: ZohoCrmModuleSchema,
  sampleRecord?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    module:        schema.module,
    primaryAmount: `${schema.primaryAmount} -> item._amount`,
    primaryDate:   `${schema.primaryDate} -> item._date`,
    primaryId:     `${schema.primaryId} -> item._id`,
    statusField:   `${schema.statusField ?? 'Status'} -> item._status`,
    ownerField:    `${schema.ownerField} -> item._owner (resolved name)`,
    allAmountFields: schema.allAmountFields,
    allDateFields:   schema.allDateFields,
    nameFields:      schema.nameFields,
    syntheticFields: {
      _amount: 'primary amount field value',
      _date:   'primary date field value',
      _id:     'record ID',
      _status: 'record status/stage',
      _owner:  'record owner name (resolved from lookup)',
    },
    ...(sampleRecord ? { sampleFieldNames: Object.keys(sampleRecord).slice(0, 25) } : {}),
  };
}
