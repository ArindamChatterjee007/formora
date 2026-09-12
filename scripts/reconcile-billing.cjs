#!/usr/bin/env node
'use strict';

// Offline, read-only billing and metrics reconciliation.
// Authorized sanitized snapshot JSON in -> auditable JSON report on stdout.
// This tool never opens a network socket, never touches a database or payment
// provider, never writes a file, and never emits SQL or any other executable
// remediation. Unknown stays unknown; it is never reported as zero.

const fs = require('node:fs');
const { createHash } = require('node:crypto');

const SCHEMA_VERSION = '2.1.0';
const REPORT_KIND = 'formora.billing-reconciliation.report';
const CONTRACT_REF = 'office/billing-reconciliation-contract.json';
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 8 * 1024 * 1024;
// Snapshot identifiers are echoed into the report, so they are constrained to an
// opaque charset. A free-text identifier could carry a person's name or number.
const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

const SOURCE_KEYS = ['provider_purchases', 'provider_refunds', 'ledger_events', 'entitlements'];
const ACTIONS = ['none', 'preserve_no_change', 'manual_review', 'hold'];
const SEVERITIES = ['blocking', 'review', 'info'];
const BLOCK_SCOPES = ['derivation', 'eligibility', 'subjects'];
const ACCOUNT_CLASSES = ['member', 'founder', 'admin', 'test', 'free', 'unknown'];
// Internal, staff and quality-assurance accounts are never eligible customer actuals.
const INTERNAL_ACCOUNT_CLASSES = ['founder', 'admin', 'test'];
const EXTERNAL_ACCOUNT_CLASSES = ['member', 'free'];
// Skip reasons public.apply_billing_event records in supabase/billing-events.sql.
// The paid cursor it writes alongside them is GREATEST of the cursor already
// held and the provider timestamp of an applied paid event only, so a skipped
// event legitimately carries no cursor at all.
const LEDGER_SKIP_REASONS = ['reference_mismatch', 'out_of_order', 'cancellation_wins'];
// is_paid in that function: the statuses that move the paid cursor.
const SEMANTIC_PAID_STATUSES = ['active', 'trialing'];
// public.billing_event_receipts.input_digest is a NOT NULL sha256 bytea, so 32
// bytes. It binds the receipt key to the payload the database hashed over the
// subject, event type, provider timestamp, reference, tier, status, period end
// and raw body. It is compared as declared and never recomputed or invented.
const RECEIPT_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const IDENTITY_KINDS = ['uuid', 'email_slug', 'provider_customer', 'unknown'];
const BILLING_MODES = ['live', 'test', 'unknown'];
const PURCHASE_STATUSES = ['captured', 'authorized', 'failed', 'refunded', 'unknown'];
const REFUND_STATUSES = ['processed', 'pending', 'failed', 'unknown'];
const PRICE_CLASSES = ['nominal_offer', 'standard', 'other_or_unknown'];
const CHARGE_KINDS = ['one_off', 'subscription', 'renewal', 'unknown'];
const ENTITLEMENT_STATUSES = ['active', 'trialing', 'canceled', 'inactive', 'unknown'];
const TIERS = ['free', 'pro', 'elite', 'eliteplus', 'unknown'];
const GRANT_SOURCES = ['provider_purchase', 'manual', 'legacy', 'unknown'];
const AMOUNT_UNITS = ['minor', 'major'];
const REFUND_REFLECTION = ['refunds_reflected', 'refunds_not_reflected', 'unknown'];

// Every finding this tool can emit. Severity, suggested action and what the
// finding blocks are fixed here so the contract JSON and the report can never
// drift apart. `blocks` is the scope a finding withholds:
//   derivation  - every money value, including provider-side totals
//   eligibility - eligible-customer values only, provider-side totals survive
//   subjects    - the distinct paid subject count only
const FINDING_CODES = {
  source_missing: { severity: 'review', action: 'manual_review', blocks: ['derivation'], means: 'A reconciliation source was not supplied. Its facts are unknown, not zero.' },
  source_incomplete: { severity: 'review', action: 'manual_review', blocks: ['derivation'], means: 'A source did not declare a complete export through a stated watermark, or a page reported more rows.' },
  source_metadata_incomplete: { severity: 'review', action: 'manual_review', blocks: ['derivation'], means: 'A snapshot file did not declare its own currency, amount unit, refund reflection or watermark. Metadata is never inherited from another file.' },
  source_metadata_conflict: { severity: 'blocking', action: 'hold', blocks: ['derivation'], means: 'Two snapshot files declared different currency, amount unit or refund reflection for the same source.' },
  source_amount_unit_unsupported: { severity: 'review', action: 'manual_review', blocks: ['derivation'], means: 'Amounts were declared in major units. Only integer minor units are reconciled, to avoid rounding invention.' },
  source_watermark_in_future: { severity: 'review', action: 'manual_review', blocks: ['derivation'], means: 'A snapshot file declared a data watermark later than the report run time. Coverage of a period that has not happened is not a fact and is not accepted.' },
  purchases_already_net_of_refunds: { severity: 'review', action: 'manual_review', blocks: ['derivation'], means: 'Purchase amounts were declared already net of refunds while a refund source was also supplied; subtracting again would double count.' },
  record_beyond_source_watermark: { severity: 'review', action: 'manual_review', blocks: ['derivation'], means: 'A record is dated after the common watermark covered by every supplied file for its source, so coverage beyond that cutoff is unknown.' },
  record_beyond_reconciliation_coverage: { severity: 'review', action: 'manual_review', blocks: ['derivation'], means: 'A record is dated after the coverage every supplied source shares, or after the report run time, so no other source is known to cover it and a value derived from it would rest on one source alone.' },
  duplicate_purchase_record: { severity: 'info', action: 'none', blocks: [], means: 'The same provider charge reference appeared more than once with identical values and was collapsed to one charge.' },
  duplicate_purchase_conflict: { severity: 'blocking', action: 'hold', blocks: ['derivation'], means: 'The same provider charge reference appeared with a differing semantic record. Every declared purchase field is compared and the comparison does not depend on the order the files were supplied.' },
  purchase_missing_reference: { severity: 'blocking', action: 'manual_review', blocks: ['derivation'], means: 'A purchase record carried no provider charge reference, so it cannot be deduplicated or matched.' },
  purchase_missing_occurred_at: { severity: 'review', action: 'manual_review', blocks: ['derivation'], means: 'A purchase carried no provider timestamp. No timestamp is inferred.' },
  purchase_amount_invalid: { severity: 'blocking', action: 'hold', blocks: ['derivation'], means: 'A purchase amount was absent or not a non-negative integer in minor units.' },
  purchase_currency_mismatch: { severity: 'blocking', action: 'hold', blocks: ['derivation'], means: 'A purchase currency disagreed with the currency declared for its source.' },
  purchase_non_captured_status: { severity: 'info', action: 'none', blocks: [], means: 'A purchase declared a terminal failed status and is excluded from receipts. This is a known exclusion, not an unknown.' },
  purchase_unknown_status: { severity: 'review', action: 'manual_review', blocks: ['derivation'], means: 'A purchase declared an authorized or unknown status. It is neither counted nor dismissed, and it is never treated as zero.' },
  purchase_test_mode: { severity: 'info', action: 'none', blocks: [], means: 'A test or sandbox charge was excluded from customer receipts.' },
  purchase_unknown_mode: { severity: 'review', action: 'manual_review', blocks: ['derivation'], means: 'A charge did not declare live or test mode, so it cannot be counted or dismissed.' },
  purchase_not_eligible_customer: { severity: 'info', action: 'none', blocks: [], means: 'A live charge belongs to an internal, staff or quality-assurance account, or to a subject declared unverified. It is excluded from eligible customer values and reported only in the provider-side total.' },
  purchase_eligibility_unknown: { severity: 'review', action: 'manual_review', blocks: ['eligibility'], means: 'A live charge did not declare an account class or a verification state, so whether it is an eligible customer receipt is unknown.' },
  subject_eligibility_contradiction: { severity: 'review', action: 'manual_review', blocks: ['eligibility'], means: 'Sources disagree about whether one typed subject is an eligible customer: an internal, staff, quality-assurance or unverified declaration in one source stands against an external verified declaration in another. Charges for that subject are excluded from eligible customer values and those values are withheld, while the provider-side total remains a complete fact about the snapshot.' },
  purchase_refund_flag_without_refund_record: { severity: 'review', action: 'manual_review', blocks: ['derivation'], means: 'A purchase was flagged refunded by the provider but no matching refund receipt was supplied.' },
  purchase_price_class_unknown: { severity: 'review', action: 'manual_review', blocks: [], means: 'A charge did not declare whether it was a nominal offer or a standard price. Its amount is reported in a visible unclassified bucket and is never folded silently into either priced bucket.' },
  nominal_offer_charge: { severity: 'info', action: 'preserve_no_change', blocks: [], means: 'A nominal launch-offer charge was recognized at its actual amount and is reported separately from standard-price charges.' },
  duplicate_refund_record: { severity: 'info', action: 'none', blocks: [], means: 'The same refund reference appeared more than once with identical values and was collapsed to one refund.' },
  duplicate_refund_conflict: { severity: 'blocking', action: 'hold', blocks: ['derivation'], means: 'The same refund reference appeared with a differing semantic record, compared across every declared refund field and independently of file order.' },
  refund_missing_reference: { severity: 'blocking', action: 'manual_review', blocks: ['derivation'], means: 'A refund record carried no refund reference, so it cannot be deduplicated and is never subtracted.' },
  refund_unmatched: { severity: 'blocking', action: 'manual_review', blocks: ['derivation'], means: 'A refund carried no usable link to a charge in the supplied purchase source.' },
  refund_reference_mismatch: { severity: 'blocking', action: 'hold', blocks: ['derivation'], means: 'A refund named an explicit charge reference that is absent from the purchase source. An order reference is never used as a fallback for an explicit charge reference that failed to resolve.' },
  refund_reference_contradiction: { severity: 'blocking', action: 'hold', blocks: ['derivation'], means: 'A refund declared both a charge reference and an order reference and the two do not name the same charge. Every reference a refund declares is checked; a correct one never excuses another that disagrees.' },
  refund_not_provider_verified: { severity: 'review', action: 'manual_review', blocks: ['derivation'], means: 'A refund was declared as not verified against the provider record, so it is never subtracted. This verification is about the refund receipt and is read independently of whether the paying account is verified.' },
  refund_verification_undeclared: { severity: 'review', action: 'manual_review', blocks: ['derivation'], means: 'A refund did not declare whether it was verified against the provider record, so whether value was returned is unknown and it is never subtracted. This verification is about the refund receipt and is read independently of whether the paying account is verified.' },
  refund_reference_ambiguous: { severity: 'blocking', action: 'hold', blocks: ['derivation'], means: 'A refund matched more than one charge through a shared order reference.' },
  refund_exceeds_purchase: { severity: 'blocking', action: 'hold', blocks: ['derivation'], means: 'Processed refunds for one charge exceeded the charged amount.' },
  refund_pending_or_unknown: { severity: 'review', action: 'manual_review', blocks: ['derivation'], means: 'A refund was requested, pending or unknown. It is not treated as money returned.' },
  refund_zero_amount: { severity: 'review', action: 'manual_review', blocks: [], means: 'A processed refund carried a zero amount. It returns no value and never marks its charge refunded.' },
  refund_currency_mismatch: { severity: 'blocking', action: 'hold', blocks: ['derivation'], means: 'A refund currency disagreed with the charge currency or with the currency declared for its own source.' },
  refund_mode_mismatch: { severity: 'blocking', action: 'hold', blocks: ['derivation'], means: 'A refund declared a different mode from the charge it names, or either side did not declare one. A test or unknown-mode refund is never subtracted from a live charge.' },
  refund_timestamp_contradiction: { severity: 'blocking', action: 'hold', blocks: ['derivation'], means: 'A refund is dated before the charge it names, or carries no timestamp while its charge is timestamped.' },
  duplicate_ledger_event: { severity: 'info', action: 'none', blocks: [], means: 'The same provider event identifier appeared more than once with an identical record and was collapsed, matching the database receipt key.' },
  ledger_event_conflict: { severity: 'blocking', action: 'hold', blocks: ['derivation'], means: 'The same provider event identifier bound a differing semantic record. Every declared event field, including the input digest, the applied flag, reason, status, tier and cursor, is compared independently of file order.' },
  ledger_event_missing_id: { severity: 'blocking', action: 'manual_review', blocks: ['derivation'], means: 'A ledger event carried no event identifier. Without the receipt key it cannot be deduplicated, and it is counted as unusable rather than dropped from the report.' },
  ledger_receipt_evidence_missing: { severity: 'review', action: 'manual_review', blocks: ['derivation'], means: 'A ledger event did not carry the receipt evidence the database records: the provider timestamp, the arrival timestamp, the input digest that binds the event identifier to its payload, the applied flag, the skip reason when it was not applied, or the paid cursor when a paid event was applied.' },
  ledger_receipt_cursor_contradiction: { severity: 'blocking', action: 'hold', blocks: ['derivation'], means: 'An applied paid ledger event declares a paid cursor earlier than its own provider timestamp. The database writes that cursor as the greatest of the cursor already held and this event\'s provider timestamp, so the pair as declared is not an outcome the database can have recorded. The whole derivation is withheld rather than resting on a receipt that contradicts itself.' },
  ledger_receipt_reason_contradiction: { severity: 'blocking', action: 'hold', blocks: ['derivation'], means: 'A ledger event declares an applied flag and skip reason the database never records together: a reason on an applied event, which the database writes only alongside a skip, or a skipped event naming a reason outside the fixed set the database function records. The recorded outcome cannot be reproduced, so the whole derivation is withheld.' },
  ledger_ordering_indeterminate: { severity: 'review', action: 'manual_review', blocks: ['derivation'], means: 'Ledger events for one subject lack the provider and arrival timestamps needed to order them, or state one arrival instant twice under different spellings, so arrival order cannot be determined and is never assumed.' },
  ledger_out_of_order: { severity: 'review', action: 'manual_review', blocks: [], means: 'A ledger event arrived after another event for the same subject and reference while carrying an earlier provider timestamp.' },
  ledger_cursor_regression: { severity: 'review', action: 'manual_review', blocks: ['derivation'], means: 'An applied ledger event carries a provider timestamp earlier than the paid cursor an earlier-arriving event already established for its subject. That cursor is held per subject across every reference and provider, so the database ordering guard would have skipped this event instead of applying it.' },
  ledger_event_without_provider_record: { severity: 'review', action: 'manual_review', blocks: ['derivation'], means: 'A charge-shaped ledger event has no matching provider purchase in the snapshot.' },
  purchase_without_ledger_event: { severity: 'review', action: 'manual_review', blocks: ['derivation'], means: 'A provider charge has no matching database ledger event.' },
  purchase_without_entitlement: { severity: 'review', action: 'manual_review', blocks: [], means: 'A captured live charge has no matching entitlement row for the same typed subject key.' },
  paid_grant_without_purchase: { severity: 'review', action: 'manual_review', blocks: [], means: 'A paid entitlement exists with no captured, unrefunded charge for the same typed subject key in the snapshot.' },
  grant_reference_unresolved: { severity: 'review', action: 'manual_review', blocks: [], means: 'An entitlement named a provider reference that is absent from the supplied purchase source, so the charge behind that access is not in the snapshot. A different charge belonging to the same subject is never read as support for the reference the grant declared, a subscription term is never inferred, and access is never revoked or altered.' },
  grant_reference_subject_mismatch: { severity: 'blocking', action: 'hold', blocks: ['derivation'], means: 'An entitlement named a provider reference that resolves to a charge belonging to a different subject key. A shared reference never establishes that the same person paid.' },
  entitlement_without_identity: { severity: 'blocking', action: 'hold', blocks: ['derivation'], means: 'An entitlement carried no subject key or no declared identity kind. It cannot be matched to any charge and is held for manual review rather than silently ignored.' },
  manual_or_legacy_grant: { severity: 'review', action: 'manual_review', blocks: [], means: 'An entitlement was recorded as a manual or legacy grant rather than a provider purchase.' },
  revoked_grant_with_unrefunded_purchase: { severity: 'blocking', action: 'hold', blocks: ['derivation'], means: 'Access was revoked or ended while a captured charge for that subject retains unrefunded value. A partial or zero refund does not clear this hold.' },
  legacy_null_expiry_access: { severity: 'info', action: 'preserve_no_change', blocks: [], means: 'Paid access with no period end is preserved as recorded. No renewal term or expiry is inferred.' },
  ambiguous_identity: { severity: 'review', action: 'manual_review', blocks: ['subjects'], means: 'A subject key could not be resolved across sources, or was declared with conflicting classes. Identities are never merged automatically.' },
  identity_value_reused_across_kinds: { severity: 'review', action: 'manual_review', blocks: ['subjects'], means: 'The same raw identifier value appeared under more than one identity kind, for example an account UUID and a legacy email-derived key. Typed keys are kept separate and are never merged automatically.' },
  amount_total_out_of_safe_range: { severity: 'blocking', action: 'hold', blocks: ['derivation'], means: 'An exact integer total exceeded the range this tool can report without loss. Totals are accumulated exactly and a lossy value is never emitted.' }
};

// Values the tool refuses to emit, so a snapshot, a filename or an operator
// message cannot leak credentials or raw account data into an auditable artifact.
const HASH_REF_PATTERN = /^sha256:[0-9a-f]+$/;
const REDACTION_PATTERNS = [
  { name: 'email_address', test: value => /[^\s@]+@[^\s@]+/.test(value) },
  { name: 'provider_key', test: value => /\b(?:rzp|sk|pk)_(?:live|test)_[A-Za-z0-9]/i.test(value) },
  { name: 'jwt_like', test: value => /\beyJ[A-Za-z0-9_-]{12,}/.test(value) },
  { name: 'private_key_block', test: value => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) },
  { name: 'service_credential', test: value => /service[_-]role[_-]?key/i.test(value) },
  { name: 'phone_like', test: value => !HASH_REF_PATTERN.test(value) && (value.match(/\+?\d[\d\s().-]{7,}\d/g) || []).some(run => run.replace(/\D/g, '').length >= 9) }
];

class ReconcileError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ReconcileError';
    this.code = code;
    this.detail = detail === undefined ? null : detail;
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function fail(code, message, detail) {
  throw new ReconcileError(code, message, detail);
}

function readString(value, where, { required = false, maxLength = 512 } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('malformed_field', `${where} is required`);
    return null;
  }
  if (typeof value !== 'string' || !value.length || value.length > maxLength) fail('malformed_field', `${where} must be a non-empty string of at most ${maxLength} characters`);
  return value;
}

function readEnum(value, allowed, where, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value)) fail('malformed_field', `${where} must be one of ${allowed.join(', ')}`);
  return value;
}

function readBool(value, where) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') fail('malformed_field', `${where} must be a boolean or null`);
  return value;
}

function readTimestamp(value, where) {
  if (value === undefined || value === null) return null;
  if (!isIsoTimestamp(value)) fail('malformed_field', `${where} must be an ISO-8601 timestamp or null`);
  return value;
}

function readMinorAmount(value, where) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('malformed_field', `${where} must be a non-negative integer in minor units`);
  return value;
}

function readCurrency(value, where) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) fail('malformed_field', `${where} must be an ISO-4217 alphabetic code`);
  return value;
}

function readReceiptDigest(value, where) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !RECEIPT_DIGEST_PATTERN.test(value)) fail('malformed_field', `${where} must be the 32-byte receipt digest written as 64 lowercase hexadecimal characters`);
  return value;
}

function hashRef(kind, value) {
  return 'sha256:' + createHash('sha256').update(`${kind}\u0000${value}`).digest('hex').slice(0, 16);
}

function digestOf(text) {
  return 'sha256:' + createHash('sha256').update(text).digest('hex');
}

function parseSource(key, raw, label) {
  if (!isPlainObject(raw)) fail('malformed_source', `sources.${key} in ${label} must be an object`);
  if (!Array.isArray(raw.records)) fail('malformed_source', `sources.${key}.records in ${label} must be an array`);
  let page = null;
  if (raw.page !== undefined && raw.page !== null) {
    if (!isPlainObject(raw.page)) fail('malformed_source', `sources.${key}.page in ${label} must be an object or null`);
    page = {
      index: Number.isSafeInteger(raw.page.index) && raw.page.index >= 0 ? raw.page.index : fail('malformed_source', `sources.${key}.page.index in ${label} must be a non-negative integer`),
      has_more: readBool(raw.page.has_more, `sources.${key}.page.has_more`)
    };
  }
  const descriptor = {
    label,
    complete: raw.complete === undefined ? null : readBool(raw.complete, `sources.${key}.complete`),
    complete_declared: raw.complete !== undefined && raw.complete !== null,
    as_of: readTimestamp(raw.as_of, `sources.${key}.as_of`),
    currency: readCurrency(raw.currency, `sources.${key}.currency`),
    amount_unit: readEnum(raw.amount_unit, AMOUNT_UNITS, `sources.${key}.amount_unit`, null),
    refund_status: readEnum(raw.refund_status, REFUND_REFLECTION, `sources.${key}.refund_status`, null),
    page,
    records: raw.records.map((record, index) => parseRecord(key, record, `${label}:sources.${key}.records[${index}]`, label))
  };
  return descriptor;
}

function parseRecord(key, record, where, label) {
  if (!isPlainObject(record)) fail('malformed_record', `${where} must be an object`);
  const base = { origin: label, where };
  if (key === 'provider_purchases') {
    return Object.assign(base, {
      provider: readString(record.provider, `${where}.provider`, { required: true, maxLength: 64 }),
      payment_ref: readString(record.payment_ref, `${where}.payment_ref`),
      order_ref: readString(record.order_ref, `${where}.order_ref`),
      subject_ref: readString(record.subject_ref, `${where}.subject_ref`),
      identity_kind: readEnum(record.identity_kind, IDENTITY_KINDS, `${where}.identity_kind`, 'unknown'),
      account_class: readEnum(record.account_class, ACCOUNT_CLASSES, `${where}.account_class`, 'unknown'),
      occurred_at: readTimestamp(record.occurred_at, `${where}.occurred_at`),
      amount_minor: readMinorAmount(record.amount_minor, `${where}.amount_minor`),
      currency: readCurrency(record.currency, `${where}.currency`),
      status: readEnum(record.status, PURCHASE_STATUSES, `${where}.status`, 'unknown'),
      mode: readEnum(record.mode, BILLING_MODES, `${where}.mode`, 'unknown'),
      tier: readEnum(record.tier, TIERS, `${where}.tier`, 'unknown'),
      charge_kind: readEnum(record.charge_kind, CHARGE_KINDS, `${where}.charge_kind`, 'unknown'),
      price_class: readEnum(record.price_class, PRICE_CLASSES, `${where}.price_class`, 'other_or_unknown'),
      price_class_declared: record.price_class !== undefined && record.price_class !== null,
      verified: readBool(record.verified, `${where}.verified`)
    });
  }
  if (key === 'provider_refunds') {
    return Object.assign(base, {
      provider: readString(record.provider, `${where}.provider`, { required: true, maxLength: 64 }),
      refund_ref: readString(record.refund_ref, `${where}.refund_ref`),
      payment_ref: readString(record.payment_ref, `${where}.payment_ref`),
      order_ref: readString(record.order_ref, `${where}.order_ref`),
      occurred_at: readTimestamp(record.occurred_at, `${where}.occurred_at`),
      amount_minor: readMinorAmount(record.amount_minor, `${where}.amount_minor`),
      currency: readCurrency(record.currency, `${where}.currency`),
      status: readEnum(record.status, REFUND_STATUSES, `${where}.status`, 'unknown'),
      mode: readEnum(record.mode, BILLING_MODES, `${where}.mode`, 'unknown'),
      verified: readBool(record.verified, `${where}.verified`)
    });
  }
  if (key === 'ledger_events') {
    return Object.assign(base, {
      provider: readString(record.provider, `${where}.provider`, { required: true, maxLength: 64 }),
      event_id: readString(record.event_id, `${where}.event_id`),
      event_type: readString(record.event_type, `${where}.event_type`, { maxLength: 128 }),
      subject_ref: readString(record.subject_ref, `${where}.subject_ref`),
      identity_kind: readEnum(record.identity_kind, IDENTITY_KINDS, `${where}.identity_kind`, 'unknown'),
      occurred_at: readTimestamp(record.occurred_at, `${where}.occurred_at`),
      received_at: readTimestamp(record.received_at, `${where}.received_at`),
      paid_cursor_at: readTimestamp(record.paid_cursor_at, `${where}.paid_cursor_at`),
      input_digest: readReceiptDigest(record.input_digest, `${where}.input_digest`),
      reference: readString(record.reference, `${where}.reference`),
      payment_ref: readString(record.payment_ref, `${where}.payment_ref`),
      tier: readEnum(record.tier, TIERS, `${where}.tier`, 'unknown'),
      status: readEnum(record.status, ENTITLEMENT_STATUSES, `${where}.status`, 'unknown'),
      applied: readBool(record.applied, `${where}.applied`),
      reason: readString(record.reason, `${where}.reason`, { maxLength: 128 }),
      expects_provider_charge: readBool(record.expects_provider_charge, `${where}.expects_provider_charge`)
    });
  }
  return Object.assign(base, {
    subject_ref: readString(record.subject_ref, `${where}.subject_ref`),
    identity_kind: readEnum(record.identity_kind, IDENTITY_KINDS, `${where}.identity_kind`, 'unknown'),
    account_class: readEnum(record.account_class, ACCOUNT_CLASSES, `${where}.account_class`, 'unknown'),
    tier: readEnum(record.tier, TIERS, `${where}.tier`, 'unknown'),
    status: readEnum(record.status, ENTITLEMENT_STATUSES, `${where}.status`, 'unknown'),
    provider: readString(record.provider, `${where}.provider`, { maxLength: 64 }),
    reference: readString(record.reference, `${where}.reference`),
    current_period_end: readTimestamp(record.current_period_end, `${where}.current_period_end`),
    period_end_declared: Object.prototype.hasOwnProperty.call(record, 'current_period_end'),
    updated_at: readTimestamp(record.updated_at, `${where}.updated_at`),
    grant_source: readEnum(record.grant_source, GRANT_SOURCES, `${where}.grant_source`, 'unknown'),
    revoked: readBool(record.revoked, `${where}.revoked`),
    verified: readBool(record.verified, `${where}.verified`)
  });
}

function parseDocument(document, index) {
  // The caller's filename is never used as a label: a filename can carry a
  // person's name or number and labels are echoed into the report and errors.
  const label = `document_${index + 1}`;
  const data = document.data;
  if (!isPlainObject(data)) fail('malformed_document', `${label} must contain a JSON object`);
  const snapshotId = readString(data.snapshot_id, `${label}.snapshot_id`, { required: true, maxLength: 64 });
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) fail('malformed_field', `${label}.snapshot_id must match ${SNAPSHOT_ID_PATTERN.source}; free-text identifiers are refused because the value is echoed into the report`);
  const generatedAt = readTimestamp(data.generated_at, `${label}.generated_at`);
  if (!isPlainObject(data.sources)) fail('malformed_document', `${label}.sources must be an object`);
  const unknownSources = Object.keys(data.sources).filter(key => !SOURCE_KEYS.includes(key));
  if (unknownSources.length) fail('unknown_source', `${label}.sources contains unsupported keys: ${unknownSources.join(', ')}`);
  const sources = {};
  for (const key of SOURCE_KEYS) {
    if (data.sources[key] === undefined || data.sources[key] === null) continue;
    sources[key] = parseSource(key, data.sources[key], label);
  }
  const text = typeof document.text === 'string' ? document.text : JSON.stringify(data);
  return { label, position: index + 1, snapshot_id: snapshotId, generated_at: generatedAt, sources, digest: digestOf(text) };
}

// Metadata each supplied file must declare for itself. A file that omits one of
// these never inherits the value from another file in the same run.
const SOURCE_METADATA_REQUIREMENTS = {
  provider_purchases: ['as_of', 'currency', 'amount_unit', 'refund_status'],
  provider_refunds: ['as_of', 'currency', 'amount_unit'],
  ledger_events: ['as_of'],
  entitlements: ['as_of']
};

// The timestamp that decides whether a record falls inside the covered window.
const SOURCE_COVERAGE_FIELDS = {
  provider_purchases: ['occurred_at'],
  provider_refunds: ['occurred_at'],
  ledger_events: ['occurred_at', 'received_at'],
  entitlements: ['updated_at']
};

function mergeSource(key, descriptors, addFinding, nowMs) {
  if (!descriptors.length) {
    addFinding('source_missing', { detail: `No ${key} source was supplied.`, data: { source: key } });
    return { present: false, complete: null, as_of: null, currency: null, amount_unit: null, refund_status: null, record_count: 0, records: [], usable_for_actuals: false, reasons: ['source_not_provided'], files: 0, records_beyond_watermark: 0, records_beyond_coverage: 0 };
  }
  const reasons = new Set();
  const merged = { present: true, complete: true, as_of: null, currency: null, amount_unit: null, refund_status: null, records: [] };
  const declared = { currency: new Set(), amount_unit: new Set(), refund_status: new Set() };
  // A value one file declared is never carried over to a file that stayed
  // silent, in the merged view any more than in the per-file check.
  const declaredByEveryFile = { currency: true, amount_unit: true, refund_status: true };
  let watermarkDeclaredByEveryFile = true;

  for (const descriptor of descriptors) {
    const missing = SOURCE_METADATA_REQUIREMENTS[key].filter(field => descriptor[field] === null);
    if (!descriptor.complete_declared) missing.push('complete');
    if (missing.length) {
      const fields = missing.slice().sort();
      addFinding('source_metadata_incomplete', { detail: `A snapshot file supplied ${key} without declaring ${fields.join(', ')} for itself. Metadata declared by another file is never inherited.`, data: { source: key, undeclared: fields } });
      for (const field of fields) reasons.add(`source_${field}_not_declared_per_file`);
    }
    for (const field of ['currency', 'amount_unit', 'refund_status']) {
      if (descriptor[field] !== null) declared[field].add(descriptor[field]);
      else declaredByEveryFile[field] = false;
    }
    if (descriptor.complete !== true) merged.complete = descriptor.complete === false ? false : null;
    if (descriptor.page && descriptor.page.has_more === true) merged.complete = false;
    if (descriptor.as_of === null) watermarkDeclaredByEveryFile = false;
    else {
      // A watermark cannot cover a period that has not happened yet.
      if (Date.parse(descriptor.as_of) > nowMs) {
        addFinding('source_watermark_in_future', { detail: `A snapshot file declared a ${key} watermark later than the report run time.`, data: { source: key, as_of: descriptor.as_of } });
        reasons.add('source_watermark_in_future');
      }
      // The covered window is the earliest watermark any file declared. Anything
      // later is outside at least one file's coverage.
      if (!merged.as_of || Date.parse(descriptor.as_of) < Date.parse(merged.as_of)) merged.as_of = descriptor.as_of;
    }
    merged.records.push(...descriptor.records);
  }

  let conflict = false;
  for (const field of ['currency', 'amount_unit', 'refund_status']) {
    if (declared[field].size > 1) conflict = true;
    else if (declared[field].size === 1 && declaredByEveryFile[field]) merged[field] = [...declared[field]][0];
  }
  if (conflict) {
    addFinding('source_metadata_conflict', { detail: `Snapshot files declared different currency, amount unit or refund reflection for ${key}.`, data: { source: key } });
    reasons.add('source_metadata_conflict');
  }
  if (merged.complete !== true) {
    addFinding('source_incomplete', { detail: `The ${key} source is not declared complete through a stated watermark.`, data: { source: key, complete: merged.complete } });
    reasons.add(merged.complete === false ? 'source_declared_incomplete' : 'source_completeness_unknown');
  }
  if (!merged.as_of || !watermarkDeclaredByEveryFile) reasons.add('source_as_of_missing');
  if (merged.currency === null && key !== 'entitlements' && key !== 'ledger_events') reasons.add('source_currency_missing');
  if (key === 'provider_purchases' || key === 'provider_refunds') {
    if (merged.amount_unit === null) reasons.add('source_amount_unit_missing');
    else if (merged.amount_unit !== 'minor') {
      addFinding('source_amount_unit_unsupported', { detail: `The ${key} source declared major units.`, data: { source: key } });
      reasons.add('source_amount_unit_unsupported');
    }
    if (merged.refund_status === null || merged.refund_status === 'unknown') reasons.add('source_refund_status_unknown');
  }

  let beyond = 0;
  if (merged.as_of && watermarkDeclaredByEveryFile) {
    const cutoff = Date.parse(merged.as_of);
    for (const record of merged.records) {
      const stamps = SOURCE_COVERAGE_FIELDS[key].map(field => record[field]).filter(Boolean);
      if (stamps.some(stamp => Date.parse(stamp) > cutoff)) beyond += 1;
    }
    if (beyond) {
      addFinding('record_beyond_source_watermark', { detail: `The ${key} source carries ${beyond} record or records dated after the common watermark ${merged.as_of} covered by every supplied file, so coverage past that cutoff is unknown.`, data: { source: key, as_of: merged.as_of, records_beyond_watermark: beyond } });
      reasons.add('records_beyond_common_watermark');
    }
  }

  merged.record_count = merged.records.length;
  merged.files = descriptors.length;
  merged.records_beyond_watermark = beyond;
  merged.records_beyond_coverage = 0;
  merged.reasons = [...reasons].sort();
  merged.usable_for_actuals = merged.reasons.length === 0;
  return merged;
}

// Validating each source against its own watermark is not enough. A charge
// inside the purchase export can still sit past the end of the refund export,
// and a value derived from it would rest on one source alone.
function applyCrossSourceCoverage(sources, now, addFinding) {
  const nowMs = Date.parse(now);
  let cutoff = nowMs;
  let limitedBy = 'report_run_time';
  for (const key of SOURCE_KEYS) {
    const source = sources[key];
    if (!source.present || !source.as_of || source.reasons.includes('source_as_of_missing')) continue;
    const declared = Date.parse(source.as_of);
    if (declared < cutoff) {
      cutoff = declared;
      limitedBy = key;
    }
  }
  const cutoffIso = new Date(cutoff).toISOString();
  for (const key of SOURCE_KEYS) {
    const source = sources[key];
    if (!source.present) continue;
    const ownCutoff = source.as_of && !source.reasons.includes('source_as_of_missing') ? Date.parse(source.as_of) : null;
    let beyond = 0;
    for (const record of source.records) {
      const stamps = SOURCE_COVERAGE_FIELDS[key].map(field => record[field]).filter(Boolean).map(stamp => Date.parse(stamp));
      if (!stamps.some(stamp => stamp > cutoff)) continue;
      // Already reported against this source's own watermark; not counted twice.
      if (ownCutoff !== null && stamps.some(stamp => stamp > ownCutoff)) continue;
      beyond += 1;
    }
    source.records_beyond_coverage = beyond;
    if (!beyond) continue;
    addFinding('record_beyond_reconciliation_coverage', {
      detail: `The ${key} source carries ${beyond} record or records dated after ${cutoffIso}, the coverage every supplied source shares, so no other source is known to cover them.`,
      data: { source: key, coverage_as_of: cutoffIso, coverage_limited_by: limitedBy, records_beyond_coverage: beyond }
    });
    source.reasons = [...new Set(source.reasons.concat('records_beyond_reconciliation_coverage'))].sort();
    source.usable_for_actuals = false;
  }
  return { as_of: cutoffIso, limited_by: limitedBy };
}

// A subject is only ever addressed by its declared kind together with its
// value. Two sources that reuse one value under different kinds stay separate.
function subjectKeyOf(record) {
  if (!record || !record.subject_ref) return null;
  const kind = record.identity_kind || 'unknown';
  if (kind === 'unknown') return null;
  return `${kind}\u0000${record.subject_ref}`;
}

function subjectRefHash(kind, ref) {
  return hashRef('subject', `${kind}\u0000${ref}`);
}

function subjectView(record) {
  const key = subjectKeyOf(record);
  return {
    ref_hash: key ? hashRef('subject', key) : null,
    identity_kind: record && record.identity_kind ? record.identity_kind : 'unknown',
    account_class: record && record.account_class ? record.account_class : 'unknown'
  };
}

// Eligible customer values exclude internal, staff and quality-assurance
// accounts and any subject declared unverified. Anything undeclared is unknown.
function eligibilityOf(record) {
  const accountClass = record.account_class || 'unknown';
  if (INTERNAL_ACCOUNT_CLASSES.includes(accountClass)) return { eligible: false, reason: 'internal_account_class' };
  if (record.verified === false) return { eligible: false, reason: 'subject_declared_unverified' };
  if (!EXTERNAL_ACCOUNT_CLASSES.includes(accountClass)) return { eligible: null, reason: 'account_class_undeclared' };
  if (record.verified !== true) return { eligible: null, reason: 'verification_undeclared' };
  return { eligible: true, reason: null };
}

function purchaseKey(record) {
  return record.payment_ref ? `${record.provider}|${record.payment_ref}` : null;
}

// Full semantic comparison. Any declared difference is a conflict, and the
// digest does not depend on the order the records were supplied.
function semanticDigest(fields, record) {
  return digestOf(JSON.stringify(fields.map(field => (record[field] === undefined ? null : record[field]))));
}

const PURCHASE_SEMANTIC_FIELDS = ['provider', 'payment_ref', 'order_ref', 'subject_ref', 'identity_kind', 'account_class', 'verified', 'occurred_at', 'amount_minor', 'currency', 'status', 'mode', 'tier', 'charge_kind', 'price_class', 'price_class_declared'];
const REFUND_SEMANTIC_FIELDS = ['provider', 'refund_ref', 'payment_ref', 'order_ref', 'occurred_at', 'amount_minor', 'currency', 'status', 'mode', 'verified'];
const LEDGER_SEMANTIC_FIELDS = ['provider', 'event_id', 'event_type', 'subject_ref', 'identity_kind', 'occurred_at', 'received_at', 'paid_cursor_at', 'input_digest', 'reference', 'payment_ref', 'tier', 'status', 'applied', 'reason', 'expects_provider_charge'];

// Collapse repeats by key, order independently of how the files were supplied.
function groupByKey(records, keyOf) {
  const groups = new Map();
  const unkeyed = [];
  for (const record of records) {
    const key = keyOf(record);
    if (!key) {
      unkeyed.push(record);
      continue;
    }
    const group = groups.get(key) || { key, records: [] };
    group.records.push(record);
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { groups: ordered, unkeyed };
}

function resolveGroup(group, fields) {
  const digests = [...new Set(group.records.map(record => semanticDigest(fields, record)))].sort();
  // On a conflict the surviving representative is chosen by sorted digest so
  // the report never depends on which file arrived first.
  const representative = group.records.slice().sort((a, b) => {
    const left = semanticDigest(fields, a);
    const right = semanticDigest(fields, b);
    return left < right ? -1 : left > right ? 1 : 0;
  })[0];
  return { key: group.key, record: representative, occurrences: group.records.length, variants: digests.length, conflict: digests.length > 1 };
}

function reconcile(options) {
  if (!isPlainObject(options) || !Array.isArray(options.documents) || !options.documents.length) fail('no_input', 'At least one snapshot document is required');
  const now = options.now === undefined ? new Date().toISOString() : options.now;
  if (!isIsoTimestamp(now)) fail('malformed_field', 'now must be an ISO-8601 timestamp');

  const documents = options.documents.map((document, index) => parseDocument(document, index));
  const findings = [];
  const addFinding = (code, { refs, subject, detail, data } = {}) => {
    const spec = FINDING_CODES[code];
    if (!spec) fail('internal_finding', `Unknown finding code ${code}`);
    findings.push({
      code,
      severity: spec.severity,
      suggested_action: spec.action,
      means: spec.means,
      detail: detail || spec.means,
      refs: refs || [],
      subject: subject || null,
      data: data || {}
    });
  };

  const sources = {};
  for (const key of SOURCE_KEYS) {
    sources[key] = mergeSource(key, documents.map(doc => doc.sources[key]).filter(Boolean), addFinding, Date.parse(now));
  }
  const coverage = applyCrossSourceCoverage(sources, now, addFinding);

  // ---- charges ----------------------------------------------------------
  const excluded = { missing_reference: 0, invalid_amount: 0, currency_mismatch: 0, failed_status: 0, unknown_status: 0, test_mode: 0, unknown_mode: 0, conflicting_duplicate: 0 };
  const eligibilityCounts = { eligible_customer: 0, not_eligible_customer: 0, undetermined: 0 };
  const sourceCurrency = sources.provider_purchases.currency;
  const purchaseGrouping = groupByKey(sources.provider_purchases.records, purchaseKey);

  for (const record of purchaseGrouping.unkeyed) {
    excluded.missing_reference += 1;
    addFinding('purchase_missing_reference', { subject: subjectView(record), detail: 'A purchase record carried no provider charge reference.' });
  }

  const charges = new Map();
  let duplicatesCollapsed = 0;
  for (const group of purchaseGrouping.groups) {
    const resolved = resolveGroup(group, PURCHASE_SEMANTIC_FIELDS);
    duplicatesCollapsed += resolved.occurrences - 1;
    const refs = [{ kind: 'charge', hash: hashRef('charge', group.key) }];
    if (resolved.conflict) {
      // No subject is attached: a conflict must read the same whichever file
      // arrived first, so no single record is promoted as the truth.
      addFinding('duplicate_purchase_conflict', { refs, detail: `The same charge reference was supplied as ${resolved.variants} differing records. Amount, currency, mode, status, subject, identity kind, account class, verification, tier, charge kind and price class are all compared.`, data: { variants: resolved.variants, occurrences: resolved.occurrences } });
    } else if (resolved.occurrences > 1) {
      addFinding('duplicate_purchase_record', { refs, detail: 'The same charge reference was supplied more than once with an identical record and counted once.', data: { occurrences: resolved.occurrences } });
    }
    charges.set(group.key, { key: group.key, record: resolved.record, occurrences: resolved.occurrences, conflict: resolved.conflict, counted: false, eligible: null, refunded_minor: 0n, refund_count: 0, has_value_refund: false, fully_refunded: false, remaining_minor: null });
  }

  for (const charge of charges.values()) {
    const record = charge.record;
    const refs = [{ kind: 'charge', hash: hashRef('charge', charge.key) }];
    const subject = subjectView(record);
    if (charge.conflict) {
      excluded.conflicting_duplicate += 1;
      continue;
    }
    if (record.amount_minor === null) {
      excluded.invalid_amount += 1;
      addFinding('purchase_amount_invalid', { refs, subject, detail: 'A charge did not declare an amount in minor units.' });
      continue;
    }
    if (record.currency && sourceCurrency && record.currency !== sourceCurrency) {
      excluded.currency_mismatch += 1;
      addFinding('purchase_currency_mismatch', { refs, subject, detail: 'A charge currency disagreed with its source currency.' });
      continue;
    }
    if (!record.occurred_at) addFinding('purchase_missing_occurred_at', { refs, subject, detail: 'A charge carried no provider timestamp; none was inferred.' });
    if (record.status === 'failed') {
      excluded.failed_status += 1;
      addFinding('purchase_non_captured_status', { refs, subject, detail: 'A charge declared a terminal failed status and is excluded from receipts.' });
      continue;
    }
    if (record.status !== 'captured' && record.status !== 'refunded') {
      // An authorized or unknown status is not a zero. It withholds the total.
      excluded.unknown_status += 1;
      addFinding('purchase_unknown_status', { refs, subject, detail: `A charge declared status ${record.status}. It is neither counted as a receipt nor dismissed as no money.`, data: { status: record.status } });
      continue;
    }
    if (record.mode === 'test') {
      excluded.test_mode += 1;
      addFinding('purchase_test_mode', { refs, subject, detail: 'A test-mode charge is excluded from customer receipts.' });
      continue;
    }
    if (record.mode !== 'live') {
      excluded.unknown_mode += 1;
      addFinding('purchase_unknown_mode', { refs, subject, detail: 'A charge did not declare live or test mode.' });
      continue;
    }
    if (!record.price_class_declared || record.price_class === 'other_or_unknown') {
      addFinding('purchase_price_class_unknown', { refs, subject, detail: 'A charge did not declare nominal-offer or standard pricing. Its amount is reported in the visible unclassified bucket.' });
    } else if (record.price_class === 'nominal_offer') {
      addFinding('nominal_offer_charge', { refs, subject, detail: 'A nominal launch-offer charge is recognized at its actual amount and reported separately.' });
    }
    charge.counted = true;
    const verdict = eligibilityOf(record);
    charge.eligible = verdict.eligible;
    if (verdict.eligible === true) {
      eligibilityCounts.eligible_customer += 1;
    } else if (verdict.eligible === false) {
      eligibilityCounts.not_eligible_customer += 1;
      addFinding('purchase_not_eligible_customer', { refs, subject, detail: `A live charge is excluded from eligible customer values because of ${verdict.reason}. It remains in the provider-side total only.`, data: { reason: verdict.reason } });
    } else {
      eligibilityCounts.undetermined += 1;
      addFinding('purchase_eligibility_unknown', { refs, subject, detail: `A live charge cannot be classed as an eligible customer receipt because of ${verdict.reason}.`, data: { reason: verdict.reason } });
    }
  }

  // ---- refunds ----------------------------------------------------------
  const refundSourceCurrency = sources.provider_refunds.currency;
  const byOrderRef = new Map();
  for (const charge of charges.values()) {
    if (!charge.record.order_ref) continue;
    const key = `${charge.record.provider}|${charge.record.order_ref}`;
    const list = byOrderRef.get(key) || [];
    list.push(charge);
    byOrderRef.set(key, list);
  }

  const refundGrouping = groupByKey(sources.provider_refunds.records, record => (record.refund_ref ? `${record.provider}|${record.refund_ref}` : null));
  const missingRefundReferences = refundGrouping.unkeyed.length;
  for (let index = 0; index < missingRefundReferences; index += 1) {
    addFinding('refund_missing_reference', { detail: 'A refund record carried no refund reference, so it cannot be deduplicated and was not subtracted.' });
  }

  const refunds = new Map();
  let refundDuplicates = 0;
  for (const group of refundGrouping.groups) {
    const resolved = resolveGroup(group, REFUND_SEMANTIC_FIELDS);
    refundDuplicates += resolved.occurrences - 1;
    const refs = [{ kind: 'refund', hash: hashRef('refund', group.key) }];
    if (resolved.conflict) {
      addFinding('duplicate_refund_conflict', { refs, detail: `The same refund reference was supplied as ${resolved.variants} differing records.`, data: { variants: resolved.variants, occurrences: resolved.occurrences } });
    } else if (resolved.occurrences > 1) {
      addFinding('duplicate_refund_record', { refs, detail: 'The same refund reference was supplied more than once with an identical record and counted once.', data: { occurrences: resolved.occurrences } });
    }
    refunds.set(group.key, { key: group.key, record: resolved.record, conflict: resolved.conflict, applied: false });
  }

  let pendingRefunds = 0;
  let unmatchedRefunds = 0;
  let mismatchedRefunds = 0;
  let zeroRefunds = 0;
  let verificationWithheld = 0;
  let refundsOnExcludedCharges = 0;
  for (const refund of refunds.values()) {
    const record = refund.record;
    const ref = [{ kind: 'refund', hash: hashRef('refund', refund.key) }];
    if (refund.conflict) continue;
    let charge = null;
    if (record.payment_ref) {
      charge = charges.get(`${record.provider}|${record.payment_ref}`) || null;
      if (!charge) {
        // An explicit charge reference that fails to resolve is never retried
        // through the order reference. That would attribute money returned to
        // a charge the provider did not name.
        mismatchedRefunds += 1;
        addFinding('refund_reference_mismatch', { refs: ref, detail: 'A refund named an explicit charge reference that is absent from the purchase source. No order-reference fallback was attempted.' });
        continue;
      }
      if (record.order_ref) {
        // Both references were declared, so both are checked. One that resolves
        // never excuses another that names a different charge or nothing at all.
        const named = byOrderRef.get(`${record.provider}|${record.order_ref}`) || [];
        if (!named.includes(charge)) {
          mismatchedRefunds += 1;
          addFinding('refund_reference_contradiction', {
            refs: ref.concat([{ kind: 'charge', hash: hashRef('charge', charge.key) }]),
            subject: subjectView(charge.record),
            detail: named.length
              ? 'A refund declared an order reference that names a different charge from the one its payment reference resolved to.'
              : 'A refund declared an order reference that is absent from the purchase source alongside a payment reference that resolved.',
            data: { order_reference_charges: named.length }
          });
          continue;
        }
      }
    } else if (record.order_ref) {
      const candidates = byOrderRef.get(`${record.provider}|${record.order_ref}`) || [];
      if (candidates.length > 1) {
        addFinding('refund_reference_ambiguous', { refs: ref, detail: 'A refund matched more than one charge through a shared order reference.', data: { candidates: candidates.length } });
        continue;
      }
      charge = candidates[0] || null;
    }
    if (!charge) {
      unmatchedRefunds += 1;
      addFinding('refund_unmatched', { refs: ref, detail: 'A refund carried no usable link to a charge in the supplied purchase source.' });
      continue;
    }
    const bothRefs = ref.concat([{ kind: 'charge', hash: hashRef('charge', charge.key) }]);
    const subject = subjectView(charge.record);
    if (record.status !== 'processed') {
      pendingRefunds += 1;
      addFinding('refund_pending_or_unknown', { refs: bothRefs, subject, detail: `A refund with status ${record.status} is not treated as money returned.`, data: { status: record.status } });
      continue;
    }
    if (record.verified !== true) {
      // Provider verification of the refund receipt itself. It is not the
      // account verification that decides eligibility, and neither stands in
      // for the other.
      verificationWithheld += 1;
      addFinding(record.verified === false ? 'refund_not_provider_verified' : 'refund_verification_undeclared', {
        refs: bothRefs,
        subject,
        detail: record.verified === false
          ? 'A refund was declared as not verified against the provider record, so no value was subtracted.'
          : 'A refund did not declare whether it was verified against the provider record, so whether value was returned is unknown and no value was subtracted.'
      });
      continue;
    }
    if (record.mode === 'unknown' || charge.record.mode === 'unknown' || record.mode !== charge.record.mode) {
      // A test or unknown-mode refund never reduces a live charge, and an
      // undeclared mode on either side is a contradiction rather than a match.
      mismatchedRefunds += 1;
      addFinding('refund_mode_mismatch', { refs: bothRefs, subject, detail: `A refund declared mode ${record.mode} against a charge in mode ${charge.record.mode}. It was not subtracted.`, data: { refund_mode: record.mode, charge_mode: charge.record.mode } });
      continue;
    }
    const refundCurrency = record.currency || refundSourceCurrency;
    const chargeCurrency = charge.record.currency || sourceCurrency;
    const contradictsOwnSource = !!(record.currency && refundSourceCurrency && record.currency !== refundSourceCurrency);
    if (contradictsOwnSource || (refundCurrency && chargeCurrency && refundCurrency !== chargeCurrency)) {
      mismatchedRefunds += 1;
      addFinding('refund_currency_mismatch', { refs: bothRefs, subject, detail: contradictsOwnSource ? 'A refund currency disagreed with the currency declared for its own source.' : 'A refund currency disagreed with the charge currency.' });
      continue;
    }
    if (charge.record.occurred_at && (!record.occurred_at || Date.parse(record.occurred_at) < Date.parse(charge.record.occurred_at))) {
      mismatchedRefunds += 1;
      addFinding('refund_timestamp_contradiction', { refs: bothRefs, subject, detail: record.occurred_at ? 'A refund is dated before the charge it names.' : 'A refund carried no timestamp while the charge it names is timestamped.' });
      continue;
    }
    if (record.amount_minor === null) {
      pendingRefunds += 1;
      addFinding('refund_pending_or_unknown', { refs: bothRefs, subject, detail: 'A processed refund carried no amount and cannot be applied.' });
      continue;
    }
    refund.applied = true;
    charge.refund_count += 1;
    if (record.amount_minor === 0) {
      // A zero refund returns no value and never marks the charge refunded.
      zeroRefunds += 1;
      addFinding('refund_zero_amount', { refs: bothRefs, subject, detail: 'A processed refund carried a zero amount. No value was returned and the charge is not marked refunded.' });
      continue;
    }
    charge.has_value_refund = true;
    charge.refunded_minor += BigInt(record.amount_minor);
    if (!charge.counted) refundsOnExcludedCharges += 1;
    if (charge.record.amount_minor !== null && charge.refunded_minor > BigInt(charge.record.amount_minor)) {
      addFinding('refund_exceeds_purchase', { refs: bothRefs, subject, detail: 'Processed refunds for one charge exceeded the charged amount.' });
    }
  }

  // Refund coverage is measured against the charged amount. A partial or zero
  // refund is never promoted to a full refund.
  let fullyRefundedCharges = 0;
  let partiallyRefundedCharges = 0;
  for (const charge of charges.values()) {
    const amount = charge.record.amount_minor === null ? null : BigInt(charge.record.amount_minor);
    const applied = amount !== null && charge.refunded_minor > amount ? amount : charge.refunded_minor;
    charge.applied_refund_minor = applied;
    charge.remaining_minor = amount === null ? null : amount - applied;
    charge.fully_refunded = amount !== null && amount > 0n && applied >= amount;
    charge.retains_value = amount !== null && charge.remaining_minor > 0n;
    if (charge.fully_refunded) fullyRefundedCharges += 1;
    else if (charge.has_value_refund) partiallyRefundedCharges += 1;
    if (charge.record.status === 'refunded' && !charge.has_value_refund) {
      addFinding('purchase_refund_flag_without_refund_record', { refs: [{ kind: 'charge', hash: hashRef('charge', charge.key) }], subject: subjectView(charge.record), detail: 'A charge was flagged refunded by the provider but no processed refund of any value was supplied.' });
    }
  }

  // ---- ledger events ----------------------------------------------------
  const ledgerGrouping = groupByKey(sources.ledger_events.records, record => (record.event_id ? `${record.provider}|${record.event_id}` : null));
  let eventsWithoutId = 0;
  for (const record of ledgerGrouping.unkeyed) {
    // Counted, not dropped: an event without the receipt key cannot silently
    // disappear from the reconciliation.
    eventsWithoutId += 1;
    addFinding('ledger_event_missing_id', { subject: subjectView(record), detail: 'A ledger event carried no event identifier, so it cannot be matched to the database receipt key. It is counted as unusable rather than discarded.' });
  }

  const ledger = new Map();
  let ledgerDuplicates = 0;
  for (const group of ledgerGrouping.groups) {
    const resolved = resolveGroup(group, LEDGER_SEMANTIC_FIELDS);
    ledgerDuplicates += resolved.occurrences - 1;
    const refs = [{ kind: 'ledger_event', hash: hashRef('ledger_event', group.key) }];
    if (resolved.conflict) {
      addFinding('ledger_event_conflict', { refs, detail: `The same provider event identifier was supplied as ${resolved.variants} differing records. Subject, identity kind, reference, status, tier, applied flag, reason, arrival, paid cursor and provider timestamp are all compared.`, data: { variants: resolved.variants, occurrences: resolved.occurrences } });
    } else if (resolved.occurrences > 1) {
      addFinding('duplicate_ledger_event', { refs, detail: 'The same provider event identifier was supplied more than once with an identical record and counted once.', data: { occurrences: resolved.occurrences } });
    }
    ledger.set(group.key, { key: group.key, record: resolved.record, conflict: resolved.conflict });
  }

  // Receipt evidence the database records for every event it consumed.
  const semanticPaid = record => SEMANTIC_PAID_STATUSES.includes(record.status);
  // Every timestamp comparison below is on instants, so one moment written in
  // two offsets is one moment and never two.
  const epochOf = value => (value ? Date.parse(value) : null);
  let eventsMissingReceiptEvidence = 0;
  let cursorContradictions = 0;
  let reasonContradictions = 0;
  for (const entry of ledger.values()) {
    const record = entry.record;
    const refs = [{ kind: 'ledger_event', hash: hashRef('ledger_event', entry.key) }];

    // public.apply_billing_event sets, for the event it just consumed,
    //   paid_cursor_at = GREATEST(last_paid_at, CASE WHEN applied AND is_paid
    //                             THEN p_occurred_at ELSE NULL END)
    // so the cursor an applied paid receipt carries is at least that event's
    // own provider timestamp, whatever the cursor already stood at. A snapshot
    // that states a lower one is not reporting a row the database wrote, and
    // its whole derivation is withheld rather than read as collected money.
    if (record.applied === true && semanticPaid(record) && record.occurred_at && record.paid_cursor_at
      && epochOf(record.paid_cursor_at) < epochOf(record.occurred_at)) {
      cursorContradictions += 1;
      addFinding('ledger_receipt_cursor_contradiction', { refs, subject: subjectView(record), detail: 'An applied paid ledger event declares a paid cursor earlier than its own provider timestamp, which the database function that writes that cursor cannot produce.', data: { contradiction: 'paid_cursor_before_own_occurred_at' } });
    }

    // reason is the skip reason: the database writes it only when it skipped
    // the event, and only from the fixed set that function can assign. The
    // declared value is checked against that set but is never echoed, because
    // it is free text on the way into this tool.
    const reasonContradiction = record.applied === true && record.reason ? 'reason_on_applied_event'
      : record.applied === false && record.reason && !LEDGER_SKIP_REASONS.includes(record.reason) ? 'skip_reason_not_recorded_by_database'
        : null;
    if (reasonContradiction) {
      reasonContradictions += 1;
      addFinding('ledger_receipt_reason_contradiction', { refs, subject: subjectView(record), detail: 'A ledger event declares an applied flag and skip reason the database never records together, so the recorded receipt outcome cannot be reproduced.', data: { contradiction: reasonContradiction, recognized_skip_reasons: LEDGER_SKIP_REASONS.slice() } });
    }

    const missing = [];
    if (!record.occurred_at) missing.push('occurred_at');
    if (record.applied === null) missing.push('applied');
    if (!record.received_at) missing.push('received_at');
    if (!record.input_digest) missing.push('input_digest');
    if (record.applied === false && !record.reason) missing.push('reason');
    // The database writes the paid cursor when it applies a paid event. An
    // event it skipped carries whatever cursor already stood, which is nothing
    // at all when no paid event has been applied yet, so a null cursor on a
    // skipped event is the recorded outcome and not missing evidence.
    if (record.applied === true && semanticPaid(record) && !record.paid_cursor_at) missing.push('paid_cursor_at');
    if (!missing.length) continue;
    eventsMissingReceiptEvidence += 1;
    addFinding('ledger_receipt_evidence_missing', { refs, subject: subjectView(record), detail: `A ledger event did not carry ${missing.join(', ')}, so the recorded receipt outcome cannot be reproduced.`, data: { undeclared: missing, skip_reason_recognized: record.applied === false && !!record.reason ? LEDGER_SKIP_REASONS.includes(record.reason) : null } });
  }

  // Arrival order is read from received_at, never assumed from file order, and
  // timestamps are compared as instants so one moment written two ways cannot
  // look like two moments.
  const orderingGroups = new Map();
  for (const entry of ledger.values()) {
    const record = entry.record;
    if (!record.subject_ref || !record.reference) continue;
    const key = `${record.provider}|${record.identity_kind}|${record.subject_ref}|${record.reference}`;
    const list = orderingGroups.get(key) || [];
    list.push(entry);
    orderingGroups.set(key, list);
  }
  let outOfOrderGroups = 0;
  let indeterminateOrderGroups = 0;
  const indeterminateReported = new Set();
  const byHash = (a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);
  for (const key of [...orderingGroups.keys()].sort()) {
    const entries = orderingGroups.get(key);
    if (entries.length < 2) continue;
    const refs = entries.map(entry => ({ kind: 'ledger_event', hash: hashRef('ledger_event', entry.key) })).sort(byHash);
    const subject = subjectView(entries[0].record);
    const arrivals = new Set(entries.map(entry => epochOf(entry.record.received_at)));
    const ordered = entries.every(entry => entry.record.occurred_at && entry.record.received_at);
    if (!ordered || arrivals.size !== entries.length) {
      indeterminateOrderGroups += 1;
      for (const entry of entries) indeterminateReported.add(entry.key);
      addFinding('ledger_ordering_indeterminate', { refs, subject, detail: 'Two or more ledger events share a subject and reference but do not carry distinct arrival instants alongside provider timestamps, so their arrival order cannot be determined.', data: { events: entries.length } });
      continue;
    }
    const sorted = entries.slice().sort((a, b) => epochOf(a.record.received_at) - epochOf(b.record.received_at));
    let highestSeen = null;
    let inverted = false;
    for (const entry of sorted) {
      const occurred = epochOf(entry.record.occurred_at);
      if (highestSeen !== null && occurred < highestSeen) inverted = true;
      if (highestSeen === null || occurred > highestSeen) highestSeen = occurred;
    }
    if (inverted) {
      outOfOrderGroups += 1;
      addFinding('ledger_out_of_order', { refs, subject, detail: 'A ledger event arrived after another event for the same subject and reference while carrying an earlier provider timestamp.', data: { events: entries.length } });
    }
  }

  // The database holds one paid cursor per subject, across every reference and
  // provider, so monotonicity is verified the same way. Events the database
  // skipped are the guard working and are never counted as regressions.
  const subjectLedger = new Map();
  for (const entry of ledger.values()) {
    const key = subjectKeyOf(entry.record);
    if (!key) continue;
    const list = subjectLedger.get(key) || [];
    list.push(entry);
    subjectLedger.set(key, list);
  }
  let cursorRegressions = 0;
  for (const key of [...subjectLedger.keys()].sort()) {
    const applied = subjectLedger.get(key).filter(entry => entry.record.applied === true);
    if (applied.length < 2) continue;
    const refs = applied.map(entry => ({ kind: 'ledger_event', hash: hashRef('ledger_event', entry.key) })).sort(byHash);
    const subject = subjectView(applied[0].record);
    const arrivals = new Set(applied.map(entry => epochOf(entry.record.received_at)));
    const stamped = applied.every(entry => entry.record.occurred_at && entry.record.received_at);
    if (!stamped || arrivals.size !== applied.length) {
      // Not reported twice when the per-reference pass already named this set.
      if (applied.every(entry => indeterminateReported.has(entry.key))) continue;
      indeterminateOrderGroups += 1;
      for (const entry of applied) indeterminateReported.add(entry.key);
      addFinding('ledger_ordering_indeterminate', { refs, subject, detail: 'Applied ledger events for one subject do not carry distinct arrival instants alongside provider timestamps, so the order the paid cursor moved in cannot be determined.', data: { events: applied.length } });
      continue;
    }
    const sorted = applied.slice().sort((a, b) => epochOf(a.record.received_at) - epochOf(b.record.received_at));
    let cursor = null;
    for (const entry of sorted) {
      const occurred = epochOf(entry.record.occurred_at);
      if (cursor !== null && occurred < cursor) {
        cursorRegressions += 1;
        addFinding('ledger_cursor_regression', { refs: [{ kind: 'ledger_event', hash: hashRef('ledger_event', entry.key) }], subject, detail: 'An applied ledger event carries a provider timestamp earlier than the paid cursor an earlier-arriving event already established for this subject, under any reference or provider.', data: { events: applied.length } });
      }
      if (semanticPaid(entry.record) && (cursor === null || occurred > cursor)) cursor = occurred;
    }
  }

  const chargeRefIndex = new Set();
  for (const charge of charges.values()) {
    if (charge.record.payment_ref) chargeRefIndex.add(`${charge.record.provider}|${charge.record.payment_ref}`);
    if (charge.record.order_ref) chargeRefIndex.add(`${charge.record.provider}|${charge.record.order_ref}`);
  }
  const ledgerRefIndex = new Set();
  for (const entry of ledger.values()) {
    const record = entry.record;
    for (const value of [record.payment_ref, record.reference]) {
      if (value) ledgerRefIndex.add(`${record.provider}|${value}`);
    }
  }

  let ledgerWithoutProvider = 0;
  if (sources.provider_purchases.present) {
    for (const entry of ledger.values()) {
      const record = entry.record;
      const chargeShaped = record.expects_provider_charge === true || (record.expects_provider_charge === null && /payment|charge|order|invoice|captur/i.test(record.event_type || ''));
      if (!chargeShaped) continue;
      const linked = [record.payment_ref, record.reference].some(value => value && chargeRefIndex.has(`${record.provider}|${value}`));
      if (!linked) {
        ledgerWithoutProvider += 1;
        addFinding('ledger_event_without_provider_record', { refs: [{ kind: 'ledger_event', hash: hashRef('ledger_event', entry.key) }], subject: subjectView(record), detail: 'A charge-shaped ledger event has no matching provider purchase in this snapshot.' });
      }
    }
  }

  let chargesWithoutLedger = 0;
  if (sources.ledger_events.present) {
    for (const charge of charges.values()) {
      if (!charge.counted) continue;
      const linked = [charge.record.payment_ref, charge.record.order_ref].some(value => value && ledgerRefIndex.has(`${charge.record.provider}|${value}`));
      if (!linked) {
        chargesWithoutLedger += 1;
        addFinding('purchase_without_ledger_event', { refs: [{ kind: 'charge', hash: hashRef('charge', charge.key) }], subject: subjectView(charge.record), detail: 'A captured live charge has no matching database ledger event in this snapshot.' });
      }
    }
  }

  // ---- identities and entitlements --------------------------------------
  // A subject is the pair (identity kind, value). The same value under two
  // kinds is two subjects and they are never merged automatically.
  const subjects = new Map();
  const rawValueKinds = new Map();
  const touchSubject = (record, origin) => {
    if (record.subject_ref) {
      const kinds = rawValueKinds.get(record.subject_ref) || new Set();
      kinds.add(record.identity_kind || 'unknown');
      rawValueKinds.set(record.subject_ref, kinds);
    }
    const key = subjectKeyOf(record);
    if (!key) return null;
    const entry = subjects.get(key) || { key, kind: record.identity_kind, classes: new Set(), verified: new Set(), origins: new Set(), retains_paid_value: false, ambiguous: false, eligibility_contradicted: false };
    if (record.account_class && record.account_class !== 'unknown') entry.classes.add(record.account_class);
    // Verification is a declaration about the subject, so it is collected from
    // every source that makes one rather than read off one record.
    if (record.verified === true || record.verified === false) entry.verified.add(record.verified);
    entry.origins.add(origin);
    subjects.set(key, entry);
    return entry;
  };

  for (const charge of charges.values()) {
    const entry = touchSubject(charge.record, 'provider_purchases');
    // Unrefunded value, not merely the absence of a refund receipt.
    if (entry && charge.counted && charge.retains_value) entry.retains_paid_value = true;
  }
  for (const entry of ledger.values()) touchSubject(entry.record, 'ledger_events');

  const chargeByReference = new Map();
  for (const charge of charges.values()) {
    for (const value of [charge.record.payment_ref, charge.record.order_ref]) {
      if (!value) continue;
      const key = `${charge.record.provider}|${value}`;
      const list = chargeByReference.get(key) || [];
      list.push(charge);
      chargeByReference.set(key, list);
    }
  }

  const entitlementBySubject = new Map();
  let entitlementsWithoutIdentity = 0;
  for (const record of sources.entitlements.records) {
    const entry = touchSubject(record, 'entitlements');
    const subject = subjectView(record);
    const key = subjectKeyOf(record);
    if (key) entitlementBySubject.set(key, record);
    const paidTier = record.tier === 'pro' || record.tier === 'elite' || record.tier === 'eliteplus';
    const activeStatus = record.status === 'active' || record.status === 'trialing';
    if (paidTier && activeStatus && record.period_end_declared && record.current_period_end === null) {
      addFinding('legacy_null_expiry_access', { subject, detail: 'Paid access with no period end is preserved exactly as recorded. No renewal term, expiry or founding-price change is inferred.' });
    }
    if (record.grant_source === 'manual' || record.grant_source === 'legacy') {
      addFinding('manual_or_legacy_grant', { subject, detail: `An entitlement was recorded as a ${record.grant_source} grant rather than a provider purchase.`, data: { grant_source: record.grant_source } });
    }
    if (!key) {
      // Held, never skipped: a grant with no typed identity cannot be checked.
      entitlementsWithoutIdentity += 1;
      addFinding('entitlement_without_identity', { subject, detail: 'An entitlement carried no subject key or no declared identity kind, so it cannot be matched to any charge.' });
      continue;
    }
    const referenced = record.provider && record.reference ? (chargeByReference.get(`${record.provider}|${record.reference}`) || []) : [];
    const sameSubject = referenced.filter(charge => subjectKeyOf(charge.record) === key);
    if (referenced.length && !sameSubject.length) {
      // A shared provider reference never establishes that this subject paid.
      addFinding('grant_reference_subject_mismatch', {
        refs: referenced.map(charge => ({ kind: 'charge', hash: hashRef('charge', charge.key) })).sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)),
        subject,
        detail: 'An entitlement named a provider reference that resolves only to charges belonging to a different subject key.',
        data: { referenced_charges: referenced.length }
      });
    }
    // Support has to come from the charge the grant names. A different charge
    // belonging to the same subject, however recent, never stands in for a
    // reference the snapshot cannot resolve.
    let supported;
    if (record.provider && record.reference) {
      if (!referenced.length) {
        addFinding('grant_reference_unresolved', { subject, detail: 'An entitlement named a provider reference that is absent from the supplied purchase source. Another charge belonging to the same subject is not read as support for it, and nothing about this access is changed.', data: { grant_source: record.grant_source } });
      }
      supported = sameSubject.some(charge => charge.counted && charge.retains_value);
    } else {
      supported = entry.retains_paid_value;
    }
    if (paidTier && activeStatus && !supported) {
      addFinding('paid_grant_without_purchase', { subject, detail: record.provider && record.reference ? 'A paid entitlement names a provider reference with no captured charge retaining unrefunded value under the same typed subject key in this snapshot.' : 'A paid entitlement has no captured charge retaining unrefunded value under the same typed subject key in this snapshot.' });
    }
    const revoked = record.revoked === true || record.status === 'canceled' || record.status === 'inactive';
    if (revoked && entry.retains_paid_value) {
      addFinding('revoked_grant_with_unrefunded_purchase', { subject, detail: 'Access was revoked or ended while a captured charge for that subject still retains unrefunded value.' });
    }
  }

  for (const value of [...rawValueKinds.keys()].sort()) {
    const kinds = [...rawValueKinds.get(value)].sort();
    if (kinds.length < 2) continue;
    addFinding('identity_value_reused_across_kinds', {
      refs: kinds.map(kind => ({ kind: 'subject', hash: subjectRefHash(kind, value) })).sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)),
      detail: `One identifier value was declared under the identity kinds ${kinds.join(' and ')}. They are kept as separate subjects and are not linked.`,
      data: { identity_kinds: kinds }
    });
  }

  const entitlementKinds = new Set();
  for (const record of sources.entitlements.records) {
    if (record.identity_kind && record.identity_kind !== 'unknown') entitlementKinds.add(record.identity_kind);
  }

  // Eligibility is a fact about the subject, not about one record. A charge
  // that declares an external verified account is not an eligible customer
  // receipt while another source declares the same typed subject internal,
  // staff, quality-assurance or unverified.
  let eligibilityContradictions = 0;
  for (const key of [...subjects.keys()].sort()) {
    const entry = subjects.get(key);
    const internal = [...entry.classes].some(value => INTERNAL_ACCOUNT_CLASSES.includes(value));
    const external = [...entry.classes].some(value => EXTERNAL_ACCOUNT_CLASSES.includes(value));
    entry.eligibility_contradicted = (internal && external) || (entry.verified.has(true) && entry.verified.has(false));
  }
  for (const charge of charges.values()) {
    if (!charge.counted || charge.eligible !== true) continue;
    const key = subjectKeyOf(charge.record);
    const entry = key ? subjects.get(key) : null;
    if (!entry || !entry.eligibility_contradicted) continue;
    charge.eligible = null;
    eligibilityContradictions += 1;
    eligibilityCounts.eligible_customer -= 1;
    eligibilityCounts.undetermined += 1;
    addFinding('subject_eligibility_contradiction', {
      refs: [{ kind: 'charge', hash: hashRef('charge', charge.key) }],
      subject: subjectView(charge.record),
      detail: 'A live charge declares an external verified account while another source declares the same typed subject internal, staff, quality-assurance or unverified. The charge is excluded from eligible customer values and those values are withheld.',
      data: { account_classes: [...entry.classes].sort(), verification_states: [...entry.verified].sort() }
    });
  }

  let ambiguousSubjects = 0;
  for (const charge of charges.values()) {
    if (!charge.counted) continue;
    const record = charge.record;
    const subject = subjectView(record);
    const refs = [{ kind: 'charge', hash: hashRef('charge', charge.key) }];
    const key = subjectKeyOf(record);
    if (!key) {
      ambiguousSubjects += 1;
      addFinding('ambiguous_identity', { refs, subject, detail: 'A counted charge did not declare a resolvable subject key or identity kind. Identities are never merged automatically.' });
      continue;
    }
    if (!sources.entitlements.present) continue;
    if (!entitlementBySubject.has(key)) {
      if (entitlementKinds.size && !entitlementKinds.has(record.identity_kind)) {
        ambiguousSubjects += 1;
        const entry = subjects.get(key);
        if (entry) entry.ambiguous = true;
        addFinding('ambiguous_identity', { refs, subject, detail: 'A charge is keyed by a different identity kind than the entitlement source. Linking requires authorized manual review; no automatic merge is performed.' });
      }
      addFinding('purchase_without_entitlement', { refs, subject, detail: 'A captured live charge has no entitlement row under the same typed subject key.' });
    }
  }

  const identityClasses = { member: 0, founder: 0, admin: 0, test: 0, free: 0, unknown: 0 };
  for (const key of [...subjects.keys()].sort()) {
    const entry = subjects.get(key);
    if (entry.classes.size > 1) {
      entry.ambiguous = true;
      ambiguousSubjects += 1;
      addFinding('ambiguous_identity', { subject: { ref_hash: hashRef('subject', key), identity_kind: entry.kind, account_class: 'unknown' }, detail: `A subject was declared with conflicting account classes: ${[...entry.classes].sort().join(', ')}.`, data: { account_classes: [...entry.classes].sort() } });
    }
    const priority = ['test', 'admin', 'founder', 'member', 'free'];
    const resolved = entry.classes.size === 1 ? [...entry.classes][0] : priority.find(value => entry.classes.has(value)) || 'unknown';
    identityClasses[entry.classes.size > 1 ? 'unknown' : resolved] += 1;
  }

  // ---- derived actuals --------------------------------------------------
  const countedCharges = [...charges.values()].filter(charge => charge.counted);
  const eligibleCharges = countedCharges.filter(charge => charge.eligible === true);
  const priceClassOf = charge => (charge.record.price_class_declared && charge.record.price_class !== 'other_or_unknown' ? charge.record.price_class : 'unclassified');
  // Totals are accumulated exactly; a float sum can silently round two large
  // integers into a wrong number.
  const sumAmounts = list => list.reduce((total, charge) => total + BigInt(charge.record.amount_minor), 0n);
  const sumRefunds = list => list.reduce((total, charge) => total + charge.applied_refund_minor, 0n);
  const totals = {
    raw_gross: sumAmounts(countedCharges),
    raw_refunds: sumRefunds(countedCharges),
    eligible_gross: sumAmounts(eligibleCharges),
    eligible_refunds: sumRefunds(eligibleCharges),
    eligible_nominal: sumAmounts(eligibleCharges.filter(charge => priceClassOf(charge) === 'nominal_offer')),
    eligible_standard: sumAmounts(eligibleCharges.filter(charge => priceClassOf(charge) === 'standard')),
    eligible_unclassified: sumAmounts(eligibleCharges.filter(charge => priceClassOf(charge) === 'unclassified'))
  };
  totals.raw_net = totals.raw_gross - totals.raw_refunds;
  totals.eligible_net = totals.eligible_gross - totals.eligible_refunds;
  const unsafeTotals = Object.keys(totals).filter(name => totals[name] > SAFE_MAX || totals[name] < -SAFE_MAX).sort();
  if (unsafeTotals.length) {
    addFinding('amount_total_out_of_safe_range', { detail: `An exact integer total exceeded the reportable range for ${unsafeTotals.join(', ')}. No rounded value is emitted.`, data: { totals: unsafeTotals } });
  }
  const paidSubjects = new Set(eligibleCharges.filter(charge => charge.retains_value).map(charge => subjectKeyOf(charge.record)).filter(Boolean));

  const blockers = [];
  for (const key of SOURCE_KEYS) {
    for (const reason of sources[key].reasons) blockers.push(`${key}:${reason}`);
  }
  if (sources.provider_purchases.refund_status === 'refunds_reflected' && sources.provider_refunds.present) {
    addFinding('purchases_already_net_of_refunds', { detail: 'Purchase amounts were declared already net of refunds while a refund source was supplied. Independent subtraction would double count.' });
    blockers.push('provider_purchases:amounts_already_net_of_refunds');
  }
  const eligibilityOnly = [];
  const subjectsOnly = [];
  for (const item of findings) {
    const scopes = FINDING_CODES[item.code].blocks;
    if (scopes.includes('derivation')) blockers.push(`finding:${item.code}`);
    if (scopes.includes('eligibility')) eligibilityOnly.push(`finding:${item.code}`);
    if (scopes.includes('subjects')) subjectsOnly.push(`finding:${item.code}`);
  }
  const derivationBlockers = [...new Set(blockers)].sort();
  const eligibilityBlockers = [...new Set(derivationBlockers.concat(eligibilityOnly))].sort();
  const subjectBlockers = [...new Set(eligibilityBlockers.concat(subjectsOnly))].sort();

  const measure = (value, reasons) => (reasons.length ? { status: 'unknown', value_minor: null, reasons } : { status: 'known', value_minor: Number(value), reasons: [] });
  const counted = (value, reasons) => (reasons.length ? { status: 'unknown', value: null, reasons } : { status: 'known', value, reasons: [] });
  const currency = sourceCurrency;

  const derived = {
    currency,
    currency_status: currency ? 'declared' : 'unknown',
    eligible_customer: {
      note: 'Live charges on external accounts that are declared verified. Internal, staff, quality-assurance and unverified subjects are excluded, and an undeclared account class or verification state keeps these values unknown.',
      gross_recognized_minor: measure(totals.eligible_gross, eligibilityBlockers),
      processed_refunds_minor: measure(totals.eligible_refunds, eligibilityBlockers),
      net_recognized_minor: measure(totals.eligible_net, eligibilityBlockers),
      nominal_offer_gross_minor: measure(totals.eligible_nominal, eligibilityBlockers),
      standard_price_gross_minor: measure(totals.eligible_standard, eligibilityBlockers),
      unclassified_price_gross_minor: measure(totals.eligible_unclassified, eligibilityBlockers),
      distinct_paid_subjects: counted(paidSubjects.size, subjectBlockers)
    },
    raw_provider_recognized: {
      note: 'Every counted live charge in the snapshot, including internal, staff, quality-assurance and unverified subjects. This is a provider-side record total. It is not an eligible customer value, not settled cash and not revenue.',
      gross_recognized_minor: measure(totals.raw_gross, derivationBlockers),
      processed_refunds_minor: measure(totals.raw_refunds, derivationBlockers),
      net_recognized_minor: measure(totals.raw_net, derivationBlockers)
    }
  };

  const notDerived = [
    { metric: 'settled_cash', value: null, reason: 'No bank settlement source is supplied or reconciled. Captured amounts are not bank cash.' },
    { metric: 'monthly_recurring_revenue', value: null, reason: 'Recurring terms are not established by this snapshot. One-off nominal charges are not recurring revenue.' },
    { metric: 'conversion_rate', value: null, reason: 'No eligible checkout or cohort denominator is supplied. Buyer receipts are never a denominator.' },
    { metric: 'cohort_retention', value: null, reason: 'No consented cohort export with a complete observation window is supplied.' },
    { metric: 'gateway_fees_and_taxes', value: null, reason: 'Fees, taxes and adjustments are not present in the supplied sources.' },
    { metric: 'refund_rate', value: null, reason: 'A published rate requires the approved eligible denominator and minimum-cohort policy in office/measurement-contract.json.' }
  ];

  const severityRank = { blocking: 0, review: 1, info: 2 };
  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.code.localeCompare(b.code) || JSON.stringify(a.refs).localeCompare(JSON.stringify(b.refs)) || JSON.stringify(a.subject).localeCompare(JSON.stringify(b.subject)));
  const counts = { blocking: 0, review: 0, info: 0 };
  for (const item of findings) counts[item.severity] += 1;
  const overall = counts.blocking ? 'hold' : counts.review ? 'manual_review_required' : 'no_findings';

  const report = {
    schema_version: SCHEMA_VERSION,
    report_kind: REPORT_KIND,
    contract_ref: CONTRACT_REF,
    report_generated_at: now,
    report_generated_at_note: 'Tool run time. It is not a data watermark and no record timestamp is inferred from it.',
    authorization: {
      mode: 'read_only_offline',
      network_calls: false,
      database_access: false,
      provider_api_calls: false,
      filesystem_writes: false,
      money_moved: false,
      remediation_statements_generated: false,
      claim: 'This report reconciles supplied snapshot records only. It does not establish that any money was collected, refunded, settled or corrected.'
    },
    input: {
      documents: documents.map(doc => ({ position: doc.position, snapshot_id: doc.snapshot_id, snapshot_generated_at: doc.generated_at, digest: doc.digest })),
      documents_note: 'Files are identified by position and content digest. Filenames are never read into the report because a filename can carry personal data.',
      record_counts: Object.fromEntries(SOURCE_KEYS.map(key => [key, sources[key].record_count]))
    },
    sources: Object.fromEntries(SOURCE_KEYS.map(key => [key, {
      present: sources[key].present,
      files: sources[key].files,
      complete: sources[key].complete,
      as_of: sources[key].as_of,
      as_of_note: 'The earliest watermark declared by any supplied file for this source. Records dated later are outside at least one file\u2019s coverage.',
      currency: sources[key].currency,
      amount_unit: sources[key].amount_unit,
      refund_status: sources[key].refund_status,
      record_count: sources[key].record_count,
      records_beyond_watermark: sources[key].records_beyond_watermark,
      records_beyond_reconciliation_coverage: sources[key].records_beyond_coverage,
      usable_for_actuals: sources[key].usable_for_actuals,
      reasons: sources[key].reasons
    }])),
    coverage: {
      as_of: coverage.as_of,
      limited_by: coverage.limited_by,
      note: 'The window every supplied source covers, bounded by the report run time. A record dated after it is reported as outside cross-source coverage rather than counted.'
    },
    identity: {
      subjects_seen: subjects.size,
      classes: identityClasses,
      ambiguous_findings: findings.filter(item => item.code === 'ambiguous_identity').length,
      values_reused_across_kinds: findings.filter(item => item.code === 'identity_value_reused_across_kinds').length,
      eligibility_contradictions: eligibilityContradictions,
      entitlements_without_identity: entitlementsWithoutIdentity,
      note: 'Subjects are reported as deterministic hashes of the identity kind together with the value. Raw identifiers, emails and account data are never emitted, and identity keys are never merged automatically.'
    },
    charges: {
      raw_records: sources.provider_purchases.record_count,
      distinct_charges: charges.size,
      duplicates_collapsed: duplicatesCollapsed,
      counted_charges: countedCharges.length,
      eligible_customer_charges: eligibleCharges.length,
      eligibility: eligibilityCounts,
      partially_refunded_charges: partiallyRefundedCharges,
      fully_refunded_charges: fullyRefundedCharges,
      excluded
    },
    refunds: {
      raw_records: sources.provider_refunds.record_count,
      distinct_refunds: refunds.size,
      duplicates_collapsed: refundDuplicates,
      missing_reference: missingRefundReferences,
      processed_applied: [...refunds.values()].filter(refund => refund.applied).length,
      zero_amount: zeroRefunds,
      pending_or_unknown: pendingRefunds,
      verification_withheld: verificationWithheld,
      unmatched: unmatchedRefunds,
      contradicted: mismatchedRefunds,
      on_excluded_charges: refundsOnExcludedCharges
    },
    ledger: {
      raw_records: sources.ledger_events.record_count,
      distinct_events: ledger.size,
      duplicates_collapsed: ledgerDuplicates,
      events_without_identifier: eventsWithoutId,
      events_missing_receipt_evidence: eventsMissingReceiptEvidence,
      paid_cursor_contradictions: cursorContradictions,
      applied_reason_contradictions: reasonContradictions,
      ordering_indeterminate_groups: indeterminateOrderGroups,
      out_of_order_groups: outOfOrderGroups,
      cursor_regressions: cursorRegressions,
      charges_without_ledger_event: chargesWithoutLedger,
      ledger_events_without_provider_record: ledgerWithoutProvider
    },
    derived_actuals: derived,
    not_derived: notDerived,
    findings,
    summary: {
      overall,
      counts,
      actions_present: [...new Set(findings.map(item => item.suggested_action))].sort(),
      eligible_customer_status: eligibilityBlockers.length ? 'unknown' : 'known',
      raw_provider_status: derivationBlockers.length ? 'unknown' : 'known',
      distinct_paid_subjects_status: subjectBlockers.length ? 'unknown' : 'known',
      blockers: derivationBlockers,
      eligibility_blockers: eligibilityBlockers,
      subject_count_blockers: subjectBlockers
    },
    limitations: [
      'Snapshot facts only. A missing, incomplete or out-of-coverage source is unknown, never zero.',
      'Each supplied file must declare its own currency, amount unit, refund reflection and watermark. Metadata is never inherited from another file, and records dated after the earliest common watermark for their source, after the coverage every supplied source shares, or after the report run time are outside coverage.',
      'Amounts are integer minor units of the declared source currency, accumulated exactly. No conversion, rounding, fee model or lossy total is applied.',
      'Only a refund declared verified against the provider record reduces an amount. That verification concerns the refund receipt and is separate from whether the paying account is verified.',
      'Suggested actions are hold, manual review or preserve-as-recorded. No corrective SQL, refund, revocation or write of any kind is produced.',
      'Null-expiry and nominal launch-offer terms are preserved exactly as recorded; no renewal term, subscription term or price change is inferred, and a partial or zero refund is never read as a full refund.',
      'Identity keys are typed. Account UUIDs and legacy email-derived keys are separate subjects and linking them requires authorized manual review.',
      'Eligible customer values exclude internal, staff, quality-assurance and unverified subjects, and are withheld when sources disagree about a subject. The provider-side total is a record total only.',
      'No value here is bank settlement, profit, recurring revenue, a customer count or evidence that any money was collected or returned.'
    ]
  };

  assertNoSensitiveOutput(report);
  return report;
}

function assertNoSensitiveOutput(value, pathParts = []) {
  if (typeof value === 'string') {
    for (const pattern of REDACTION_PATTERNS) {
      if (pattern.test(value)) fail('redaction_violation', `Refusing to emit output that matches ${pattern.name} at ${pathParts.join('.') || '<root>'}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveOutput(item, pathParts.concat(String(index))));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertNoSensitiveOutput(key, pathParts.concat(key));
      assertNoSensitiveOutput(item, pathParts.concat(key));
    }
  }
}

// Only a bare errno is ever echoed from a failed filesystem call.
function errnoOf(error) {
  return error && typeof error.code === 'string' && /^E[A-Z]+$/.test(error.code) ? error.code : null;
}

// Errors are described by position, never by filename: a filename can carry a
// person's name or number, and error text is written to a terminal or a log.
function readOpenSnapshot(fd, where, budget) {
  // The size check and the read share one descriptor, so the path cannot be
  // swapped for a larger or different file in between.
  let stat = null;
  try {
    stat = fs.fstatSync(fd);
  } catch (error) {
    fail('input_unreadable', `Cannot inspect ${where}`, errnoOf(error));
  }
  if (!stat.isFile()) fail('input_unreadable', `${where} is not a regular file`);
  if (stat.size > MAX_INPUT_BYTES) fail('input_too_large', `${where} exceeds the per-file limit of ${MAX_INPUT_BYTES} bytes`);
  if (stat.size > budget.remaining) fail('input_too_large', `${where} exceeds the remaining total input budget of ${MAX_TOTAL_INPUT_BYTES} bytes for this run`);
  const limit = stat.size;
  const buffer = Buffer.alloc(limit);
  let read = 0;
  while (read < limit) {
    let chunk = 0;
    try {
      chunk = fs.readSync(fd, buffer, read, limit - read, read);
    } catch (error) {
      fail('input_unreadable', `Cannot read ${where}`, errnoOf(error));
    }
    if (chunk === 0) break;
    read += chunk;
  }
  // The growth probe fails closed. A probe that cannot be performed leaves it
  // unknown whether the file changed under the descriptor, and an unknown is
  // never reported as a clean read.
  let extra = 0;
  try {
    extra = fs.readSync(fd, Buffer.alloc(1), 0, 1, read);
  } catch (error) {
    fail('input_unreadable', `Cannot confirm the checked size of ${where} after reading it`, errnoOf(error));
  }
  if (extra > 0) fail('input_too_large', `${where} grew past its checked size while it was being read`);
  budget.remaining -= read;
  const text = buffer.subarray(0, read).toString('utf8');
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    fail('malformed_json', `${where} is not valid JSON`);
  }
  return { data, text };
}

function readSnapshotFile(file, position, budget) {
  const where = `snapshot file ${position}`;
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    fail('input_unreadable', `Cannot open ${where}`, errnoOf(error));
  }
  let result = null;
  let failure = null;
  try {
    result = readOpenSnapshot(fd, where, budget);
  } catch (error) {
    // Anything that escapes the wrappers is still reduced to a bare error
    // number, so an unexpected failure can never carry a path to stderr.
    failure = error instanceof ReconcileError ? error : new ReconcileError('input_unreadable', `Cannot read ${where}`, errnoOf(error));
  }
  // The descriptor is always released, and a close that fails is reported
  // rather than swallowed, without masking the failure that came first.
  let closeFailure = null;
  try {
    fs.closeSync(fd);
  } catch (error) {
    closeFailure = new ReconcileError('input_unreadable', `Cannot close ${where}`, errnoOf(error));
  }
  if (failure) throw failure;
  if (closeFailure) throw closeFailure;
  return result;
}

function errorPayload(error) {
  const payload = { ok: false, code: error.code, message: error.message, detail: error.detail === undefined ? null : error.detail };
  try {
    assertNoSensitiveOutput(payload);
  } catch (redaction) {
    return JSON.stringify({ ok: false, code: error.code, message: 'Details withheld: the message would have carried a value this tool refuses to emit.', detail: null }) + '\n';
  }
  return JSON.stringify(payload) + '\n';
}

function usageError(message) {
  return { code: 2, stdout: '', stderr: JSON.stringify({ ok: false, code: 'usage', message, detail: null }) + '\n' };
}

const USAGE = [
  'Usage: node scripts/reconcile-billing.cjs <snapshot.json> [more-snapshots.json ...] [options]',
  '',
  'Offline, read-only reconciliation of authorized billing snapshots.',
  'Reads only the JSON files named on the command line and writes a report to stdout.',
  '',
  'Options:',
  '  --pretty              Indent the JSON report.',
  '  --fail-on-blocking    Exit 3 when a blocking finding is present.',
  '  --now <iso>           Fix the report generation timestamp (for reproducible runs).',
  '  --help                Print this message.',
  '',
  'Exit codes: 0 report produced, 2 usage or malformed input, 3 blocking findings with --fail-on-blocking.',
  `Input limits: ${MAX_INPUT_BYTES} bytes per file and ${MAX_TOTAL_INPUT_BYTES} bytes in total for one run.`,
  'Errors identify a file by its position on the command line, never by its name.',
  `Field definitions: ${CONTRACT_REF}`
].join('\n');

function main(argv) {
  const files = [];
  const options = { pretty: false, failOnBlocking: false, now: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { code: 0, stdout: USAGE + '\n', stderr: '' };
    else if (arg === '--pretty') options.pretty = true;
    else if (arg === '--fail-on-blocking') options.failOnBlocking = true;
    else if (arg === '--now') {
      index += 1;
      options.now = argv[index];
      if (options.now === undefined) return usageError('--now requires an ISO-8601 value');
    } else if (arg.startsWith('-')) return usageError(`Unknown option at argument ${index + 1}`);
    else files.push(arg);
  }
  if (!files.length) return { code: 2, stdout: '', stderr: JSON.stringify({ ok: false, code: 'usage', message: 'At least one snapshot file is required', detail: null }) + '\n' + USAGE + '\n' };
  try {
    const budget = { remaining: MAX_TOTAL_INPUT_BYTES };
    const documents = files.map((file, index) => readSnapshotFile(file, index + 1, budget));
    const report = reconcile({ documents, now: options.now });
    const text = JSON.stringify(report, null, options.pretty ? 2 : 0) + '\n';
    const code = options.failOnBlocking && report.summary.counts.blocking ? 3 : 0;
    return { code, stdout: text, stderr: '' };
  } catch (error) {
    if (error instanceof ReconcileError) return { code: 2, stdout: '', stderr: errorPayload(error) };
    throw error;
  }
}

if (require.main === module) {
  const result = main(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

module.exports = {
  SCHEMA_VERSION,
  REPORT_KIND,
  CONTRACT_REF,
  SOURCE_KEYS,
  ACTIONS,
  SEVERITIES,
  BLOCK_SCOPES,
  INTERNAL_ACCOUNT_CLASSES,
  EXTERNAL_ACCOUNT_CLASSES,
  LEDGER_SKIP_REASONS,
  SEMANTIC_PAID_STATUSES,
  MAX_INPUT_BYTES,
  MAX_TOTAL_INPUT_BYTES,
  FINDING_CODES,
  ReconcileError,
  reconcile,
  hashRef,
  subjectRefHash,
  assertNoSensitiveOutput,
  main,
  USAGE
};
