/** Branded primitive — prevents mixing raw strings with typed IDs. */
declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

export type CompanyId     = Brand<string, 'CompanyId'>;
export type UserId        = Brand<string, 'UserId'>;
export type DepartmentId  = Brand<string, 'DepartmentId'>;
export type ToolId        = Brand<string, 'ToolId'>;
export type MessageId     = Brand<string, 'MessageId'>;
export type ChatId        = Brand<string, 'ChatId'>;
export type CorrelationId = Brand<string, 'CorrelationId'>;
export type TenantId      = Brand<string, 'TenantId'>;

/** Cast helpers — use only at system boundaries (webhook parsers, repos). */
export const asCompanyId     = (s: string): CompanyId     => s as CompanyId;
export const asUserId        = (s: string): UserId        => s as UserId;
export const asDepartmentId  = (s: string): DepartmentId  => s as DepartmentId;
export const asToolId        = (s: string): ToolId        => s as ToolId;
export const asMessageId     = (s: string): MessageId     => s as MessageId;
export const asChatId        = (s: string): ChatId        => s as ChatId;
export const asCorrelationId = (s: string): CorrelationId => s as CorrelationId;
export const asTenantId      = (s: string): TenantId      => s as TenantId;
