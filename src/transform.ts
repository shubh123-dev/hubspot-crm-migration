import { HsAssociationType, HsObject, HsOwner, HsPropertyDefinition } from "./hubspot";
import { Row } from "./db";

// HubSpot returns every property value as a string (or null). These helpers are
// deliberately lenient: an unparseable value becomes NULL in the typed column,
// while the original string is always preserved in `properties`.

export function str(v: string | null | undefined): string | null {
  return v === undefined || v === null || v === "" ? null : v;
}

export function int(v: string | null | undefined): number | null {
  if (!str(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function bool(v: string | null | undefined): boolean | null {
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

/** Accepts ISO datetimes, YYYY-MM-DD dates, and epoch seconds/milliseconds. */
export function ts(v: string | null | undefined): string | null {
  const s = str(v)?.trim();
  if (!s) return null;
  let d: Date;
  if (/^\d{13}$/.test(s)) d = new Date(Number(s));
  else if (/^\d{10}$/.test(s)) d = new Date(Number(s) * 1000);
  else d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const json = (v: unknown) => JSON.stringify(v ?? null);

export function propertyDefinitionRow(objectType: string, p: HsPropertyDefinition): Row {
  return {
    object_type: objectType,
    name: p.name,
    label: p.label,
    type: p.type,
    field_type: p.fieldType,
    group_name: p.groupName,
    options: json(p.options ?? []),
    is_custom: p.hubspotDefined === undefined ? null : !p.hubspotDefined,
    raw: json(p),
  };
}

export function ownerRow(o: HsOwner): Row {
  return {
    id: String(o.id),
    user_id: o.userId === undefined ? null : String(o.userId),
    email: o.email ?? null,
    first_name: o.firstName ?? null,
    last_name: o.lastName ?? null,
    teams: json(o.teams ?? []),
    archived: !!o.archived,
    hs_created_at: ts(o.createdAt),
    hs_updated_at: ts(o.updatedAt),
    raw: json(o),
  };
}

function base(o: HsObject): Row {
  return {
    id: String(o.id),
    properties: json(o.properties),
    archived: !!o.archived,
    hs_created_at: ts(o.createdAt ?? o.properties.createdate ?? o.properties.hs_createdate),
    hs_updated_at: ts(o.updatedAt ?? o.properties.hs_lastmodifieddate ?? o.properties.lastmodifieddate),
  };
}

export function companyRow(o: HsObject): Row {
  const p = o.properties;
  return {
    ...base(o),
    name: str(p.name),
    domain: str(p.domain),
    industry: str(p.industry),
    lifecycle_stage: str(p.lifecyclestage),
    owner_id: str(p.hubspot_owner_id),
    notes_last_contacted: ts(p.notes_last_contacted),
    notes_last_updated: ts(p.notes_last_updated),
    last_sales_activity_at: ts(p.hs_last_sales_activity_timestamp),
    ai_sequence_step: int(p.ai_sequence_step),
    ai_last_email_sent: ts(p.ai_last_email_sent),
    ai_last_message_id: str(p.ai_last_message_id),
    ai_message_id_history: str(p.ai_message_id_history),
    ai_last_contact_id: str(p.ai_last_contact_id),
    ai_email_status: str(p.ai_email_status),
    ai_requeue_date: ts(p.ai_requeue_date),
    ai_targeting_bracket: str(p.ai_targeting_bracket),
    ai_active_contact_tier: str(p.ai_active_contact_tier),
    ai_verification_status: str(p.ai_verification_status),
    outreach_status: str(p.outreach_status),
    outreach_status_reason: str(p.outreach_status_reason),
  };
}

export function contactRow(o: HsObject): Row {
  const p = o.properties;
  return {
    ...base(o),
    email: str(p.email),
    first_name: str(p.firstname),
    last_name: str(p.lastname),
    job_title: str(p.jobtitle),
    owner_id: str(p.hubspot_owner_id),
    lifecycle_stage: str(p.lifecyclestage),
    lead_status: str(p.hs_lead_status),
    email_opted_out: bool(p.hs_email_optout),
    email_bad_address: bool(p.hs_email_bad_address),
    ai_contact_sequence_priority: str(p.ai_contact_sequence_priority),
    contact_email_status: str(p.contact_email_status),
    contact_email_status_reason: str(p.contact_email_status_reason),
    contact_email_status_date: ts(p.contact_email_status_date),
    neverbounce_email_status: str(p.neverbounce_email_status),
  };
}

// Per engagement type: which HubSpot property holds the subject / body / status.
const ENGAGEMENT_FIELDS: Record<string, { subject?: string; body: string; status?: string }> = {
  email:   { subject: "hs_email_subject",  body: "hs_email_text",  status: "hs_email_status" },
  note:    {                                body: "hs_note_body" },
  call:    { subject: "hs_call_title",     body: "hs_call_body",   status: "hs_call_status" },
  meeting: { subject: "hs_meeting_title",  body: "hs_meeting_body", status: "hs_meeting_outcome" },
  task:    { subject: "hs_task_subject",   body: "hs_task_body",   status: "hs_task_status" },
};

export function engagementRow(type: string, o: HsObject): Row {
  const p = o.properties;
  const f = ENGAGEMENT_FIELDS[type];
  return {
    ...base(o),
    type,
    occurred_at: ts(p.hs_timestamp),
    owner_id: str(p.hubspot_owner_id),
    subject: f.subject ? str(p[f.subject]) : null,
    // Emails: fall back to the HTML body when there is no plain-text body.
    body: str(p[f.body]) ?? (type === "email" ? str(p.hs_email_html) : null),
    direction: type === "email" ? str(p.hs_email_direction) : null,
    status: f.status ? str(p[f.status]) : null,
  };
}

/** Company -> contact type 2 / label "Primary" marks the contact's primary company. */
export function isPrimary(types: HsAssociationType[]): boolean {
  return types.some((t) => (t.category === "HUBSPOT_DEFINED" && t.typeId === 2) || t.label === "Primary");
}
