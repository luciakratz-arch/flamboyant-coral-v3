process.env.RAILWAY_DISABLE_HOST_CHECK = "true";
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { randomBytes } = require("crypto");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const db = { query: (text, params) => pool.query(text, params) };

const app = express();
app.use(cors({ origin: "*" }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: "10mb" }));

// MIGRATE
async function migrate() {
  await db.query(`CREATE TABLE IF NOT EXISTS members (id SERIAL PRIMARY KEY, name TEXT NOT NULL, voice_part TEXT, role TEXT DEFAULT 'corista', phone TEXT, email TEXT, cpf TEXT, rg TEXT, birthday DATE, start_date DATE NOT NULL, end_date DATE, status TEXT NOT NULL DEFAULT 'active', profile_photo TEXT, notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await db.query(`CREATE TABLE IF NOT EXISTS songs (id SERIAL PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, composer TEXT, lyrics TEXT, notes TEXT, video_url TEXT, sheet_music_url TEXT, audio_original_url TEXT, audio_arranjo_url TEXT, playback_url TEXT, soprano_url TEXT, mezzo_url TEXT, contralto_url TEXT, tenor_url TEXT, baritono_url TEXT, baixo_url TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await db.query(`CREATE TABLE IF NOT EXISTS events (id SERIAL PRIMARY KEY, title TEXT NOT NULL, date DATE NOT NULL, type TEXT NOT NULL DEFAULT 'ensaio', status TEXT NOT NULL DEFAULT 'confirmado', planning_status TEXT NOT NULL DEFAULT 'planejada', arrival_time TEXT, presentation_time TEXT, outfit TEXT, location TEXT, maps_url TEXT, notes TEXT, recurrence_group_id TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await db.query(`CREATE TABLE IF NOT EXISTS event_setlist (id SERIAL PRIMARY KEY, event_id INTEGER REFERENCES events(id) ON DELETE CASCADE, song_id INTEGER REFERENCES songs(id) ON DELETE CASCADE, position INTEGER DEFAULT 0)`);
  await db.query(`CREATE TABLE IF NOT EXISTS event_attendances (id SERIAL PRIMARY KEY, event_id INTEGER REFERENCES events(id) ON DELETE CASCADE, member_id INTEGER REFERENCES members(id) ON DELETE CASCADE, status TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await db.query(`CREATE TABLE IF NOT EXISTS announcements (id SERIAL PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await db.query(`CREATE TABLE IF NOT EXISTS coral_settings (id SERIAL PRIMARY KEY, logo_data TEXT, signature_data TEXT, coral_name TEXT, conductor_name TEXT, producer_name TEXT, primary_color TEXT, secondary_color TEXT, rh_name TEXT, rh_password TEXT, admin_password TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await db.query(`CREATE TABLE IF NOT EXISTS study_materials (id SERIAL PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, media_type TEXT NOT NULL DEFAULT 'video', url TEXT, content TEXT, description TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await db.query(`CREATE TABLE IF NOT EXISTS access_logs (id SERIAL PRIMARY KEY, member_id INTEGER NOT NULL, member_name TEXT NOT NULL, accessed_at TIMESTAMPTZ DEFAULT NOW())`);
  await db.query(`CREATE TABLE IF NOT EXISTS attendance_sessions (id SERIAL PRIMARY KEY, event_id INTEGER REFERENCES events(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, duration_minutes INTEGER DEFAULT 60, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await db.query(`CREATE TABLE IF NOT EXISTS attendance_records (id SERIAL PRIMARY KEY, session_id INTEGER REFERENCES attendance_sessions(id) ON DELETE CASCADE, event_id INTEGER REFERENCES events(id) ON DELETE CASCADE, member_id INTEGER REFERENCES members(id) ON DELETE CASCADE, member_name TEXT NOT NULL, voice_part TEXT, checked_in_at TIMESTAMPTZ DEFAULT NOW())`);
  await db.query(`CREATE TABLE IF NOT EXISTS blog_posts (id SERIAL PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, image_data TEXT, event_id INTEGER, author_role TEXT DEFAULT 'admin', youtube_url TEXT, instagram_url TEXT, external_url TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  console.log("Tabelas OK!");
}

// HEALTH
app.get("/api/healthz", (_req, res) => res.json({ status: "ok" }));

// SETTINGS
app.get("/api/settings", async (_req, res) => {
  try {
    let r = await db.query("SELECT * FROM coral_settings LIMIT 1");
    if (r.rows.length === 0) { await db.query("INSERT INTO coral_settings DEFAULT VALUES"); r = await db.query("SELECT * FROM coral_settings LIMIT 1"); }
    res.json(serializeSettings(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/settings", async (req, res) => {
  try {
    const d = req.body;
    const fields = ["logo_data","signature_data","coral_name","conductor_name","producer_name","primary_color","secondary_color","rh_name","rh_password","admin_password"];
    const keys = Object.keys(d).map(k => k.replace(/([A-Z])/g, "_$1").toLowerCase()).filter(k => fields.includes(k));
    if (keys.length === 0) { const r = await db.query("SELECT * FROM coral_settings LIMIT 1"); return res.json(serializeSettings(r.rows[0])); }
    const sets = keys.map((k, i) => `${k} = $${i+1}`).join(", ");
    const vals = keys.map(k => d[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())]);
    let r = await db.query("SELECT id FROM coral_settings LIMIT 1");
    if (r.rows.length === 0) await db.query("INSERT INTO coral_settings DEFAULT VALUES");
    r = await db.query("SELECT id FROM coral_settings LIMIT 1");
    await db.query(`UPDATE coral_settings SET ${sets}, updated_at = NOW() WHERE id = $${keys.length+1}`, [...vals, r.rows[0].id]);
    r = await db.query("SELECT * FROM coral_settings LIMIT 1");
    res.json(serializeSettings(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
function serializeSettings(s) {
  return { id: s.id, logoData: s.logo_data, signatureData: s.signature_data, coralName: s.coral_name, conductorName: s.conductor_name, producerName: s.producer_name, primaryColor: s.primary_color, secondaryColor: s.secondary_color, rhName: s.rh_name, rhPassword: s.rh_password, adminPassword: s.admin_password, updatedAt: s.updated_at };
}

// MEMBERS
app.get("/api/members/stats", async (_req, res) => {
  try {
    const r = await db.query("SELECT * FROM members");
    const all = r.rows;
    const currentMonth = new Date().getMonth() + 1;
    const birthdays = all.filter(m => m.birthday && new Date(m.birthday).getMonth() + 1 === currentMonth).map(m => ({ id: m.id, name: m.name, birthday: m.birthday }));
    res.json({ total: all.length, active: all.filter(m => m.status === "active").length, inactive: all.filter(m => m.status === "inactive").length, birthdays });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/members", async (req, res) => {
  try {
    const { status } = req.query;
    const r = status ? await db.query("SELECT * FROM members WHERE status = $1 ORDER BY name", [status]) : await db.query("SELECT * FROM members ORDER BY name");
    res.json(r.rows.map(serializeMember));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/members", async (req, res) => {
  try {
    const d = req.body;
    if (!d.name || !d.startDate) return res.status(400).json({ error: "name e startDate obrigatórios" });
    const r = await db.query("INSERT INTO members (name,voice_part,role,phone,email,cpf,rg,birthday,start_date,end_date,status,profile_photo,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *",
      [d.name,d.voicePart??null,d.role??"corista",d.phone??null,d.email??null,d.cpf??null,d.rg??null,d.birthday??null,d.startDate,d.endDate??null,d.status??"active",d.profilePhoto??null,d.notes??null]);
    res.status(201).json(serializeMember(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/members/:id", async (req, res) => {
  try {
    const r = await db.query("SELECT * FROM members WHERE id = $1", [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: "Não encontrado" });
    res.json(serializeMember(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/members/:id", async (req, res) => {
  try {
    const d = req.body;
    const map = { name:"name",voicePart:"voice_part",role:"role",phone:"phone",email:"email",cpf:"cpf",rg:"rg",birthday:"birthday",startDate:"start_date",endDate:"end_date",status:"status",profilePhoto:"profile_photo",notes:"notes" };
    const keys = Object.keys(d).filter(k => map[k]);
    if (!keys.length) { const r = await db.query("SELECT * FROM members WHERE id=$1",[req.params.id]); return res.json(serializeMember(r.rows[0])); }
    const sets = keys.map((k,i) => `${map[k]}=$${i+1}`).join(",");
    const vals = keys.map(k => d[k] === "" ? null : d[k]);
    const r = await db.query(`UPDATE members SET ${sets},updated_at=NOW() WHERE id=$${keys.length+1} RETURNING *`, [...vals, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: "Não encontrado" });
    res.json(serializeMember(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/members/:id", async (req, res) => {
  try { await db.query("DELETE FROM members WHERE id=$1",[req.params.id]); res.sendStatus(204); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
function serializeMember(m) {
  return { id:m.id, name:m.name, voicePart:m.voice_part??null, role:m.role??"corista", phone:m.phone??null, email:m.email??null, cpf:m.cpf??null, rg:m.rg??null, birthday:m.birthday??null, startDate:m.start_date, endDate:m.end_date??null, status:m.status, profilePhoto:m.profile_photo??null, notes:m.notes??null, createdAt:m.created_at, updatedAt:m.updated_at };
}

// SONGS
app.get("/api/songs/categories", async (_req, res) => {
  try {
    const r = await db.query("SELECT * FROM songs ORDER BY title");
    const grouped = {};
    for (const s of r.rows) { if (!grouped[s.category]) grouped[s.category]=[]; grouped[s.category].push(serializeSong(s)); }
    res.json(Object.entries(grouped).map(([category,songs])=>({category,count:songs.length,songs})));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/songs", async (req, res) => {
  try {
    const r = req.query.category ? await db.query("SELECT * FROM songs WHERE category=$1 ORDER BY title",[req.query.category]) : await db.query("SELECT * FROM songs ORDER BY title");
    res.json(r.rows.map(serializeSong));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/songs", async (req, res) => {
  try {
    const d = req.body;
    if (!d.title||!d.category) return res.status(400).json({error:"title e category obrigatórios"});
    const r = await db.query("INSERT INTO songs (title,category,composer,lyrics,notes,video_url,sheet_music_url,audio_original_url,audio_arranjo_url,playback_url,soprano_url,mezzo_url,contralto_url,tenor_url,baritono_url,baixo_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *",
      [d.title,d.category,d.composer??null,d.lyrics??null,d.notes??null,d.videoUrl??null,d.sheetMusicUrl??null,d.audioOriginalUrl??null,d.audioArranjoUrl??null,d.playbackUrl??null,d.sopranoUrl??null,d.mezzoUrl??null,d.contraltoUrl??null,d.tenorUrl??null,d.baritonoUrl??null,d.baixoUrl??null]);
    res.status(201).json(serializeSong(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/songs/:id", async (req, res) => {
  try {
    const r = await db.query("SELECT * FROM songs WHERE id=$1",[req.params.id]);
    if (!r.rows[0]) return res.status(404).json({error:"Não encontrado"});
    res.json(serializeSong(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/songs/:id", async (req, res) => {
  try {
    const d = req.body;
    const map = {title:"title",category:"category",composer:"composer",lyrics:"lyrics",notes:"notes",videoUrl:"video_url",sheetMusicUrl:"sheet_music_url",audioOriginalUrl:"audio_original_url",audioArranjoUrl:"audio_arranjo_url",playbackUrl:"playback_url",sopranoUrl:"soprano_url",mezzoUrl:"mezzo_url",contraltoUrl:"contralto_url",tenorUrl:"tenor_url",baritonoUrl:"baritono_url",baixoUrl:"baixo_url"};
    const keys = Object.keys(d).filter(k=>map[k]);
    if (!keys.length) { const r = await db.query("SELECT * FROM songs WHERE id=$1",[req.params.id]); return res.json(serializeSong(r.rows[0])); }
    const sets = keys.map((k,i)=>`${map[k]}=$${i+1}`).join(",");
    const r = await db.query(`UPDATE songs SET ${sets},updated_at=NOW() WHERE id=$${keys.length+1} RETURNING *`,[...keys.map(k=>d[k]),req.params.id]);
    if (!r.rows[0]) return res.status(404).json({error:"Não encontrado"});
    res.json(serializeSong(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/songs/:id", async (req, res) => {
  try { await db.query("DELETE FROM songs WHERE id=$1",[req.params.id]); res.sendStatus(204); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
function serializeSong(s) {
  return {id:s.id,title:s.title,category:s.category,composer:s.composer??null,lyrics:s.lyrics??null,notes:s.notes??null,videoUrl:s.video_url??null,sheetMusicUrl:s.sheet_music_url??null,audioOriginalUrl:s.audio_original_url??null,audioArranjoUrl:s.audio_arranjo_url??null,playbackUrl:s.playback_url??null,sopranoUrl:s.soprano_url??null,mezzoUrl:s.mezzo_url??null,contraltoUrl:s.contralto_url??null,tenorUrl:s.tenor_url??null,baritonoUrl:s.baritono_url??null,baixoUrl:s.baixo_url??null,createdAt:s.created_at,updatedAt:s.updated_at};
}

// EVENTS
app.get("/api/events/upcoming", async (_req, res) => {
  try {
    const r = await db.query("SELECT * FROM events WHERE date >= CURRENT_DATE AND date <= CURRENT_DATE + 30 ORDER BY date");
    res.json(r.rows.map(serializeEvent));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/events", async (req, res) => {
  try {
    let r;
    if (req.query.month && req.query.year) {
      r = await db.query("SELECT * FROM events WHERE EXTRACT(MONTH FROM date)=$1 AND EXTRACT(YEAR FROM date)=$2 ORDER BY date",[req.query.month,req.query.year]);
    } else { r = await db.query("SELECT * FROM events ORDER BY date"); }
    res.json(r.rows.map(serializeEvent));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/events/batch", async (req, res) => {
  try {
    const events = req.body?.events;
    if (!Array.isArray(events)||!events.length) return res.status(400).json({error:"events array obrigatório"});
    const inserted = [];
    for (const ev of events) {
      const r = await db.query("INSERT INTO events (title,date,type,status,planning_status,arrival_time,presentation_time,outfit,location,maps_url,notes,recurrence_group_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *",
        [ev.title,ev.date,ev.type??"ensaio",ev.status??"confirmado",ev.planningStatus??"planejada",ev.arrivalTime??null,ev.presentationTime??null,ev.outfit??null,ev.location??null,ev.mapsUrl??null,ev.notes??null,ev.recurrenceGroupId??null]);
      inserted.push(serializeEvent(r.rows[0]));
    }
    res.status(201).json({created:inserted.length,events:inserted});
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/events", async (req, res) => {
  try {
    const d = req.body;
    if (!d.title||!d.date) return res.status(400).json({error:"title e date obrigatórios"});
    const r = await db.query("INSERT INTO events (title,date,type,status,planning_status,arrival_time,presentation_time,outfit,location,maps_url,notes,recurrence_group_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *",
      [d.title,d.date,d.type??"ensaio",d.status??"confirmado",d.planningStatus??"planejada",d.arrivalTime??null,d.presentationTime??null,d.outfit??null,d.location??null,d.mapsUrl??null,d.notes??null,d.recurrenceGroupId??null]);
    res.status(201).json(serializeEvent(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/events/:id/setlist", async (req, res) => {
  try {
    const r = await db.query("SELECT s.* FROM event_setlist es JOIN songs s ON es.song_id=s.id WHERE es.event_id=$1 ORDER BY es.position",[req.params.id]);
    res.json(r.rows.map(serializeSong));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put("/api/events/:id/setlist", async (req, res) => {
  try {
    await db.query("DELETE FROM event_setlist WHERE event_id=$1",[req.params.id]);
    const songIds = req.body.songIds??[];
    for (let i=0;i<songIds.length;i++) await db.query("INSERT INTO event_setlist (event_id,song_id,position) VALUES ($1,$2,$3)",[req.params.id,songIds[i],i]);
    const r = await db.query("SELECT s.* FROM event_setlist es JOIN songs s ON es.song_id=s.id WHERE es.event_id=$1 ORDER BY es.position",[req.params.id]);
    res.json(r.rows.map(serializeSong));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/events/:id/attendances", async (req, res) => {
  try {
    const r = await db.query("SELECT ea.*,m.name as member_name,m.voice_part FROM event_attendances ea JOIN members m ON ea.member_id=m.id WHERE ea.event_id=$1",[req.params.id]);
    res.json(r.rows.map(a=>({id:a.id,eventId:a.event_id,memberId:a.member_id,memberName:a.member_name,voicePart:a.voice_part??null,status:a.status,updatedAt:a.updated_at})));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/events/:id/attendances", async (req, res) => {
  try {
    const {memberId,status} = req.body;
    if (!memberId||!status) return res.status(400).json({error:"memberId e status obrigatórios"});
    const ex = await db.query("SELECT id FROM event_attendances WHERE event_id=$1 AND member_id=$2",[req.params.id,memberId]);
    let r;
    if (ex.rows.length) r = await db.query("UPDATE event_attendances SET status=$1,updated_at=NOW() WHERE id=$2 RETURNING *",[status,ex.rows[0].id]);
    else r = await db.query("INSERT INTO event_attendances (event_id,member_id,status) VALUES ($1,$2,$3) RETURNING *",[req.params.id,memberId,status]);
    const m = await db.query("SELECT name,voice_part FROM members WHERE id=$1",[memberId]);
    const a = r.rows[0];
    res.json({id:a.id,eventId:a.event_id,memberId:a.member_id,memberName:m.rows[0]?.name??memberId,voicePart:m.rows[0]?.voice_part??null,status:a.status,updatedAt:a.updated_at});
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/events/:id", async (req, res) => {
  try {
    const r = await db.query("SELECT * FROM events WHERE id=$1",[req.params.id]);
    if (!r.rows[0]) return res.status(404).json({error:"Não encontrado"});
    res.json(serializeEvent(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/events/:id", async (req, res) => {
  try {
    const d = req.body;
    const map = {title:"title",date:"date",type:"type",status:"status",planningStatus:"planning_status",arrivalTime:"arrival_time",presentationTime:"presentation_time",outfit:"outfit",location:"location",mapsUrl:"maps_url",notes:"notes"};
    const keys = Object.keys(d).filter(k=>map[k]);
    if (!keys.length) { const r = await db.query("SELECT * FROM events WHERE id=$1",[req.params.id]); return res.json(serializeEvent(r.rows[0])); }
    const sets = keys.map((k,i)=>`${map[k]}=$${i+1}`).join(",");
    const r = await db.query(`UPDATE events SET ${sets},updated_at=NOW() WHERE id=$${keys.length+1} RETURNING *`,[...keys.map(k=>d[k]),req.params.id]);
    if (!r.rows[0]) return res.status(404).json({error:"Não encontrado"});
    res.json(serializeEvent(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/events/:id", async (req, res) => {
  try { await db.query("DELETE FROM events WHERE id=$1",[req.params.id]); res.sendStatus(204); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
function serializeEvent(e) {
  return {id:e.id,title:e.title,date:e.date,type:e.type,status:e.status,planningStatus:e.planning_status??"planejada",arrivalTime:e.arrival_time??null,presentationTime:e.presentation_time??null,outfit:e.outfit??null,location:e.location??null,mapsUrl:e.maps_url??null,notes:e.notes??null,recurrenceGroupId:e.recurrence_group_id??null,createdAt:e.created_at,updatedAt:e.updated_at};
}

// ANNOUNCEMENTS
app.get("/api/announcements", async (_req, res) => {
  try { const r = await db.query("SELECT * FROM announcements ORDER BY created_at"); res.json(r.rows.map(a=>({id:a.id,title:a.title,content:a.content,priority:a.priority,createdAt:a.created_at,updatedAt:a.updated_at}))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/announcements", async (req, res) => {
  try {
    const {title,content,priority} = req.body;
    if (!title||!content) return res.status(400).json({error:"title e content obrigatórios"});
    const r = await db.query("INSERT INTO announcements (title,content,priority) VALUES ($1,$2,$3) RETURNING *",[title,content,priority??"normal"]);
    const a = r.rows[0]; res.status(201).json({id:a.id,title:a.title,content:a.content,priority:a.priority,createdAt:a.created_at,updatedAt:a.updated_at});
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/announcements/:id", async (req, res) => {
  try {
    const {title,content,priority} = req.body;
    const sets=[]; const vals=[];
    if (title!==undefined){sets.push(`title=$${sets.length+1}`);vals.push(title);}
    if (content!==undefined){sets.push(`content=$${sets.length+1}`);vals.push(content);}
    if (priority!==undefined){sets.push(`priority=$${sets.length+1}`);vals.push(priority);}
    const r = await db.query(`UPDATE announcements SET ${sets.join(",")},updated_at=NOW() WHERE id=$${sets.length+1} RETURNING *`,[...vals,req.params.id]);
    if (!r.rows[0]) return res.status(404).json({error:"Não encontrado"});
    const a=r.rows[0]; res.json({id:a.id,title:a.title,content:a.content,priority:a.priority,createdAt:a.created_at,updatedAt:a.updated_at});
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/announcements/:id", async (req, res) => {
  try { await db.query("DELETE FROM announcements WHERE id=$1",[req.params.id]); res.sendStatus(204); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// DASHBOARD
app.get("/api/dashboard", async (_req, res) => {
  try {
    const [members,songs,events,announcements] = await Promise.all([
      db.query("SELECT * FROM members"),db.query("SELECT * FROM songs ORDER BY title"),
      db.query("SELECT * FROM events ORDER BY date"),db.query("SELECT * FROM announcements ORDER BY created_at")
    ]);
    const today = new Date().toISOString().split("T")[0];
    const future = new Date(Date.now()+30*24*60*60*1000).toISOString().split("T")[0];
    const upcomingEvents = events.rows.filter(e=>e.date>=today&&e.date<=future).slice(0,5).map(serializeEvent);
    const recentAnnouncements = announcements.rows.slice(-3).reverse().map(a=>({id:a.id,title:a.title,content:a.content,priority:a.priority,createdAt:a.created_at,updatedAt:a.updated_at}));
    const grouped={};
    for (const s of songs.rows) { if (!grouped[s.category]) grouped[s.category]=[]; grouped[s.category].push(serializeSong(s)); }
    const songsByCategory = Object.entries(grouped).map(([category,songs])=>({category,count:songs.length,songs}));
    const currentMonth = new Date().getMonth()+1;
    const birthdaysThisMonth = members.rows.filter(m=>m.birthday&&new Date(m.birthday).getMonth()+1===currentMonth).map(m=>({id:m.id,name:m.name,birthday:m.birthday}));
    res.json({totalMembers:members.rows.length,activeMembers:members.rows.filter(m=>m.status==="active").length,totalSongs:songs.rows.length,totalEvents:events.rows.length,upcomingEvents,recentAnnouncements,songsByCategory,birthdaysThisMonth});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// STUDY MATERIALS
app.get("/api/study-materials", async (_req, res) => {
  try { const r = await db.query("SELECT * FROM study_materials ORDER BY created_at"); res.json(r.rows.map(s=>({id:s.id,title:s.title,category:s.category,mediaType:s.media_type,url:s.url??null,content:s.content??null,description:s.description??null,createdAt:s.created_at,updatedAt:s.updated_at}))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/study-materials", async (req, res) => {
  try {
    const {title,category,mediaType,url,content,description} = req.body;
    if (!title||!category||!mediaType) return res.status(400).json({error:"title, category e mediaType obrigatórios"});
    const r = await db.query("INSERT INTO study_materials (title,category,media_type,url,content,description) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",[title,category,mediaType,url??null,content??null,description??null]);
    const s=r.rows[0]; res.status(201).json({id:s.id,title:s.title,category:s.category,mediaType:s.media_type,url:s.url??null,content:s.content??null,description:s.description??null,createdAt:s.created_at,updatedAt:s.updated_at});
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/study-materials/:id", async (req, res) => {
  try {
    const d = req.body; const map={title:"title",category:"category",mediaType:"media_type",url:"url",content:"content",description:"description"};
    const keys=Object.keys(d).filter(k=>map[k]);
    const sets=keys.map((k,i)=>`${map[k]}=$${i+1}`).join(",");
    const r = await db.query(`UPDATE study_materials SET ${sets},updated_at=NOW() WHERE id=$${keys.length+1} RETURNING *`,[...keys.map(k=>d[k]),req.params.id]);
    if (!r.rows[0]) return res.status(404).json({error:"Não encontrado"});
    const s=r.rows[0]; res.json({id:s.id,title:s.title,category:s.category,mediaType:s.media_type,url:s.url??null,content:s.content??null,description:s.description??null,createdAt:s.created_at,updatedAt:s.updated_at});
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/study-materials/:id", async (req, res) => {
  try { await db.query("DELETE FROM study_materials WHERE id=$1",[req.params.id]); res.sendStatus(204); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ACCESS LOGS
app.post("/api/access-logs", async (req, res) => {
  try {
    const {memberId,memberName} = req.body;
    if (!memberId||!memberName) return res.status(400).json({error:"memberId e memberName obrigatórios"});
    const r = await db.query("INSERT INTO access_logs (member_id,member_name) VALUES ($1,$2) RETURNING *",[memberId,memberName]);
    const l=r.rows[0]; res.status(201).json({id:l.id,memberId:l.member_id,memberName:l.member_name,accessedAt:l.accessed_at});
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/access-logs/summary", async (_req, res) => {
  try {
    const r = await db.query("SELECT member_id,member_name,COUNT(*)::int as total,MAX(accessed_at) as last_access FROM access_logs GROUP BY member_id,member_name ORDER BY total DESC");
    res.json(r.rows.map(r=>({memberId:r.member_id,memberName:r.member_name,total:r.total,lastAccess:r.last_access})));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/access-logs", async (_req, res) => {
  try { const r = await db.query("SELECT * FROM access_logs ORDER BY accessed_at DESC LIMIT 200"); res.json(r.rows.map(l=>({id:l.id,memberId:l.member_id,memberName:l.member_name,accessedAt:l.accessed_at}))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ATTENDANCE
app.post("/api/attendance/sessions", async (req, res) => {
  try {
    const {eventId,durationMinutes=60} = req.body;
    if (!eventId) return res.status(400).json({error:"eventId obrigatório"});
    const token = randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now()+durationMinutes*60*1000);
    const r = await db.query("INSERT INTO attendance_sessions (event_id,token,duration_minutes,expires_at) VALUES ($1,$2,$3,$4) RETURNING *",[eventId,token,durationMinutes,expiresAt]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/attendance/sessions/event/:eventId", async (req, res) => {
  try { const r = await db.query("SELECT * FROM attendance_sessions WHERE event_id=$1 ORDER BY created_at",[req.params.eventId]); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/attendance/sessions/token/:token", async (req, res) => {
  try {
    const r = await db.query("SELECT * FROM attendance_sessions WHERE token=$1",[req.params.token]);
    if (!r.rows[0]) return res.status(404).json({error:"Sessão não encontrada"});
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/attendance/sessions/:id", async (req, res) => {
  try { await db.query("DELETE FROM attendance_sessions WHERE id=$1",[req.params.id]); res.sendStatus(204); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/attendance/checkin", async (req, res) => {
  try {
    const {token,memberId,memberName,voicePart} = req.body;
    if (!token||!memberId||!memberName) return res.status(400).json({error:"token, memberId e memberName obrigatórios"});
    const s = await db.query("SELECT * FROM attendance_sessions WHERE token=$1",[token]);
    if (!s.rows[0]) return res.status(404).json({error:"Sessão não encontrada"});
    if (new Date()>new Date(s.rows[0].expires_at)) return res.status(410).json({error:"Sessão expirada"});
    const ex = await db.query("SELECT id FROM attendance_records WHERE session_id=$1 AND member_id=$2",[s.rows[0].id,memberId]);
    if (ex.rows.length) return res.status(409).json({error:"Presença já registrada",record:ex.rows[0]});
    const r = await db.query("INSERT INTO attendance_records (session_id,event_id,member_id,member_name,voice_part) VALUES ($1,$2,$3,$4,$5) RETURNING *",[s.rows[0].id,s.rows[0].event_id,memberId,memberName,voicePart??null]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/attendance/records/session/:sessionId", async (req, res) => {
  try { const r = await db.query("SELECT * FROM attendance_records WHERE session_id=$1 ORDER BY checked_in_at",[req.params.sessionId]); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/attendance/records/event/:eventId", async (req, res) => {
  try { const r = await db.query("SELECT * FROM attendance_records WHERE event_id=$1 ORDER BY checked_in_at",[req.params.eventId]); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// BLOG
app.get("/api/blog", async (_req, res) => {
  try { const r = await db.query("SELECT * FROM blog_posts ORDER BY created_at DESC"); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/blog/:id", async (req, res) => {
  try {
    const r = await db.query("SELECT * FROM blog_posts WHERE id=$1",[req.params.id]);
    if (!r.rows[0]) return res.status(404).json({error:"Não encontrado"});
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/blog", async (req, res) => {
  try {
    const {title,content,imageData,eventId,authorRole,youtubeUrl,instagramUrl,externalUrl} = req.body;
    if (!title||!content) return res.status(400).json({error:"title e content obrigatórios"});
    const r = await db.query("INSERT INTO blog_posts (title,content,image_data,event_id,author_role,youtube_url,instagram_url,external_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",[title,content,imageData??null,eventId??null,authorRole??"admin",youtubeUrl??null,instagramUrl??null,externalUrl??null]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/blog/:id", async (req, res) => {
  try {
    const d = req.body; const map={title:"title",content:"content",imageData:"image_data",eventId:"event_id",youtubeUrl:"youtube_url",instagramUrl:"instagram_url",externalUrl:"external_url"};
    const keys=Object.keys(d).filter(k=>map[k]);
    const sets=keys.map((k,i)=>`${map[k]}=$${i+1}`).join(",");
    const r = await db.query(`UPDATE blog_posts SET ${sets},updated_at=NOW() WHERE id=$${keys.length+1} RETURNING *`,[...keys.map(k=>d[k]),req.params.id]);
    if (!r.rows[0]) return res.status(404).json({error:"Não encontrado"});
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/blog/:id", async (req, res) => {
  try { await db.query("DELETE FROM blog_posts WHERE id=$1",[req.params.id]); res.sendStatus(204); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// START
const PORT = process.env.PORT || 8080;
migrate().then(() => {
  app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
}).catch(e => { console.error("Erro ao iniciar:", e); process.exit(1); });
