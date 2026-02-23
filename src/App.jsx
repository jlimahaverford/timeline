import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Plus,
  FolderOpen,
  Save,
  Diamond,
  FileSpreadsheet,
  ZoomIn, 
  ZoomOut, 
  Layers, 
  Calendar, 
  X, 
  Sparkles,
  RefreshCw,
  ImageIcon,
  Trash2,
  Settings,
  ChevronRight,
  Info
} from 'lucide-react';

// Firebase Imports
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  onAuthStateChanged, 
  signInAnonymously, 
  signInWithCustomToken 
} from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  setDoc, 
  collection, 
  onSnapshot, 
  deleteDoc, 
  serverTimestamp 
} from 'firebase/firestore';

/**
 * CUSTOM LOGO COMPONENT
 * Refined to match the user-provided image exactly.
 */
const TimelineLogo = ({ size = 36 }) => (
  <svg width={size} height={size} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="100" height="100" rx="28" fill="black"/>
    <path d="M0 50.5H100" stroke="white" strokeWidth="2.5"/>
    <path 
      d="M50 38V58C50 61.5 51.5 63 54.5 63" 
      stroke="white" 
      strokeWidth="4" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * CONFIGURATION LOADER
 */
const getSafeConfig = () => {
  let config = { firebaseConfig: null, appId: "timeline-pro-production", geminiKey: "", isSandbox: false };
  if (typeof __firebase_config !== 'undefined' && __firebase_config) {
    config.isSandbox = true;
    try {
      config.firebaseConfig = typeof __firebase_config === 'string' ? JSON.parse(__firebase_config) : __firebase_config;
      config.appId = typeof __app_id !== 'undefined' ? __app_id : "timeline-pro-sandbox";
    } catch (e) { console.error("Sandbox config parse error"); }
  }
  try {
    // @ts-ignore
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

const { firebaseConfig, appId, geminiKey, isSandbox } = getSafeConfig();

let auth, db;
if (firebaseConfig && firebaseConfig.apiKey) {
  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
  } catch (e) { console.error("Firebase Init Error:", e); }
}

export default function App() {
  const [user, setUser] = useState(null);
  const [timelineTitle, setTimelineTitle] = useState(''); // Default empty to show "Timeline"
  const [timelineDesc, setTimelineDesc] = useState(''); 
  const [events, setEvents] = useState([]);
  const [zoomLevel, setZoomLevel] = useState(10); 
  
  // UI States
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState('');
  const [showLibrary, setShowLibrary] = useState(false);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showSheetDialog, setShowSheetDialog] = useState(false);
  const [savedTimelines, setSavedTimelines] = useState([]);
  
  // Input Temp States
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [numToAdd, setNumToAdd] = useState(5);
  const [sheetUrl, setSheetUrl] = useState('');

  const scrollContainerRef = useRef(null);

  // Auth Initialization
  useEffect(() => {
    if (!auth) return;
    const initAuth = async () => {
      if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
        try { await signInWithCustomToken(auth, __initial_auth_token); return; } catch (e) {}
      } 
      try { if (!auth.currentUser) await signInAnonymously(auth); } catch (err) { setError("Database restricted."); }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

  // Library Sync
  useEffect(() => {
    if (!user || !db) return;
    const libraryCol = collection(db, 'artifacts', appId, 'users', user.uid, 'timelines');
    const unsubscribe = onSnapshot(libraryCol, (snapshot) => {
      const timelines = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setSavedTimelines(timelines.sort((a, b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0)));
    }, (err) => console.error("Firestore sync error:", err));
    return () => unsubscribe();
  }, [user]);

  /**
   * RELATIVE IMPORTANCE ENGINE
   */
  const calculateRelativeImportance = (rawEvents) => {
    if (rawEvents.length === 0) return [];
    const sorted = [...rawEvents].sort((a, b) => (a.absoluteImportance || 0) - (b.absoluteImportance || 0));
    const total = sorted.length;
    return sorted.map((evt, idx) => {
      const level = Math.min(10, Math.ceil(((idx + 1) / total) * 10));
      return { ...evt, relativeImportance: level };
    }).sort((a, b) => new Date(a.date) - new Date(b.date));
  };

  const optimizeImageUrl = (url) => {
    if (!url || typeof url !== 'string') return '';
    const wikiMatch = url.match(/(?:wiki\/|File:|title=File:)([^&?#]+)/i);
    if (wikiMatch) {
      let filename = wikiMatch[1].replace(/^File:/i, '');
      try { return `https://commons.wikimedia.org/w/index.php?title=Special:FilePath&file=${decodeURIComponent(filename).replace(/\s/g, '_')}&width=1200`; } catch (e) { return url; }
    }
    return url;
  };

  const handleCreateNew = () => {
    setEvents([]);
    setTimelineTitle(newTitle);
    setTimelineDesc(newDesc);
    setNewTitle('');
    setNewDesc('');
    setShowNewDialog(false);
    setStatusMessage('New timeline created.');
    setTimeout(() => setStatusMessage(''), 3000);
  };

  const handleAddEvents = async () => {
    if (loading) return;
    const apiKey = (geminiKey || "").trim();
    if (!isSandbox && !apiKey) { setError("API Key missing."); return; }
    
    setLoading(true);
    setError('');
    setStatusMessage(`Researching ${numToAdd} more events...`);
    
    const apiVersion = isSandbox ? 'v1beta' : 'v1';
    const modelName = isSandbox ? 'gemini-2.5-flash-preview-09-2025' : 'gemini-2.5-flash-lite';
    const endpoint = `https://generativelanguage.googleapis.com/${apiVersion}/models/${modelName}:generateContent?key=${apiKey}`;
    
    const existingTitles = events.map(e => e.title).join(', ');
    const prompt = `You are a historian. I have a timeline titled "${timelineTitle || 'Historical events'}" with description: "${timelineDesc || 'General history'}".
    Currently, the timeline has these events: [${existingTitles}].
    
    Task: Add ${numToAdd} NEW, UNIQUE key events that are relevant but not already listed.
    For each event, assign an "absoluteImportance" from 1 to 100 based on its global historical impact.
    
    You MUST return ONLY valid JSON.
    Format:
    {
      "events": [
        { "date": "YYYY-MM-DD", "title": "string", "description": "string", "imageurl": "Wikimedia file URL", "absoluteImportance": 85 }
      ]
    }`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      
      const data = await response.json();
      let text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const parsedData = JSON.parse(jsonMatch ? jsonMatch[0] : text);
      const newRawEvents = parsedData.events || [];
      
      const updatedList = [
        ...events,
        ...newRawEvents.map((e, idx) => ({ 
          ...e, 
          id: `ai-${idx}-${Date.now()}`, 
          imageurl: optimizeImageUrl(e.imageurl) 
        }))
      ];
      
      setEvents(calculateRelativeImportance(updatedList));
      setShowAddDialog(false);
      setStatusMessage(`Added ${newRawEvents.length} events.`);
    } catch (err) { setError(`Failed to add events: ${err.message}`); }
    finally { setLoading(false); setTimeout(() => setStatusMessage(''), 3000); }
  };

  const handleSave = async () => {
    if (!user || !db || events.length === 0) return;
    setLoading(true);
    try {
      const id = (timelineTitle || 'timeline').toLowerCase().replace(/\s+/g, '-').slice(0, 30) + '-' + Date.now();
      await setDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'timelines', id), {
        name: timelineTitle || 'Untitled',
        description: timelineDesc,
        events,
        updatedAt: serverTimestamp()
      });
      setStatusMessage("Timeline saved to cloud.");
    } catch (err) { setError("Save failed."); }
    finally { setLoading(false); setTimeout(() => setStatusMessage(''), 3000); }
  };

  const loadFromSheet = async () => {
    if (!sheetUrl) return;
    setLoading(true);
    let fetchUrl = sheetUrl;
    const sheetIdMatch = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (sheetIdMatch && !sheetUrl.includes('tqx=out:csv')) {
      fetchUrl = `https://docs.google.com/spreadsheets/d/${sheetIdMatch[1]}/gviz/tq?tqx=out:csv&gid=${sheetUrl.match(/[#&?]gid=([0-9]+)/)?.[1] || '0'}`;
    }
    try {
      const response = await fetch(fetchUrl);
      const csvText = await response.text();
      const lines = csvText.split(/\r?\n/).filter(l => l.trim());
      const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').toLowerCase().trim());
      const parsed = lines.slice(1).map((line, i) => {
        const row = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
        const obj = { id: `csv-${i}-${Date.now()}` };
        headers.forEach((h, idx) => {
          let val = row[idx]?.replace(/^"|"$/g, '').trim();
          if (h === 'importance' || h === 'absoluteimportance') obj.absoluteImportance = parseInt(val) || 50;
          else if (['image', 'img', 'imageurl'].includes(h)) obj.imageurl = optimizeImageUrl(val);
          else obj[h] = val;
        });
        return obj;
      }).filter(e => e.date && e.title);
      
      setEvents(calculateRelativeImportance(parsed));
      setShowSheetDialog(false);
      setStatusMessage("Import successful.");
    } catch (e) { setError("Failed to parse sheet."); }
    finally { setLoading(false); setTimeout(() => setStatusMessage(''), 3000); }
  };

  const ImageWithFallback = ({ src, alt }) => {
    const [failed, setFailed] = useState(false);
    if (failed || !src) return (
      <div className="h-full w-full bg-slate-100 flex items-center justify-center text-slate-300">
        <Calendar size={32} />
      </div>
    );
    return <img src={src} alt={alt} referrerPolicy="no-referrer" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700" onError={() => setFailed(true)} />;
  };

  const visibleEvents = useMemo(() => 
    events.filter(e => (e.relativeImportance || 1) >= (11 - zoomLevel)), 
  [events, zoomLevel]);

  return (
    <div className="h-screen w-screen bg-[#fafaf9] text-slate-900 font-sans flex flex-col overflow-hidden">
      
      {/* Control Bar */}
      <header className="bg-white border-b border-slate-200 px-6 py-2.5 z-50 shrink-0 shadow-sm flex items-center justify-between gap-6">
        <div className="flex items-center gap-6 flex-1 min-w-0">
          {/* 1. App Icon */}
          <div className="flex items-center gap-3 shrink-0">
            <TimelineLogo size={36} />
            <div className="h-8 w-[1px] bg-slate-100 mx-1" />
          </div>
          
          {/* 2. Title & Description */}
          <div className="flex flex-col min-w-0">
            <h1 className="text-sm font-bold tracking-tight text-slate-900 truncate">
              {timelineTitle || "Timeline"}
            </h1>
            <p className="text-[11px] font-medium text-slate-500 italic truncate">
              {timelineDesc || "Create a timeline and start generating!"}
            </p>
          </div>
        </div>

        {/* 3. Buttons & 4. Scroll bar */}
        <div className="flex items-center gap-4 shrink-0">
          <div className="flex items-center gap-1">
            <button onClick={() => setShowNewDialog(true)} className="p-2 rounded-xl hover:bg-slate-100 text-slate-600 transition-colors" title="New Timeline"><Plus size={18} /></button>
            <button onClick={() => setShowLibrary(true)} className="p-2 rounded-xl hover:bg-slate-100 text-slate-600 transition-colors" title="Open Library"><FolderOpen size={18} /></button>
            <button onClick={handleSave} className="p-2 rounded-xl hover:bg-slate-100 text-slate-600 transition-colors" title="Save Timeline"><Save size={18} /></button>
            <button onClick={() => setShowAddDialog(true)} className="p-2 rounded-xl bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors shadow-sm" title="AI: Add Events"><Diamond size={18} /></button>
            <button onClick={() => setShowSheetDialog(true)} className="p-2 rounded-xl hover:bg-slate-100 text-slate-600 transition-colors" title="Import Sheet"><FileSpreadsheet size={18} /></button>
          </div>

          <div className="h-6 w-[1px] bg-slate-200" />

          <div className="flex items-center gap-2.5 bg-slate-50 px-3 py-1.5 rounded-full border border-slate-100">
            <ZoomOut size={13} className="text-slate-400" />
            <input type="range" min="1" max="10" value={zoomLevel} onChange={(e)=>setZoomLevel(parseInt(e.target.value))} className="w-24 md:w-32 accent-slate-900 cursor-pointer h-1.5"/>
            <ZoomIn size={13} className="text-slate-400" />
          </div>
        </div>
      </header>

      <main className="flex-1 relative overflow-hidden flex flex-col">
        {/* Status / Errors */}
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[60] flex flex-col gap-2 w-full max-w-md pointer-events-none px-4">
          {error && <div className="bg-red-600 text-white text-xs font-bold py-3 px-6 rounded-2xl shadow-xl animate-in fade-in slide-in-from-top-4 pointer-events-auto flex items-center justify-between">{error} <button onClick={()=>setError('')}><X size={14}/></button></div>}
          {statusMessage && <div className="bg-slate-900 text-white text-xs font-bold py-3 px-6 rounded-2xl shadow-xl animate-in fade-in slide-in-from-top-4">{statusMessage}</div>}
        </div>

        {/* Timeline Canvas */}
        <div ref={scrollContainerRef} className="flex-1 overflow-x-auto overflow-y-hidden custom-scrollbar snap-x snap-mandatory">
          <div className="h-full inline-flex items-end pb-32 px-[35vw] min-w-full">
            <div className="flex items-end gap-16 relative">
              <div className="absolute bottom-0 left-[-5000px] right-[-5000px] h-1.5 bg-slate-200 z-0 opacity-40" />
              
              {visibleEvents.length === 0 ? (
                <div className="w-[30vw] flex flex-col items-center justify-center text-slate-300 gap-4 opacity-50">
                  <Sparkles size={48} className="animate-pulse" />
                  <p className="font-serif italic text-lg text-center">Your timeline is blank. Click the diamond to populate it.</p>
                </div>
              ) : visibleEvents.map((evt) => (
                <div key={evt.id} className="relative flex flex-col items-center justify-end w-[320px] md:w-[400px] shrink-0 snap-center group">
                  <div className="w-full bg-white rounded-[2.5rem] border border-slate-100 shadow-xl transition-all duration-700 overflow-hidden flex flex-col mb-16 relative z-20 group-hover:-translate-y-8 group-hover:shadow-2xl">
                    <div className="h-44 md:h-56 overflow-hidden relative bg-slate-50 flex items-center justify-center">
                      <ImageWithFallback src={evt.imageurl} alt={evt.title} />
                      <div className="absolute top-4 right-4 bg-white/90 backdrop-blur px-2 py-1 rounded-lg text-[10px] font-black shadow-sm text-blue-600 uppercase tracking-widest">
                        Tier {evt.relativeImportance}
                      </div>
                    </div>
                    <div className="p-8">
                      <div className="flex justify-between items-center mb-4">
                        <span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 bg-slate-50 px-3 py-1.5 rounded-full border border-slate-100">
                          {new Date(evt.date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                        </span>
                        <button onClick={() => setEvents(calculateRelativeImportance(events.filter(e => e.id !== evt.id)))} className="p-1.5 text-slate-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"><Trash2 size={14}/></button>
                      </div>
                      <h3 className="font-serif font-bold text-xl md:text-2xl text-slate-900 leading-[1.2] mb-3 group-hover:text-blue-600 transition-colors line-clamp-2">{evt.title}</h3>
                      <p className="text-sm text-slate-500 leading-relaxed line-clamp-4 font-medium italic">"{evt.description}"</p>
                    </div>
                  </div>
                  <div className="w-[4px] h-16 bg-slate-900 group-hover:h-24 transition-all duration-700 z-10" />
                  <div className="absolute -bottom-3 w-6 h-6 rounded-full bg-white border-[6px] border-slate-900 shadow-xl z-20 group-hover:scale-125 transition-transform duration-700" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>

      {/* MODALS */}
      
      {/* New Timeline Modal */}
      {showNewDialog && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-6">
          <div className="bg-white rounded-[2.5rem] shadow-2xl max-w-lg w-full p-10 animate-in zoom-in-95">
            <h2 className="text-3xl font-serif font-bold text-slate-900 mb-2">New Timeline</h2>
            <p className="text-slate-500 mb-8 text-sm font-medium">Define the scope of your timeline.</p>
            <div className="space-y-4 mb-8">
              <input value={newTitle} onChange={(e)=>setNewTitle(e.target.value)} placeholder="Timeline Title (e.g. Ancient Rome)" className="w-full px-6 py-4 bg-slate-50 border border-slate-200 rounded-2xl outline-none focus:ring-4 focus:ring-blue-500/10 transition-all font-medium" />
              <textarea value={newDesc} onChange={(e)=>setNewDesc(e.target.value)} placeholder="Short description or focus area..." rows={3} className="w-full px-6 py-4 bg-slate-50 border border-slate-200 rounded-2xl outline-none focus:ring-4 focus:ring-blue-500/10 transition-all font-medium resize-none" />
            </div>
            <div className="flex gap-3">
              <button onClick={()=>setShowNewDialog(false)} className="flex-1 py-4 text-slate-400 font-bold hover:bg-slate-50 rounded-2xl transition-all">Cancel</button>
              <button onClick={handleCreateNew} className="flex-[2] py-4 bg-slate-900 text-white font-bold rounded-2xl shadow-lg hover:bg-slate-800 transition-all">Create Timeline</button>
            </div>
          </div>
        </div>
      )}

      {/* Add Events Modal */}
      {showAddDialog && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-blue-900/40 backdrop-blur-sm p-6">
          <div className="bg-white rounded-[2.5rem] shadow-2xl max-w-lg w-full p-10 animate-in zoom-in-95">
            <div className="bg-blue-600 w-12 h-12 rounded-2xl flex items-center justify-center text-white mb-6 shadow-lg"><Diamond size={24} /></div>
            <h2 className="text-3xl font-serif font-bold text-slate-900 mb-2">Add Content</h2>
            <p className="text-slate-500 mb-8 text-sm font-medium">How many new events should the AI research for your <b>{timelineTitle || 'current'}</b> timeline?</p>
            
            <div className="bg-slate-50 p-6 rounded-2xl border border-slate-200 mb-8 flex flex-col items-center gap-4">
              <span className="text-4xl font-black text-slate-900">{numToAdd}</span>
              <input type="range" min="1" max="10" value={numToAdd} onChange={(e)=>setNumToAdd(parseInt(e.target.value))} className="w-full accent-blue-600" />
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Select 1 to 10 events</p>
            </div>

            <div className="flex gap-3">
              <button onClick={()=>setShowAddDialog(false)} className="flex-1 py-4 text-slate-400 font-bold hover:bg-slate-50 rounded-2xl transition-all">Cancel</button>
              <button onClick={handleAddEvents} disabled={loading} className="flex-[2] py-4 bg-blue-600 text-white font-bold rounded-2xl shadow-lg hover:bg-blue-700 disabled:opacity-50 transition-all flex items-center justify-center gap-2">
                {loading ? <RefreshCw size={18} className="animate-spin" /> : 'Generate Content'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Open Library Modal */}
      {showLibrary && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-6">
          <div className="bg-white rounded-[2.5rem] shadow-2xl max-w-4xl w-full p-10 animate-in zoom-in-95 flex flex-col max-h-[85vh]">
            <div className="flex justify-between items-center mb-8">
              <h2 className="text-3xl font-serif font-bold text-slate-900">Archived Timelines</h2>
              <button onClick={()=>setShowLibrary(false)} className="p-2 hover:bg-slate-100 rounded-full transition-colors"><X size={24}/></button>
            </div>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 overflow-y-auto custom-scrollbar pr-2">
              {savedTimelines.length === 0 ? (
                <div className="col-span-full py-20 text-center text-slate-400 font-serif italic">Your library is currently empty.</div>
              ) : savedTimelines.map(tl => (
                <div key={tl.id} onClick={() => {
                  setTimelineTitle(tl.name);
                  setTimelineDesc(tl.description || '');
                  setEvents(tl.events || []);
                  setShowLibrary(false);
                }} className="bg-slate-50 hover:bg-white border border-slate-200 rounded-3xl p-6 cursor-pointer transition-all hover:shadow-xl hover:-translate-y-1 group">
                  <div className="flex justify-between items-start mb-4">
                    <h4 className="font-bold text-slate-900 line-clamp-1">{tl.name}</h4>
                    <button onClick={async (e) => {
                      e.stopPropagation();
                      if (db && user) await deleteDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'timelines', tl.id));
                    }} className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"><Trash2 size={16}/></button>
                  </div>
                  <p className="text-xs text-slate-500 line-clamp-2 mb-6 h-8 italic font-medium">"{tl.description}"</p>
                  <div className="flex justify-between items-center text-[10px] font-black uppercase tracking-widest text-slate-400">
                    <span>{tl.events?.length || 0} Events</span>
                    <span>{tl.updatedAt?.seconds ? new Date(tl.updatedAt.seconds * 1000).toLocaleDateString() : '---'}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Spreadsheet Dialog */}
      {showSheetDialog && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-green-900/30 backdrop-blur-sm p-6">
          <div className="bg-white rounded-[2.5rem] shadow-2xl max-w-lg w-full p-10 animate-in zoom-in-95">
            <div className="bg-green-600 w-12 h-12 rounded-2xl flex items-center justify-center text-white mb-6 shadow-lg"><FileSpreadsheet size={24} /></div>
            <h2 className="text-3xl font-serif font-bold text-slate-900 mb-2">Import Spreadsheet</h2>
            <p className="text-slate-500 mb-8 text-sm font-medium">Paste a Public Google Sheet URL. Headers should include: <i>date, title, description, image, absoluteimportance</i>.</p>
            <input value={sheetUrl} onChange={(e)=>setSheetUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/..." className="w-full px-6 py-4 bg-slate-50 border border-slate-200 rounded-2xl mb-8 outline-none focus:ring-4 focus:ring-green-500/10 font-mono text-xs" />
            <div className="flex gap-3">
              <button onClick={()=>setShowSheetDialog(false)} className="flex-1 py-4 text-slate-400 font-bold hover:bg-slate-50 rounded-2xl transition-all">Cancel</button>
              <button onClick={loadFromSheet} disabled={loading || !sheetUrl} className="flex-[2] py-4 bg-green-600 text-white font-bold rounded-2xl shadow-lg hover:bg-green-700 disabled:opacity-50 transition-all">Import CSV</button>
            </div>
          </div>
        </div>
      )}

      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar { height: 8px; background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background-color: #e2e8f0; border-radius: 20px; border: 2px solid #fafaf9; background-clip: content-box; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .animate-in { animation: fadeIn 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        .custom-scrollbar { scroll-behavior: smooth; }
      `}} />
    </div>
  );
}