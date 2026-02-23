import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  ZoomIn, 
  ZoomOut, 
  Plus,
  FolderOpen,
  Save,
  Diamond,
  FileSpreadsheet,
  Settings,
  Layers,
  Calendar,
  X,
  RefreshCw,
  Sparkles,
  Trash2,
  Image as ImageIcon,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';

// Firebase Imports
import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInAnonymously, signInWithCustomToken } from 'firebase/auth';
import { getFirestore, doc, setDoc, collection, onSnapshot, deleteDoc, serverTimestamp } from 'firebase/firestore';

const getSafeConfig = () => {
  let config = {
    firebaseConfig: null,
    appId: "timeline-pro-v2",
    geminiKey: "" 
  };

  if (typeof __firebase_config !== 'undefined' && __firebase_config) {
    try {
      config.firebaseConfig = typeof __firebase_config === 'string' ? JSON.parse(__firebase_config) : __firebase_config;
      config.appId = typeof __app_id !== 'undefined' ? __app_id : "timeline-pro-sandbox";
    } catch (e) { console.error("Config parse error"); }
  }

  try {
    const env = import.meta.env;
    if (env) {
      if (env.VITE_FIREBASE_CONFIG) config.firebaseConfig = JSON.parse(env.VITE_FIREBASE_CONFIG);
      if (env.VITE_APP_ID) config.appId = env.VITE_APP_ID;
      if (env.VITE_GEMINI_API_KEY) config.geminiKey = env.VITE_GEMINI_API_KEY;
    }
  } catch (e) {}

  config.appId = String(config.appId).replace(/\//g, '_');
  return config;
};

const { firebaseConfig, appId, geminiKey } = getSafeConfig();

let auth, db;
if (firebaseConfig?.apiKey) {
  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
  } catch (e) { console.error("Firebase Init Error:", e); }
}

/**
 * Custom Logo Component matching the uploaded reference image.
 * A black rounded icon with a thin dividing line and a subtle, small 't' tick.
 */
const TimelineLogo = () => (
  <div className="w-12 h-12 shrink-0 shadow-2xl overflow-hidden rounded-[12px] bg-black flex items-center justify-center">
    <svg viewBox="0 0 100 100" className="w-full h-full">
      {/* Horizontal Divider - positioned slightly above center */}
      <line x1="0" y1="48" x2="100" y2="48" stroke="white" strokeWidth="3.5" />
      {/* Smaller, subtle 't' tick with a soft curve at the bottom */}
      <path 
        d="M50 41 V54 Q50 59 56 59" 
        stroke="white" 
        strokeWidth="3.5" 
        fill="none" 
        strokeLinecap="round" 
      />
    </svg>
  </div>
);

export default function App() {
  const [user, setUser] = useState(null);
  const [events, setEvents] = useState([]);
  const [timelineTitle, setTimelineTitle] = useState('Timeline');
  const [timelineDesc, setTimelineDesc] = useState('Create a timeline and start generating!');
  const [zoomLevel, setZoomLevel] = useState(5);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  
  // Modal States
  const [activeModal, setActiveModal] = useState(null); // 'new', 'add-ai', 'sheet', 'library'
  const [inputVal, setInputVal] = useState('');
  const [inputVal2, setInputVal2] = useState('');
  const [savedTimelines, setSavedTimelines] = useState([]);

  const scrollContainerRef = useRef(null);

  // Auth (Rule 3)
  useEffect(() => {
    if (!auth) return;
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (err) { setError("Database restricted."); }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

  // Library Sync (Rule 1 & 2)
  useEffect(() => {
    if (!user || !db) return;
    const colRef = collection(db, 'artifacts', appId, 'users', user.uid, 'timelines');
    const unsubscribe = onSnapshot(colRef, (snap) => {
      const tls = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setSavedTimelines(tls.sort((a, b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0)));
    });
    return () => unsubscribe();
  }, [user]);

  // Recalculate Relative Importance (1-10 evenly spread)
  const normalizeEvents = (rawEvents) => {
    if (rawEvents.length === 0) return [];
    
    // Sort by absolute importance (ascending)
    const sorted = [...rawEvents].sort((a, b) => (a.absImp || 0) - (b.absImp || 0));
    const count = sorted.length;
    
    return sorted.map((evt, index) => {
      // Calculate decile: spread index over 10 buckets
      const relativeImp = Math.min(10, Math.floor((index / count) * 10) + 1);
      return { ...evt, relImp: relativeImp };
    });
  };

  const optimizeImageUrl = (url) => {
    if (!url) return '';
    const wikiMatch = url.match(/(?:wiki\/|File:|title=File:)([^&?#]+)/i);
    if (wikiMatch) {
      let filename = wikiMatch[1].replace(/^File:/i, '');
      try {
        filename = decodeURIComponent(filename).replace(/\s/g, '_');
        return `https://commons.wikimedia.org/w/index.php?title=Special:FilePath&file=${filename}&width=1000`;
      } catch (e) { return url; }
    }
    return url;
  };

  const parseCSV = (text) => {
    const lines = text.split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 2) throw new Error("Source is empty.");
    const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim().toLowerCase());
    const parsed = [];
    for (let i = 1; i < lines.length; i++) {
      const row = [];
      let inQuotes = false, current = '';
      for (let char of lines[i]) {
        if (char === '"') inQuotes = !inQuotes;
        else if (char === ',' && !inQuotes) { row.push(current); current = ''; }
        else current += char;
      }
      row.push(current);
      const event = { id: `csv-${i}-${Date.now()}` };
      headers.forEach((h, idx) => {
        let v = row[idx]?.replace(/^"|"$/g, '').trim() || '';
        if (h === 'importance' || h === 'abs_importance') event.absImp = parseInt(v) || 50;
        else if (['image', 'imageurl', 'img'].includes(h)) event.imageurl = optimizeImageUrl(v);
        else event[h] = v;
      });
      if (event.date && event.title) parsed.push(event);
    }
    setEvents(normalizeEvents(parsed));
  };

  const handleCreateNew = () => {
    setTimelineTitle(inputVal || "Timeline");
    setTimelineDesc(inputVal2 || "Create a timeline and start generating!");
    setEvents([]);
    setActiveModal(null);
    setInputVal('');
    setInputVal2('');
  };

  const handleAddAI = async () => {
    const count = parseInt(inputVal) || 5;
    if (count < 1 || count > 10) return;
    setLoading(true);
    setActiveModal(null);
    setStatus(`AI is expanding "${timelineTitle}"...`);
    
    const existingTitles = events.map(e => e.title).join(', ');
    const prompt = `
      CONTEXT:
      Timeline Title: ${timelineTitle}
      Timeline Description: ${timelineDesc}
      Current Events: ${existingTitles}

      TASK:
      Generate ${count} NEW and UNIQUE historical events for this timeline. 
      DO NOT repeat current events.
      Provide "absImp" (Absolute Importance) as an integer from 1-100.
      
      Return JSON only: { "events": [{ "date": "YYYY-MM-DD", "title": "string", "description": "string", "imageurl": "Wikimedia file URL", "absImp": 1-100 }] }
    `;

    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" }
        })
      });
      const data = await response.json();
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      const newEvts = JSON.parse(rawText).events.map((e, idx) => ({
        ...e,
        id: `ai-${idx}-${Date.now()}`,
        imageurl: optimizeImageUrl(e.imageurl)
      }));
      
      setEvents(prev => normalizeEvents([...prev, ...newEvts]));
      setStatus("Timeline updated.");
      setTimeout(() => setStatus(''), 3000);
    } catch (err) { setError("AI generation failed."); }
    finally { setLoading(false); setInputVal(''); }
  };

  const handleSheetImport = async () => {
    const url = inputVal;
    if (!url) return;
    setLoading(true);
    setActiveModal(null);
    try {
      let fetchUrl = url;
      const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (idMatch) fetchUrl = `https://docs.google.com/spreadsheets/d/${idMatch[1]}/gviz/tq?tqx=out:csv&gid=${url.match(/[#&?]gid=([0-9]+)/)?.[1] || '0'}`;
      const res = await fetch(fetchUrl);
      const csv = await res.text();
      parseCSV(csv);
      setStatus("Import complete.");
    } catch (e) { setError("Sheet import failed."); }
    finally { setLoading(false); setInputVal(''); }
  };

  const handleSave = async () => {
    if (!user || !db || events.length === 0) return;
    setLoading(true);
    try {
      const id = timelineTitle.toLowerCase().replace(/\s+/g, '-').slice(0, 30) + '-' + Date.now();
      await setDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'timelines', id), {
        title: timelineTitle,
        description: timelineDesc,
        events,
        updatedAt: serverTimestamp()
      });
      setStatus("Archived to Cloud.");
      setTimeout(() => setStatus(''), 3000);
    } catch (e) { setError("Save failed."); }
    finally { setLoading(false); }
  };

  const handleLoad = (tl) => {
    setTimelineTitle(tl.title);
    setTimelineDesc(tl.description);
    setEvents(tl.events);
    setActiveModal(null);
  };

  const handleDelete = async (id, e) => {
    e.stopPropagation();
    if (!db || !user) return;
    await deleteDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'timelines', id));
  };

  const visibleEvents = useMemo(() => 
    [...events]
      .filter(e => (e.relImp || 1) >= (11 - zoomLevel))
      .sort((a, b) => new Date(a.date) - new Date(b.date)),
  [events, zoomLevel]);

  const layoutItems = useMemo(() => {
    const items = [];
    let lastYear = null;
    visibleEvents.forEach((event, idx) => {
      const year = new Date(event.date).getFullYear();
      if (lastYear !== null && year > lastYear) {
        const gap = year - lastYear;
        const step = gap > 100 ? 50 : (gap > 20 ? 10 : 5);
        for (let y = lastYear + step; y < year; y += step) {
          items.push({ type: 'marker', year: y, id: `m-${y}-${idx}` });
        }
      }
      items.push({ type: 'event', data: event, id: event.id });
      lastYear = year;
    });
    return items;
  }, [visibleEvents]);

  const ImageWithFallback = ({ src, alt }) => {
    const [failed, setFailed] = useState(false);
    if (failed || !src) return (
      <div className="h-full w-full bg-slate-100 flex flex-col items-center justify-center">
        <ImageIcon size={32} className="text-slate-300 mb-2" />
        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">No Media</span>
      </div>
    );
    return <img src={src} alt={alt} className="w-full h-full object-cover" onError={() => setFailed(true)} />;
  };

  return (
    <div className="h-screen w-screen bg-[#fafaf9] text-slate-900 font-sans flex flex-col overflow-hidden selection:bg-blue-100">
      
      {/* HEADER COMMAND BAR */}
      <header className="bg-white/95 backdrop-blur-md border-b border-slate-200 px-6 py-4 z-50 shrink-0 shadow-sm">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row gap-4 items-center justify-between">
          
          {/* Metadata Display / Logo */}
          <div className="flex items-center gap-5">
            <TimelineLogo />
            <div className="max-w-md">
              <h1 className="text-xl font-bold font-serif text-slate-900 truncate tracking-tight">{timelineTitle}</h1>
              <p className="text-[11px] text-slate-500 font-medium line-clamp-1 italic">{timelineDesc}</p>
            </div>
          </div>

          {/* Core Controls */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 bg-slate-100 p-1.5 rounded-full mr-3 shadow-inner">
              <button onClick={() => setZoomLevel(Math.max(1, zoomLevel - 1))} className="p-1.5 hover:bg-white rounded-full transition-all text-slate-500"><ZoomOut size={16}/></button>
              <input type="range" min="1" max="10" value={zoomLevel} onChange={(e)=>setZoomLevel(parseInt(e.target.value))} className="w-20 md:w-32 accent-slate-800 cursor-pointer"/>
              <button onClick={() => setZoomLevel(Math.min(10, zoomLevel + 1))} className="p-1.5 hover:bg-white rounded-full transition-all text-slate-500"><ZoomIn size={16}/></button>
            </div>

            <div className="flex items-center gap-1.5">
              <button title="New Timeline" onClick={() => setActiveModal('new')} className="p-3 rounded-full border bg-white hover:bg-slate-50 transition-all text-slate-700 shadow-sm"><Plus size={18} /></button>
              <button title="Library" onClick={() => setActiveModal('library')} className="p-3 rounded-full border bg-white hover:bg-slate-50 transition-all text-slate-700 shadow-sm"><FolderOpen size={18} /></button>
              <button title="Save" onClick={handleSave} disabled={events.length === 0} className="p-3 rounded-full border bg-white hover:bg-slate-50 disabled:opacity-30 transition-all text-slate-700 shadow-sm"><Save size={18} /></button>
              <button title="AI Add Events" onClick={() => setActiveModal('add-ai')} disabled={events.length === 0 && timelineTitle === 'Timeline'} className="p-3 rounded-full bg-blue-600 text-white hover:bg-blue-700 shadow-lg disabled:opacity-30 transition-all"><Diamond size={18} /></button>
              <button title="Import Sheet" onClick={() => setActiveModal('sheet')} className="p-3 rounded-full border bg-white hover:bg-slate-50 transition-all text-slate-700 shadow-sm"><FileSpreadsheet size={18} /></button>
            </div>
          </div>
        </div>

        {/* Status Bar */}
        {(status || error || loading) && (
          <div className="max-w-7xl mx-auto mt-3 animate-in fade-in slide-in-from-top-2">
            {error && <div className="text-xs text-red-600 bg-red-50 py-2 px-4 rounded-full border border-red-100 flex items-center gap-2"><AlertCircle size={14}/> {error}</div>}
            {status && <div className="text-xs text-blue-700 bg-blue-50 py-2 px-4 rounded-full border border-blue-100 flex items-center gap-2"><CheckCircle2 size={14}/> {status}</div>}
            {loading && <div className="text-xs text-slate-500 flex items-center gap-2 px-4 py-2"><RefreshCw size={14} className="animate-spin"/> processing...</div>}
          </div>
        )}
      </header>

      {/* MAIN TIMELINE CANVAS */}
      <main className="flex-1 relative overflow-hidden flex flex-col">
        <div ref={scrollContainerRef} className="flex-1 overflow-x-auto overflow-y-hidden custom-scrollbar snap-x snap-mandatory">
          <div className="h-full inline-flex items-end pb-40 px-[30vw] min-w-full">
            <div className="flex items-end gap-20 relative">
              <div className="absolute bottom-0 left-[-5000px] right-[-5000px] h-1.5 bg-slate-200 z-0" />
              
              {layoutItems.length === 0 ? (
                <div className="w-[40vw] flex flex-col items-center justify-center text-slate-300 font-serif italic text-2xl opacity-40 mb-32">
                  <Sparkles size={48} className="mb-4" />
                  Your timeline starts here.
                </div>
              ) : layoutItems.map((item) => (
                item.type === 'marker' ? (
                  <div key={item.id} className="relative flex flex-col items-center justify-end w-24 shrink-0">
                    <div className="w-[1px] h-12 bg-slate-300 absolute -bottom-1" />
                    <div className="absolute -bottom-10 text-[11px] font-black text-slate-400 tracking-[0.2em]">{item.year}</div>
                  </div>
                ) : (
                  <div key={item.id} className="relative flex flex-col items-center justify-end w-[350px] md:w-[450px] shrink-0 snap-center group">
                    <div className="w-full bg-white rounded-[3rem] border border-slate-100 shadow-2xl transition-all duration-500 overflow-hidden flex flex-col mb-20 relative z-20 hover:-translate-y-6 hover:shadow-[0_30px_60px_rgba(0,0,0,0.12)]">
                      <div className="h-48 md:h-64 overflow-hidden relative bg-slate-50">
                        <ImageWithFallback src={item.data.imageurl} alt={item.data.title} />
                        <div className="absolute top-6 left-6 flex gap-2">
                           <span className="text-[9px] font-black uppercase tracking-widest text-white bg-slate-900/80 backdrop-blur px-3 py-1.5 rounded-full">
                            {new Date(item.data.date).getFullYear()}
                           </span>
                        </div>
                      </div>
                      <div className="p-10">
                        <h3 className="font-serif font-bold text-2xl md:text-3xl text-slate-900 leading-tight mb-4 group-hover:text-blue-600 transition-colors line-clamp-2">{item.data.title}</h3>
                        <p className="text-base text-slate-500 leading-relaxed line-clamp-4 italic font-medium">"{item.data.description}"</p>
                        <div className="mt-8 pt-6 border-t border-slate-50 flex justify-between items-center text-[10px] font-bold uppercase tracking-widest text-slate-400">
                          <span>{new Date(item.data.date).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</span>
                          <span className="text-blue-500/60">Rank: {item.data.absImp}</span>
                        </div>
                      </div>
                    </div>
                    <div className="w-[4px] h-20 bg-slate-900 group-hover:h-28 transition-all duration-500 z-10" />
                    <div className="absolute -bottom-4 w-8 h-8 rounded-full bg-white border-[8px] border-slate-900 shadow-xl z-20 group-hover:scale-125 transition-transform duration-500" />
                  </div>
                )
              ))}
            </div>
          </div>
        </div>
      </main>

      {/* MODAL SYSTEM */}
      {activeModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/90 backdrop-blur-md p-6">
          <div className="bg-white rounded-[3.5rem] shadow-2xl max-w-xl w-full p-12 animate-in zoom-in-95 relative">
            <button onClick={() => setActiveModal(null)} className="absolute top-8 right-8 p-3 hover:bg-slate-50 rounded-full text-slate-400"><X size={24}/></button>
            
            {activeModal === 'new' && (
              <>
                <h2 className="text-3xl font-serif font-bold text-slate-900 mb-2">New Narrative</h2>
                <p className="text-slate-500 mb-8 font-medium">Define the focus of your historical journey.</p>
                <input placeholder="Title (e.g., The Industrial Revolution)" value={inputVal} onChange={(e)=>setInputVal(e.target.value)} className="w-full px-6 py-4 bg-slate-50 border rounded-2xl mb-4 text-lg outline-none focus:ring-2 ring-blue-500/20" />
                <textarea placeholder="Brief description..." rows={3} value={inputVal2} onChange={(e)=>setInputVal2(e.target.value)} className="w-full px-6 py-4 bg-slate-50 border rounded-2xl mb-8 text-lg outline-none focus:ring-2 ring-blue-500/20" />
                <button onClick={handleCreateNew} className="w-full py-5 bg-slate-900 text-white font-bold rounded-2xl hover:bg-slate-800 transition-all text-lg">Create Timeline</button>
              </>
            )}

            {activeModal === 'add-ai' && (
              <>
                <div className="flex items-center gap-4 mb-4">
                  <div className="bg-blue-100 text-blue-600 p-3 rounded-2xl"><Diamond size={24}/></div>
                  <h2 className="text-3xl font-serif font-bold text-slate-900">Add Events</h2>
                </div>
                <p className="text-slate-500 mb-8 font-medium italic">Gemini will analyze "{timelineTitle}" and suggest new unique moments.</p>
                <div className="mb-8">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400 block mb-3 px-2">How many events? (1-10)</label>
                  <input type="number" min="1" max="10" value={inputVal} onChange={(e)=>setInputVal(e.target.value)} placeholder="5" className="w-full px-8 py-5 bg-slate-50 border border-slate-200 rounded-2xl text-2xl font-bold focus:outline-none focus:ring-4 focus:ring-blue-100 transition-all" />
                </div>
                <button onClick={handleAddAI} className="w-full py-6 bg-blue-600 text-white font-bold rounded-2xl shadow-xl hover:bg-blue-700 transition-all text-lg flex items-center justify-center gap-3">
                  <Sparkles size={20}/> Generate Events
                </button>
              </>
            )}

            {activeModal === 'sheet' && (
              <>
                <h2 className="text-3xl font-serif font-bold text-slate-900 mb-2">Sheet Import</h2>
                <p className="text-slate-500 mb-8 font-medium">Paste your Google Sheet URL. Ensure headers include: Date, Title, Description, Importance.</p>
                <input placeholder="https://docs.google.com/spreadsheets/..." value={inputVal} onChange={(e)=>setInputVal(e.target.value)} className="w-full px-6 py-4 bg-slate-50 border rounded-2xl mb-8 outline-none" />
                <button onClick={handleSheetImport} className="w-full py-5 bg-green-600 text-white font-bold rounded-2xl hover:bg-green-700 transition-all text-lg">Sync Data</button>
              </>
            )}

            {activeModal === 'library' && (
              <>
                <h2 className="text-3xl font-serif font-bold text-slate-900 mb-6 flex items-center gap-3"><FolderOpen size={28} className="text-blue-500"/> Archives</h2>
                <div className="max-h-[50vh] overflow-y-auto space-y-3 pr-2 custom-scrollbar">
                  {savedTimelines.length === 0 ? (
                    <p className="text-center py-12 text-slate-400 italic">No saved projects found.</p>
                  ) : savedTimelines.map(tl => (
                    <div key={tl.id} onClick={() => handleLoad(tl)} className="group flex justify-between items-center p-5 bg-slate-50 border rounded-2xl cursor-pointer hover:bg-white hover:shadow-lg hover:border-blue-100 transition-all">
                      <div>
                        <h4 className="font-bold text-slate-900">{tl.title}</h4>
                        <p className="text-[10px] text-slate-500 uppercase tracking-widest mt-1 font-bold">{tl.events?.length || 0} Events • {tl.updatedAt?.seconds ? new Date(tl.updatedAt.seconds * 1000).toLocaleDateString() : 'Draft'}</p>
                      </div>
                      <button onClick={(e) => handleDelete(tl.id, e)} className="p-2 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"><Trash2 size={16}/></button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar { height: 8px; width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 20px; border: 2px solid transparent; background-clip: content-box; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        .animate-in { animation: fadeIn 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
      `}} />
    </div>
  );
}