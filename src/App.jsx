import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  ZoomIn, 
  ZoomOut, 
  Link as LinkIcon, 
  AlertCircle, 
  Info, 
  Share2, 
  Layers, 
  Calendar, 
  HelpCircle, 
  X, 
  Sparkles,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
  Image as ImageIcon,
  Save,
  FolderOpen,
  User,
  Trash2,
  CheckCircle2,
  Settings
} from 'lucide-react';

// Firebase Imports
import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInAnonymously, signInWithCustomToken } from 'firebase/auth';
import { getFirestore, doc, setDoc, collection, onSnapshot, deleteDoc, serverTimestamp } from 'firebase/firestore';

/**
 * CONFIGURATION LOADER
 * Detects if we are in the Canvas sandbox or a Vercel/Vite production build.
 */
const getSafeConfig = () => {
  let config = {
    firebaseConfig: null,
    appId: "timeline-pro-production",
    geminiKey: "",
    isSandbox: false // Added to track environment
  };

  // 1. Sandbox Environment (Canvas)
  if (typeof __firebase_config !== 'undefined' && __firebase_config) {
    config.isSandbox = true;
    try {
      config.firebaseConfig = typeof __firebase_config === 'string' ? JSON.parse(__firebase_config) : __firebase_config;
      config.appId = typeof __app_id !== 'undefined' ? __app_id : "timeline-pro-sandbox";
    } catch (e) { console.error("Sandbox config parse error"); }
  }

  // 2. Production Environment (Vercel/Vite)
  try {
    // @ts-ignore
    const env = import.meta.env;
    if (env) {
      if (env.VITE_FIREBASE_CONFIG) {
        config.firebaseConfig = typeof env.VITE_FIREBASE_CONFIG === 'string' 
          ? JSON.parse(env.VITE_FIREBASE_CONFIG) 
          : env.VITE_FIREBASE_CONFIG;
      }
      if (env.VITE_APP_ID) config.appId = env.VITE_APP_ID;
      if (env.VITE_GEMINI_API_KEY) config.geminiKey = env.VITE_GEMINI_API_KEY;
    }
  } catch (e) {}

  config.appId = String(config.appId).replace(/\//g, '_');
  return config;
};

const { firebaseConfig, appId, geminiKey, isSandbox } = getSafeConfig();

// Initialize Firebase services outside the component to prevent re-initialization
let auth, db;
if (firebaseConfig && firebaseConfig.apiKey) {
  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
  } catch (e) { console.error("Firebase Init Error:", e); }
}

const DEFAULT_SHEET_URL = "https://docs.google.com/spreadsheets/d/1PUuaIAelViebAgOjtf3vXeMy-k59e82fDIn253s7EFM/edit?gid=0#gid=0";

export default function App() {
  const [user, setUser] = useState(null);
  const [events, setEvents] = useState([]);
  const [zoomLevel, setZoomLevel] = useState(5); 
  const [sheetUrl, setSheetUrl] = useState(DEFAULT_SHEET_URL);
  const [aiTopic, setAiTopic] = useState('');
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState('');
  const [shareSuccess, setShareSuccess] = useState(false);
  const [showSettings, setShowSettings] = useState(true);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [savedTimelines, setSavedTimelines] = useState([]);
  
  const scrollContainerRef = useRef(null);
  const dateDisplayRef = useRef(null);
  const eventRefs = useRef({});

  // Auth Initialization (Mandatory Rule 3)
  useEffect(() => {
    if (!auth) return;
    const initAuth = async () => {
      if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
        try {
          await signInWithCustomToken(auth, __initial_auth_token);
          return;
        } catch (e) { console.warn("Custom token login failed."); }
      } 
      try {
        if (!auth.currentUser) await signInAnonymously(auth);
      } catch (err) {
        setError("Database restricted. Ensure Firebase Auth is enabled.");
      }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

  // Library Sync (Rule 1 & 2)
  useEffect(() => {
    if (!user || !db) return;
    const libraryCol = collection(db, 'artifacts', appId, 'users', user.uid, 'timelines');
    const unsubscribe = onSnapshot(libraryCol, (snapshot) => {
      const timelines = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setSavedTimelines(timelines.sort((a, b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0)));
    }, (err) => console.error("Firestore sync error:", err));
    return () => unsubscribe();
  }, [user]);

  const optimizeImageUrl = (url) => {
    if (!url || typeof url !== 'string') return '';
    let val = url.trim();
    const wikiMatch = val.match(/(?:wiki\/|File:|title=File:)([^&?#]+)/i);
    if (wikiMatch) {
      let filename = wikiMatch[1].replace(/^File:/i, '');
      try {
        filename = decodeURIComponent(filename).replace(/\s/g, '_');
        return `https://commons.wikimedia.org/w/index.php?title=Special:FilePath&file=${filename}&width=1200`;
      } catch (e) { return val; }
    }
    const driveMatch = val.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (driveMatch) return `https://drive.google.com/uc?id=${driveMatch[1]}`;
    return val;
  };

  const parseCSV = (text) => {
    const lines = text.split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 2) throw new Error("Source is empty.");
    const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim().toLowerCase());
    const parsedEvents = [];
    for (let i = 1; i < lines.length; i++) {
      const row = [];
      let inQuotes = false, currentVal = '';
      for (let char of lines[i]) {
        if (char === '"') inQuotes = !inQuotes;
        else if (char === ',' && !inQuotes) { row.push(currentVal); currentVal = ''; }
        else currentVal += char;
      }
      row.push(currentVal);
      const event = { id: `evt-${i}-${Date.now()}` };
      headers.forEach((h, idx) => {
        let v = row[idx]?.replace(/^"|"$/g, '').trim() || '';
        if (h === 'importance') v = parseInt(v, 10) || 1;
        if (['image', 'imageurl', 'img'].includes(h)) { event.imageurl = optimizeImageUrl(v); }
        else event[h] = v;
      });
      if (event.date && event.title && !isNaN(new Date(event.date).getTime())) parsedEvents.push(event);
    }
    return parsedEvents.sort((a, b) => new Date(a.date) - new Date(b.date));
  };

  const loadFromSheet = async (url) => {
    if (!url) return;
    setLoading(true);
    setStatusMessage('Syncing with Google Sheets...');
    setError('');
    let fetchUrl = url;
    const sheetIdMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (sheetIdMatch && !url.includes('tqx=out:csv')) {
      fetchUrl = `https://docs.google.com/spreadsheets/d/${sheetIdMatch[1]}/gviz/tq?tqx=out:csv&gid=${url.match(/[#&?]gid=([0-9]+)/)?.[1] || '0'}`;
    }
    try {
      const response = await fetch(fetchUrl);
      const csvText = await response.text();
      setEvents(parseCSV(csvText));
      setStatusMessage('Data synced successfully.');
      setTimeout(() => setStatusMessage(''), 3000);
    } catch (err) { setError("Load failed. Ensure your Sheet is set to 'Anyone with link can view'."); }
    finally { setLoading(false); }
  };

  const handleAIGeneration = async () => {
    if (!aiTopic || loading) return;
    const apiKey = geminiKey || "";
    if (!apiKey) {
      setError("Gemini API Key missing. Please set VITE_GEMINI_API_KEY.");
      return;
    }
    setLoading(true);
    setError('');
    setStatusMessage(`Researching "${aiTopic}"...`);
    
    // Dynamic Model Selection: Solves the Vercel vs Canvas mismatch
    const modelName = isSandbox ? 'gemini-2.5-flash-preview-09-2025' : 'gemini-1.5-flash';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    
    const prompt = `Generate a historical timeline for: "${aiTopic}". Include exactly 35 key events. Return JSON only: { "events": [{ "date": "YYYY-MM-DD", "title": "string", "description": "string", "imageurl": "Wikimedia file URL", "importance": 1-10 }] }`;

    const fetchWithRetry = async (attempt = 0) => {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
          })
        });
        if (!response.ok) throw new Error(`API Error: ${response.status}`);
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        return JSON.parse(text).events;
      } catch (err) {
        if (attempt < 5) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise(r => setTimeout(r, delay));
          return fetchWithRetry(attempt + 1);
        }
        throw err;
      }
    };

    try {
      const gen = await fetchWithRetry();
      setEvents(gen.map((e, idx) => ({ ...e, id: `ai-${idx}-${Date.now()}`, imageurl: optimizeImageUrl(e.imageurl) })));
      setStatusMessage("Map generated.");
      setTimeout(() => setStatusMessage(''), 3000);
    } catch (err) { setError(`AI Generation failed: ${err.message}`); }
    finally { setLoading(false); }
  };

  const saveTimeline = async () => {
    if (!user || !db || !saveName.trim() || events.length === 0) return;
    setLoading(true);
    try {
      const id = saveName.toLowerCase().replace(/\s+/g, '-').slice(0, 40) + '-' + Date.now();
      await setDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'timelines', id), {
        name: String(saveName),
        events,
        zoomLevel,
        topic: String(aiTopic || "Custom"),
        updatedAt: serverTimestamp()
      });
      setShowSaveDialog(false);
      setSaveName('');
      setStatusMessage("Project archived in cloud.");
      setTimeout(() => setStatusMessage(''), 3000);
    } catch (err) { setError("Save failed. Check Firebase Security Rules."); }
    finally { setLoading(false); }
  };

  const deleteTimeline = async (id, e) => {
    e.stopPropagation();
    if (!db || !user) return;
    try { await deleteDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'timelines', id)); }
    catch (err) { setError("Delete failed."); }
  };

  const loadTimelineFromLibrary = (tl) => {
    setEvents(tl.events);
    setZoomLevel(tl.zoomLevel || 5);
    setAiTopic(tl.topic || '');
    setShowLibrary(false);
  };

  const visibleEvents = useMemo(() => 
    events.filter(e => (e.importance || 1) >= (11 - zoomLevel)), 
  [events, zoomLevel]);

  const layoutItems = useMemo(() => {
    const items = [];
    let lastYear = null;
    visibleEvents.forEach((event, idx) => {
      const year = new Date(event.date).getFullYear();
      if (lastYear !== null && year > lastYear) {
        const gap = year - lastYear;
        const step = gap > 100 ? 50 : (gap > 20 ? 10 : 1);
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
      <div className="h-full w-full bg-slate-50 flex flex-col items-center justify-center border-b">
        <ImageIcon size={32} className="text-slate-200 mb-2" />
        <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">No Image</span>
      </div>
    );
    return (
      <img src={src} alt={alt} referrerPolicy="no-referrer" 
        className="w-full h-full object-cover transition-all duration-700 group-hover:scale-110" 
        onError={() => setFailed(true)} />
    );
  };

  if (!firebaseConfig || !firebaseConfig.apiKey) {
    return (
      <div className="h-screen bg-slate-50 flex flex-col items-center justify-center p-8 text-center">
        <div className="bg-white p-12 rounded-[3rem] shadow-2xl max-w-md border border-slate-100">
          <Settings size={64} className="mx-auto mb-6 text-amber-500 animate-spin-slow" />
          <h2 className="text-3xl font-serif font-bold text-slate-900 mb-4 text-center">Setup Required</h2>
          <p className="text-slate-500 mb-8 leading-relaxed text-center">Please add your Firebase Configuration to Vercel's environment variables.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen bg-[#fafaf9] text-slate-900 font-sans flex flex-col overflow-hidden selection:bg-blue-100">
      
      <header className="bg-white/90 backdrop-blur-md border-b border-slate-200 px-6 py-4 z-50 shrink-0 shadow-sm">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row gap-4 items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="bg-slate-900 text-white p-2.5 rounded-2xl shadow-lg"><Layers size={22} /></div>
            <div>
              <h1 className="text-xl font-bold font-serif text-slate-900 tracking-tight">Timeline Pro</h1>
              <div className="flex items-center gap-2 text-[10px] text-slate-400 uppercase tracking-widest font-bold">
                <span className={`w-1.5 h-1.5 rounded-full ${user ? 'bg-green-500 animate-pulse' : 'bg-slate-300'}`} />
                {user ? `Connected: ${user.uid.slice(0, 8)}` : 'Connecting...'}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-full mr-2 shadow-inner">
              <button onClick={() => setZoomLevel(Math.max(1, zoomLevel - 1))} className="p-1.5 hover:bg-white rounded-full transition-all text-slate-500"><ZoomOut size={16}/></button>
              <input type="range" min="1" max="10" value={zoomLevel} onChange={(e)=>setZoomLevel(parseInt(e.target.value))} className="w-16 md:w-24 accent-slate-800 cursor-pointer"/>
              <button onClick={() => setZoomLevel(Math.min(10, zoomLevel + 1))} className="p-1.5 hover:bg-white rounded-full transition-all text-slate-500"><ZoomIn size={16}/></button>
            </div>
            <button onClick={() => setShowLibrary(!showLibrary)} className={`p-2.5 rounded-full border transition-all ${showLibrary ? 'bg-slate-900 text-white shadow-lg' : 'bg-white text-slate-600 hover:bg-slate-50'}`}><FolderOpen size={18} /></button>
            <button onClick={() => setShowSaveDialog(true)} disabled={events.length === 0} className="p-2.5 rounded-full border bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-30 transition-all shadow-sm"><Save size={18} /></button>
            <button onClick={() => setShowSettings(!showSettings)} className={`p-2.5 rounded-full border transition-all ${showSettings ? 'bg-slate-900 text-white shadow-lg' : 'bg-white text-slate-600'}`}><Search size={18} /></button>
          </div>
        </div>

        {showSettings && (
          <div className="max-w-7xl mx-auto mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4 animate-in slide-in-from-top-4">
            <input type="text" placeholder="Sheet URL (CSV Mode)..." value={sheetUrl} onChange={(e)=>setSheetUrl(e.target.value)} onKeyDown={(e)=>e.key==='Enter'&&loadFromSheet(sheetUrl)} className="flex-1 px-4 py-3 bg-slate-50 border rounded-2xl text-sm font-mono outline-none shadow-inner"/>
            <div className="flex gap-2">
              <input type="text" placeholder="AI Research Topic..." value={aiTopic} onChange={(e)=>setAiTopic(e.target.value)} onKeyDown={(e)=>e.key==='Enter'&&handleAIGeneration()} className="flex-1 px-4 py-3 bg-blue-50/30 border border-blue-100 rounded-2xl text-sm outline-none shadow-inner"/>
              <button onClick={handleAIGeneration} disabled={loading} className="px-6 py-3 bg-blue-600 text-white rounded-2xl font-bold shadow-md active:scale-95 transition-all flex items-center gap-2">
                {loading ? <RefreshCw size={16} className="animate-spin" /> : <Sparkles size={16} />} Generate
              </button>
            </div>
          </div>
        )}

        {showLibrary && (
          <div className="max-w-7xl mx-auto mt-6 p-6 bg-slate-900 rounded-[2.5rem] shadow-2xl animate-in slide-in-from-top-4">
            <div className="flex justify-between items-center mb-6 px-2 text-white font-serif text-lg font-bold">
              <span className="flex items-center gap-2"><FolderOpen size={18} className="text-blue-400"/> My Archives</span>
              <button onClick={()=>setShowLibrary(false)} className="p-2 hover:bg-slate-800 rounded-full"><X size={20}/></button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 max-h-[40vh] overflow-y-auto custom-scrollbar p-1">
              {savedTimelines.length === 0 ? (
                <div className="col-span-full py-12 text-center text-slate-500 text-sm italic">Library is empty. Save a project to archive it here.</div>
              ) : savedTimelines.map(tl => (
                <div key={tl.id} onClick={()=>loadTimelineFromLibrary(tl)} className="bg-slate-800 hover:bg-slate-700 p-5 rounded-2xl cursor-pointer transition-all border border-slate-700 group relative">
                  <div className="flex justify-between items-start mb-3">
                    <span className="text-white font-bold text-sm leading-tight line-clamp-1">{tl.name}</span>
                    <button onClick={(e)=>deleteTimeline(tl.id, e)} className="text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 p-1"><Trash2 size={14}/></button>
                  </div>
                  <div className="text-[10px] text-slate-500 flex justify-between uppercase font-bold tracking-widest">
                    <span>{tl.events?.length || 0} pts</span>
                    <span>{tl.updatedAt?.seconds ? new Date(tl.updatedAt.seconds * 1000).toLocaleDateString() : '---'}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {(error || statusMessage || loading) && (
          <div className="max-w-7xl mx-auto mt-4">
            {error && <div className="text-sm text-red-600 flex items-center gap-2 bg-red-50 p-4 rounded-2xl border border-red-100 animate-in fade-in">{String(error)}</div>}
            {statusMessage && <div className="text-sm text-blue-700 flex items-center gap-2 bg-blue-50 p-4 rounded-2xl border border-blue-100 shadow-sm animate-in fade-in">{String(statusMessage)}</div>}
          </div>
        )}
      </header>

      <main className="flex-1 relative overflow-hidden flex flex-col">
        <div className="absolute top-10 left-1/2 -translate-x-1/2 z-40 pointer-events-none">
          <div className="bg-slate-900/95 backdrop-blur-xl text-white px-10 py-3 rounded-full shadow-2xl flex items-center gap-4 border border-white/10">
            <Calendar size={18} className="text-slate-400" />
            <span className="font-serif font-black tracking-[0.2em] text-xl uppercase min-w-[160px] text-center">Narrative</span>
          </div>
        </div>

        {/* Crucial Horizontal Layout Logic:
           - flex-1 and overflow-x-auto on the parent.
           - inline-flex and items-end on the content wrapper.
           - whitespace-nowrap or flex-row inside items.
        */}
        <div ref={scrollContainerRef} className="flex-1 overflow-x-auto overflow-y-hidden custom-scrollbar snap-x snap-mandatory">
          <div className="h-full inline-flex items-end pb-32 px-[15vw] md:px-[35vw] min-w-full">
            <div className="flex items-end gap-16 relative">
              <div className="absolute bottom-0 left-[-3000px] right-[-3000px] h-1.5 bg-slate-200 z-0 opacity-50" />
              {layoutItems.map((item) => (
                item.type === 'marker' ? (
                  <div key={item.id} className="relative flex flex-col items-center justify-end w-24 shrink-0">
                    <div className="w-[2px] h-16 bg-slate-300 absolute -bottom-2" />
                    <div className="absolute -bottom-12 text-[10px] font-black text-slate-400 tracking-[0.3em]">{item.year}</div>
                  </div>
                ) : (
                  <div key={item.id} className="relative flex flex-col items-center justify-end w-[320px] md:w-[420px] shrink-0 snap-center group">
                    <div className="w-full bg-white rounded-[3rem] border border-slate-100 shadow-2xl transition-all duration-700 overflow-hidden flex flex-col mb-16 relative z-20 hover:-translate-y-8 hover:shadow-[0_40px_80px_rgba(0,0,0,0.1)] transition-all">
                      <div className="h-48 md:h-64 overflow-hidden relative bg-slate-100 flex items-center justify-center">
                        <ImageWithFallback src={item.data.imageurl} alt={item.data.title} />
                      </div>
                      <div className="p-10">
                        <div className="flex justify-between items-center mb-6">
                          <span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 bg-slate-50 px-4 py-2 rounded-full border border-slate-100">{new Date(item.data.date).toLocaleDateString()}</span>
                          <span className="text-[10px] font-bold text-blue-500">Imp. {item.data.importance}</span>
                        </div>
                        <h3 className="font-serif font-bold text-2xl md:text-3xl text-slate-900 leading-[1.15] mb-6 group-hover:text-blue-600 transition-colors line-clamp-2">{item.data.title}</h3>
                        <p className="text-base text-slate-500 leading-relaxed line-clamp-4 font-medium italic">"{item.data.description}"</p>
                      </div>
                    </div>
                    <div className="w-[4px] h-16 bg-slate-900 group-hover:h-24 transition-all duration-700 z-10" />
                    <div className="absolute -bottom-3 w-6 h-6 rounded-full bg-white border-[6px] border-slate-900 shadow-2xl z-20 group-hover:scale-150 transition-transform duration-700" />
                  </div>
                )
              ))}
            </div>
          </div>
        </div>
      </main>

      {showSaveDialog && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/90 backdrop-blur-md p-6">
          <div className="bg-white rounded-[3.5rem] shadow-2xl max-w-lg w-full p-12 animate-in zoom-in-95">
            <h2 className="text-3xl font-serif font-bold text-slate-900 mb-4">Archive Project</h2>
            <p className="text-slate-500 mb-10 leading-relaxed font-medium">Your work will be securely saved to your private cloud library.</p>
            <input autoFocus type="text" placeholder="Timeline Name..." value={saveName} onChange={(e)=>setSaveName(e.target.value)} onKeyDown={(e)=>e.key==='Enter'&&saveTimeline()} className="w-full px-8 py-5 bg-slate-50 border border-slate-200 rounded-[2rem] mb-10 text-xl font-medium focus:ring-4 focus:ring-blue-500/10 focus:outline-none transition-all shadow-inner" />
            <div className="flex gap-4">
              <button onClick={()=>setShowSaveDialog(false)} className="flex-1 py-5 text-slate-400 font-bold hover:bg-slate-50 rounded-[2rem] transition-all text-lg">Discard</button>
              <button onClick={saveTimeline} disabled={!saveName.trim() || loading} className="flex-[2] py-5 bg-blue-600 text-white font-bold rounded-[2rem] shadow-2xl hover:bg-blue-700 disabled:opacity-50 transition-all text-lg">{loading ? 'Archiving...' : 'Save to Cloud'}</button>
            </div>
          </div>
        </div>
      )}

      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar { height: 10px; background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background-color: #cbd5e1; border-radius: 30px; border: 3px solid #fafaf9; background-clip: content-box; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        .animate-in { animation: fadeIn 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        .animate-spin-slow { animation: spin 8s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}} />
    </div>
  );
}