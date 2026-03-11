import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const dbPath = path.join(dataDir, "travelbuddy.db");
const envPath = path.join(__dirname, ".env");

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(envPath);

const port = Number(process.env.PORT || 3000);
const groqApiKey = process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== "your_groq_api_key_here" ? process.env.GROQ_API_KEY : "";
const groqModel = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const openAiApiKey = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== "your_openai_api_key_here" ? process.env.OPENAI_API_KEY : "";
const openAiModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";

if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_records_type ON records(type);
`);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS"
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS"
  });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

function normalizeRecord(input) {
  const now = new Date().toISOString();
  const id = typeof input.__backendId === "string" && input.__backendId.trim() ? input.__backendId.trim() : crypto.randomUUID();
  const createdAt = typeof input.created_at === "string" && input.created_at.trim() ? input.created_at : now;
  return { ...input, __backendId: id, created_at: createdAt, updated_at: now };
}

function getAllRecords() {
  return db.prepare(`SELECT id, payload FROM records ORDER BY datetime(created_at) ASC, rowid ASC`).all().map((row) => {
    const payload = JSON.parse(row.payload);
    payload.__backendId = row.id;
    return payload;
  });
}

function getRecordById(id) {
  const row = db.prepare(`SELECT id, payload FROM records WHERE id = ?`).get(id);
  if (!row) return null;
  const payload = JSON.parse(row.payload);
  payload.__backendId = row.id;
  return payload;
}

function createRecord(record) {
  db.prepare(`INSERT INTO records (id, type, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
    record.__backendId,
    record.type,
    JSON.stringify(record),
    record.created_at,
    record.updated_at
  );
}

function updateRecord(id, record) {
  return db.prepare(`UPDATE records SET type = ?, payload = ?, updated_at = ? WHERE id = ?`).run(
    record.type,
    JSON.stringify(record),
    record.updated_at,
    id
  );
}

function deleteRecord(id) {
  return db.prepare(`DELETE FROM records WHERE id = ?`).run(id);
}

function validateRecord(record) {
  if (!record || typeof record !== "object") return "Record body must be an object.";
  if (typeof record.type !== "string" || !record.type.trim()) return "Record type is required.";
  return null;
}

function extractJson(text) {
  if (!text || typeof text !== "string") throw new Error("AI response was empty.");
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) throw new Error("AI did not return valid JSON.");
    return JSON.parse(candidate.slice(start, end + 1));
  }
}

async function callAiJson(prompt) {
  if (!groqApiKey && !openAiApiKey) {
    throw new Error("Add GROQ_API_KEY to use the free Groq tier, or OPENAI_API_KEY if you prefer OpenAI.");
  }

  const apiKey = groqApiKey || openAiApiKey;
  const model = groqApiKey ? groqModel : openAiModel;

  if (groqApiKey) {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model, input: prompt, max_output_tokens: 2200 })
      });
      const payload = await response.json();
      if (response.ok) {
        return { parsed: extractJson(payload.output_text || ""), model };
      }
    } catch {
      // Fallback below.
    }

    const fallback = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: "You are a travel planning assistant. Always return valid JSON only." },
          { role: "user", content: prompt }
        ]
      })
    });
    const payload = await fallback.json();
    if (!fallback.ok) {
      throw new Error(payload?.error?.message || "Groq request failed.");
    }
    return { parsed: extractJson(payload?.choices?.[0]?.message?.content || ""), model };
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model, input: prompt, max_output_tokens: 2200 })
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || "AI request failed.");
  }
  return { parsed: extractJson(payload.output_text || ""), model };
}

async function getAiPlaceDetails(place) {
  const prompt = [
    `Create a travel guide in JSON for: ${place}.`,
    "Return JSON only.",
    "Include these keys exactly:",
    "name, country, overview, best_time_to_visit, ideal_trip_length, budget_level, estimated_daily_budget_inr, top_attractions, activities, foods_to_try, stay_options, transport_tips, safety_tips, itinerary, why_visit.",
    "Rules:",
    "- top_attractions, activities, foods_to_try, stay_options, transport_tips, safety_tips must be arrays of short strings.",
    "- itinerary must be an array of objects with keys day and plan.",
    "- estimated_daily_budget_inr must be a short human-readable string.",
    "- If the place is broad, answer for the most commonly understood travel destination with that name.",
    "- Keep the content practical for real travelers."
  ].join("\n");

  const { parsed, model } = await callAiJson(prompt);
  return { ...parsed, place_query: place, generated_at: new Date().toISOString(), model };
}

async function getAiTripPlan(place, days) {
  const safeDays = days > 0 ? days : 5;
  const prompt = [
    `Create a ${safeDays}-day travel plan in JSON for: ${place}.`,
    "Return JSON only.",
    "Include these keys exactly:",
    "place, trip_length, overview, hotel_suggestions, transport_summary, best_area_to_stay, daily_plan.",
    "Rules:",
    "- hotel_suggestions must be an array of short strings.",
    "- transport_summary must be an array of short strings.",
    "- daily_plan must be an array of objects with keys day, theme, timing, hotel, nearby_viewpoints, visit_points, food_plan, travel_notes.",
    "- timing, nearby_viewpoints, visit_points, food_plan and travel_notes should be arrays of short strings.",
    "- Use realistic travel timing guidance between activities when helpful.",
    "- Mention nearby viewpoints and major visit points every day."
  ].join("\n");

  const { parsed, model } = await callAiJson(prompt);
  return {
    ...parsed,
    place_query: place,
    trip_length: safeDays,
    generated_at: new Date().toISOString(),
    model
  };
}

async function handleApi(req, res, pathname) {
  if (req.method === "OPTIONS") {
    sendText(res, 204, "");
    return;
  }

  if (pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      database: dbPath,
      aiConfigured: Boolean(groqApiKey || openAiApiKey),
      aiProvider: groqApiKey ? "groq" : openAiApiKey ? "openai" : null,
      time: new Date().toISOString()
    });
    return;
  }

  if (pathname === "/api/ai/place-details" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const place = typeof body.place === "string" ? body.place.trim() : "";
      if (!place) {
        sendJson(res, 400, { isOk: false, error: "Place is required." });
        return;
      }
      const details = await getAiPlaceDetails(place);
      sendJson(res, 200, { isOk: true, data: details });
    } catch (error) {
      sendJson(res, 500, { isOk: false, error: error instanceof Error ? error.message : "Failed to generate place details." });
    }
    return;
  }

  if (pathname === "/api/ai/trip-plan" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const place = typeof body.place === "string" ? body.place.trim() : "";
      const days = Number(body.days || 0);
      if (!place) {
        sendJson(res, 400, { isOk: false, error: "Place is required." });
        return;
      }
      const plan = await getAiTripPlan(place, days);
      sendJson(res, 200, { isOk: true, data: plan });
    } catch (error) {
      sendJson(res, 500, { isOk: false, error: error instanceof Error ? error.message : "Failed to generate trip plan." });
    }
    return;
  }

  if (pathname === "/api/data" && req.method === "GET") {
    sendJson(res, 200, { isOk: true, data: getAllRecords() });
    return;
  }

  if (pathname === "/api/data" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const error = validateRecord(body);
      if (error) {
        sendJson(res, 400, { isOk: false, error });
        return;
      }
      const record = normalizeRecord(body);
      createRecord(record);
      sendJson(res, 201, { isOk: true, data: record });
    } catch (error) {
      sendJson(res, 500, { isOk: false, error: error instanceof Error ? error.message : "Failed to create record." });
    }
    return;
  }

  if (pathname.startsWith("/api/data/")) {
    const id = decodeURIComponent(pathname.slice("/api/data/".length));
    if (!id) {
      sendJson(res, 400, { isOk: false, error: "Missing record id." });
      return;
    }

    if (req.method === "GET") {
      const record = getRecordById(id);
      if (!record) {
        sendJson(res, 404, { isOk: false, error: "Record not found." });
        return;
      }
      sendJson(res, 200, { isOk: true, data: record });
      return;
    }

    if (req.method === "PUT") {
      try {
        const body = await readJsonBody(req);
        const existing = getRecordById(id);
        if (!existing) {
          sendJson(res, 404, { isOk: false, error: "Record not found." });
          return;
        }
        const merged = normalizeRecord({ ...existing, ...body, __backendId: id, created_at: existing.created_at });
        const error = validateRecord(merged);
        if (error) {
          sendJson(res, 400, { isOk: false, error });
          return;
        }
        updateRecord(id, merged);
        sendJson(res, 200, { isOk: true, data: merged });
      } catch (error) {
        sendJson(res, 500, { isOk: false, error: error instanceof Error ? error.message : "Failed to update record." });
      }
      return;
    }

    if (req.method === "DELETE") {
      const result = deleteRecord(id);
      if (result.changes === 0) {
        sendJson(res, 404, { isOk: false, error: "Record not found." });
        return;
      }
      sendJson(res, 200, { isOk: true });
      return;
    }
  }

  sendJson(res, 404, { isOk: false, error: "API route not found." });
}

async function serveStaticFile(res, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "Content-Type": mimeTypes[extension] || "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}

async function handleStatic(req, res, pathname) {
  let requestedPath = pathname === "/" ? "/index.html" : pathname;
  requestedPath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, requestedPath);
  try {
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      await serveStaticFile(res, path.join(filePath, "index.html"));
      return;
    }
    await serveStaticFile(res, filePath);
  } catch {
    const html = await readFile(path.join(publicDir, "index.html"), "utf-8");
    sendText(res, 200, html, "text/html; charset=utf-8");
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    await handleStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { isOk: false, error: error instanceof Error ? error.message : "Unexpected server error." });
  }
});

server.listen(port, () => {
  console.log(`TravelBuddy server running at http://localhost:${port}`);
  console.log(`SQLite database: ${dbPath}`);
  console.log(`AI route ready: ${groqApiKey ? "configured with Groq" : openAiApiKey ? "configured with OpenAI" : "missing AI key"}`);
});
