const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "10mb" }));

const CLICKUP_API = "https://api.clickup.com/api/v2";
const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN;
const PORT = process.env.PORT || 3000;

// Meta config
const META_PAGE_TOKEN = process.env.META_PAGE_ACCESS_TOKEN;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "spen-leadgen-2026";

// Target ClickUp list for leads
const LEADS_LIST_ID = process.env.CLICKUP_LEADS_LIST_ID || "901821803899";

// ClickUp custom field IDs for the leads list
const CF = {
  phone:    "4ffb0d82-2ecd-4a0b-b4bf-e3dea64c4a91",
  email:    "08a3d171-30d6-4f3c-9b78-da22e85faecd",
  school:   "25faf7de-31c1-4364-b743-cb7919b18f53",
  source:   "2878ce92-9f49-47e2-83db-1641e44d4b0d",
  program:  "8bdd2257-f75a-47a6-ab4c-78953e447bce",
  ageGroup: "7fa2fee1-b5fc-47dc-9e02-14f402c57ebb",
  subject:  "2777b867-2433-429b-83dc-8baa0648d659",
  howHeard: "0a555c57-5e87-4346-97a5-240892bb43b6",
};

// In-memory dedup cache (resets on deploy; DB-backed dedup below is the primary)
const processedLeads = new Set();

// =============================================
// Health check
// =============================================
app.get("/", (req, res) => res.json({
  status: "ok",
  service: "spen-meta-leadgen",
  hasClickUpToken: !!CLICKUP_TOKEN,
  hasPageToken: !!META_PAGE_TOKEN,
  targetList: LEADS_LIST_ID,
  endpoints: {
    verify:  "GET  /leadgen       - Meta webhook verification",
    webhook: "POST /leadgen       - Meta leadgen webhook (auto-creates ClickUp tasks)",
    sync:    "GET  /leadgen/sync  - Manual sync: ?form_id=XXX&limit=100",
    health:  "GET  /               - This page",
  },
}));

// =============================================
// META WEBHOOK VERIFICATION (GET /leadgen)
// =============================================
app.get("/leadgen", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
    console.log("[Leadgen] Webhook verified");
    return res.status(200).send(challenge);
  }

  console.warn("[Leadgen] Verification failed:", { mode, tokenMatch: token === META_VERIFY_TOKEN });
  return res.sendStatus(403);
});

// =============================================
// META WEBHOOK HANDLER (POST /leadgen)
// =============================================
app.post("/leadgen", async (req, res) => {
  // Respond 200 immediately so Meta does not retry
  res.sendStatus(200);

  const body = req.body;
  if (!body || body.object !== "page") return;

  console.log("[Leadgen] Webhook received");

  for (const entry of (body.entry || [])) {
    for (const change of (entry.changes || [])) {
      if (change.field !== "leadgen") continue;

      const leadgenId = change.value?.leadgen_id;
      const formId    = change.value?.form_id;
      const pageId    = change.value?.page_id;

      if (!leadgenId) {
        console.warn("[Leadgen] Missing leadgen_id, skipping");
        continue;
      }

      // In-memory dedup (fast path)
      if (processedLeads.has(leadgenId)) {
        console.log(`[Leadgen] Already processed ${leadgenId}, skipping`);
        continue;
      }
      processedLeads.add(leadgenId);

      console.log(`[Leadgen] Processing lead ${leadgenId} from form ${formId}`);

      try {
        await processLead(leadgenId, formId, pageId);
      } catch (err) {
        console.error(`[Leadgen] Error processing ${leadgenId}:`, err.message);
      }
    }
  }
});

// =============================================
// Fetch lead details from Meta Graph API
// =============================================
async function fetchLeadDetails(leadgenId) {
  const res = await axios.get(
    `https://graph.facebook.com/v21.0/${leadgenId}`,
    {
      params: {
        access_token: META_PAGE_TOKEN,
        fields: "id,created_time,field_data,form_id,campaign_name,ad_name,adset_name",
      },
    }
  );
  return res.data;
}

// =============================================
// Parse field_data array into a flat key-value object
// =============================================
function parseLeadFields(fieldData) {
  const fields = {};
  for (const item of (fieldData || [])) {
    const key = (item.name || "").toLowerCase().replace(/\s+/g, "_");
    fields[key] = Array.isArray(item.values) ? item.values[0] : item.values;
  }
  return fields;
}

// =============================================
// Dedup: check if phone or email already exists in the list
// =============================================
async function leadExists(phone, email) {
  try {
    let page = 0;
    const cleanPhone = (phone || "").replace(/[^0-9]/g, "").slice(-10);
    const cleanEmail = (email || "").toLowerCase().trim();

    while (true) {
      const res = await axios.get(`${CLICKUP_API}/list/${LEADS_LIST_ID}/task`, {
        headers: { Authorization: CLICKUP_TOKEN },
        params: { include_closed: true, page, subtasks: true },
      });

      const tasks = res.data.tasks || [];
      if (tasks.length === 0) break;

      for (const task of tasks) {
        for (const cf of (task.custom_fields || [])) {
          if (cf.id === CF.phone && cf.value) {
            const taskPhone = String(cf.value).replace(/[^0-9]/g, "").slice(-10);
            if (cleanPhone && taskPhone === cleanPhone) return true;
          }
          if (cf.id === CF.email && cf.value) {
            if (cleanEmail && cf.value.toLowerCase().trim() === cleanEmail) return true;
          }
        }
      }

      // ClickUp returns up to 100 tasks per page
      if (tasks.length < 100) break;
      page++;
    }

    return false;
  } catch (err) {
    console.error("[Leadgen] Dedup check failed:", err.message);
    return false; // Better to create a dup than miss a lead
  }
}

// =============================================
// Map campaign/ad name to source dropdown value
// =============================================
function mapSource(campaignName, adName) {
  const combined = `${campaignName || ""} ${adName || ""}`.toLowerCase();
  if (combined.includes("instagram")) return "instagram";
  if (combined.includes("tiktok")) return "tiktok";
  if (combined.includes("whatsapp")) return "Whatsapp";
  if (combined.includes("facebook")) return "facebook";
  return "Social Media Ad";
}

// =============================================
// Map campaign name to program dropdown value
// =============================================
function mapProgram(campaignName) {
  const name = (campaignName || "").toLowerCase();
  if (name.includes("educator") || name.includes("teacher")) return "\u0627\u0644\u0645\u062f\u0631\u0633\u064a\u0646 ";
  if (name.includes("parent")) return "\u0627\u0644\u0627\u0628\u0627\u0621";
  return null;
}

// =============================================
// Create a ClickUp task from lead data
// =============================================
async function createLeadTask(leadData, formFields, campaignName) {
  const fullName = formFields.full_name || formFields.name
    || formFields["\u0627\u0644\u0627\u0633\u0645"] || "Unknown Lead";
  const phone = formFields.phone_number || formFields.phone
    || formFields["\u0631\u0642\u0645_\u0627\u0644\u0647\u0627\u062a\u0641"] || "";
  const email = formFields.email
    || formFields["\u0627\u0644\u0628\u0631\u064a\u062f_\u0627\u0644\u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a"] || "";
  const school = formFields.school_name || formFields.school
    || formFields["\u0627\u0633\u0645_\u0627\u0644\u0645\u062f\u0631\u0633\u0629"] || "";
  const ageGroup = formFields.age_group
    || formFields["\u0645\u0631\u062d\u0644\u0647_\u0627\u0628\u0646\u0643_\u0627\u0644\u0639\u0645\u0631\u064a\u0647"] || "";
  const subject = formFields.subject
    || formFields["\u0645\u062f\u0631\u0633_\u0645\u0627\u062f\u0629_\u0625\u064a\u0647"] || "";
  const howHeard = formFields.how_did_you_hear
    || formFields["\u0639\u0631\u0641\u062a\u0646\u0627_\u0645\u0646\u064a\u0646"] || "";

  const customFields = [];

  if (phone)    customFields.push({ id: CF.phone, value: phone });
  if (email)    customFields.push({ id: CF.email, value: email });
  if (school)   customFields.push({ id: CF.school, value: school });
  if (subject)  customFields.push({ id: CF.subject, value: subject });
  if (howHeard) customFields.push({ id: CF.howHeard, value: howHeard });

  // Source from campaign/ad context
  customFields.push({ id: CF.source, value: mapSource(campaignName, leadData.ad_name) });

  // Program from campaign name
  const program = mapProgram(campaignName);
  if (program) customFields.push({ id: CF.program, value: program });

  // Age group mapping
  if (ageGroup) {
    const ageMap = { "5-8": "5-8", "9-12": "9-12", "13-18": "13-18" };
    customFields.push({ id: CF.ageGroup, value: ageMap[ageGroup] || ageGroup });
  }

  const createdAt = leadData.created_time
    ? new Date(leadData.created_time).toLocaleDateString("en-GB", { timeZone: "Asia/Riyadh" })
    : new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Riyadh" });

  const descLines = [
    `**Lead Name:** ${fullName}`,
    `**Phone:** ${phone}`,
    `**Email:** ${email}`,
    school ? `**School:** ${school}` : null,
    `**Source:** Meta Lead Gen Form`,
    campaignName ? `**Campaign:** ${campaignName}` : null,
    leadData.adset_name ? `**Ad Set:** ${leadData.adset_name}` : null,
    leadData.ad_name ? `**Ad:** ${leadData.ad_name}` : null,
    `**Submitted:** ${createdAt}`,
    `**Meta Lead ID:** ${leadData.id}`,
  ].filter(Boolean);

  const taskRes = await axios.post(
    `${CLICKUP_API}/list/${LEADS_LIST_ID}/task`,
    {
      name: fullName,
      description: descLines.join("\n"),
      status: "to do",
      custom_fields: customFields,
    },
    { headers: { Authorization: CLICKUP_TOKEN, "Content-Type": "application/json" } }
  );

  return taskRes.data;
}

// =============================================
// Main processing pipeline
// =============================================
async function processLead(leadgenId, formId, pageId) {
  // 1. Fetch full lead from Meta
  const leadData = await fetchLeadDetails(leadgenId);
  const formFields = parseLeadFields(leadData.field_data);
  const campaignName = leadData.campaign_name || "";

  const name = formFields.full_name || formFields.name || "Unknown";
  console.log(`[Leadgen] Lead: ${name} | Campaign: ${campaignName}`);

  // 2. Dedup by phone / email
  const phone = formFields.phone_number || formFields.phone || "";
  const email = formFields.email || "";

  if (phone || email) {
    const exists = await leadExists(phone, email);
    if (exists) {
      console.log(`[Leadgen] Duplicate (phone: ${phone}, email: ${email}). Skipped.`);
      return;
    }
  }

  // 3. Create ClickUp task
  const task = await createLeadTask(leadData, formFields, campaignName);
  console.log(`[Leadgen] Task created: ${task.id} - ${name}`);
}

// =============================================
// Manual sync: pull all leads from a form and backfill
// GET /leadgen/sync?form_id=XXX&limit=100
// =============================================
app.get("/leadgen/sync", async (req, res) => {
  if (!META_PAGE_TOKEN) {
    return res.status(500).json({ error: "META_PAGE_ACCESS_TOKEN not configured" });
  }

  const formId = req.query.form_id;
  if (!formId) {
    return res.status(400).json({
      error: "Missing ?form_id= parameter",
      usage: "/leadgen/sync?form_id=YOUR_FORM_ID&limit=100",
    });
  }

  const limit = parseInt(req.query.limit) || 100;
  console.log(`[Leadgen] Manual sync: form ${formId}, limit ${limit}`);

  try {
    const formRes = await axios.get(
      `https://graph.facebook.com/v21.0/${formId}/leads`,
      { params: { access_token: META_PAGE_TOKEN, limit, fields: "id,created_time,field_data" } }
    );

    const leads = formRes.data?.data || [];
    let created = 0;
    let skipped = 0;

    for (const lead of leads) {
      const formFields = parseLeadFields(lead.field_data);
      const phone = formFields.phone_number || formFields.phone || "";
      const email = formFields.email || "";

      if (phone || email) {
        const exists = await leadExists(phone, email);
        if (exists) { skipped++; continue; }
      }

      await createLeadTask(lead, formFields, "Manual Sync");
      created++;
      await new Promise(r => setTimeout(r, 500));
    }

    res.json({ success: true, total: leads.length, created, skipped });
    console.log(`[Leadgen] Sync done: ${created} created, ${skipped} dupes`);
  } catch (err) {
    console.error("[Leadgen] Sync error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// =============================================
// Start server
// =============================================
app.listen(PORT, () => {
  console.log(`\n=== SPEN Meta Leadgen Webhook ===");
  console.log(`Port:            ${PORT}`);
  console.log(`ClickUp token:   ${CLICKUP_TOKEN ? "present" : "MISSING"}`);
  console.log(`Meta page token: ${META_PAGE_TOKEN ? "present" : "MISSING"}`);
  console.log(`Target list:     ${LEADS_LIST_ID}`);
  console.log(`Verify token:    ${META_VERIFY_TOKEN}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET  /             Health check`);
  console.log(`  GET  /leadgen      Meta webhook verification`);
  console.log(`  POST /leadgen      Meta webhook handler`);
  console.log(`  GET  /leadgen/sync Manual form sync\n`);
});
