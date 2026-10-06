import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var ${name} (see .env.example)`);
    process.exit(1);
  }
  return value;
}

export const config = {
  get hubspotToken() { return required("HUBSPOT_TOKEN"); },
  get databaseUrl()  { return required("DATABASE_URL"); },
  hubspotBaseUrl:     process.env.HUBSPOT_BASE_URL || "https://api.hubapi.com",
  hubspotMinInterval: Number(process.env.HUBSPOT_MIN_INTERVAL_MS || 110),
  pgSsl:              process.env.PGSSL === "true",
};

// Engagement object types to import, as HubSpot v3 object names -> our `type` column.
export const ENGAGEMENT_TYPES: Record<string, string> = {
  emails:   "email",
  notes:    "note",
  calls:    "call",
  meetings: "meeting",
  tasks:    "task",
};
