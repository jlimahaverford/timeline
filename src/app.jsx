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
  ExternalLink
} from 'lucide-react';

// Firebase Imports
import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInAnonymously, signInWithCustomToken } from 'firebase/auth';
import { getFirestore, doc, setDoc, collection, onSnapshot, deleteDoc, serverTimestamp } from 'firebase/firestore';

// --- Firebase Configuration ---
// In a production app, these would be in an .env file
const firebaseConfig = JSON.parse(__firebase_config);
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = typeof __app_id !== 'undefined' ? __app_id : 'timeline-pro-production';

// --- Constants ---
const DEFAULT_SHEET_URL = "https://docs.google.com/spreadsheets/d/1PUuaIAelViebAgOjtf3vXeMy-k59e82fDIn253s7EFM/edit?gid=0#gid=0";
const MAX_RETRIES = 5;
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000];

export default function App() {
  // --- Auth & Profile ---
  const [user, setUser] = useState(null);
  
  // --- Timeline Data ---
  const [events, setEvents] = useState([]);
  const [zoomLevel, setZoomLevel] = useState(5); 
  const [sheetUrl, setSheetUrl] = useState(DEFAULT_SHEET_URL);
  const [aiTopic, setAiTopic] = useState('');
  
  // --- Status & UI ---
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState('');
  const [shareSuccess, setShareSuccess] = useState(false);
  const [showSettings, setShowSettings] = useState(true);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [savedTimelines, setSavedTimelines] = useState([]);
  
  // --- Scrolling Refs ---
  const scrollContainerRef = useRef(null);
  const dateDisplayRef = useRef(null);
  const eventRefs = useRef({});

  // --- 1. Authentication ---
  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (err) {
        setError("Cloud sync unavailable. Please refresh.");
      }
    };

    initAuth();
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  // --- 2. Real-time Library Sync ---
  useEffect(() => {
    if (!user) return;
    // Rule 1: Strict Paths required for Firebase permissions
    const libraryCol = collection(db, 'artifacts', appId, 'users', user.uid, 'timelines');
    const unsubscribe = onSnapshot(libraryCol, (snapshot) => {
      const timelines = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      // Rule 2: Manual sorting to avoid complex index requirements
      setSavedTimelines(timelines.sort((a, b) => 
        (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0)
      ));
    }, (err) => {
      console.error("Firestore Listen Error:", err);
    });
    return () => unsubscribe();
  }, [user]);

  // --- Image Processing ---
  const optimizeImageUrl = (url) => {
    if (!url) return '';
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

  // --- Data Handlers ---
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
    setStatusMessage('Syncing data...');
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
    } catch (err) { setError("Could not load sheet. Is it public?"); }
    finally { setLoading(false); }
  };

  const handleAIGeneration = async () => {
    if (!aiTopic || loading) return;
    setLoading(true);
    setError('');
    setStatusMessage(`Generating "${aiTopic}"...`);
    const apiKey = ""; // Runtime provides this
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
    
    const prompt = `Comprehensive historical timeline: "${aiTopic}". 35 events. JSON: {events:[{date, title, description, imageurl(wikimedia), importance(1-10)}]}`;

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
        const data = await response.json();
        return JSON.parse(data.candidates[0].content.parts[0].text).events;
      } catch (err) {
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
          return fetchWithRetry(attempt + 1);
        }
        throw err;
      }
    };

    try {
      const gen = await fetchWithRetry();
      setEvents(gen.map((e, idx) => ({...e, id: `ai-${idx}-${Date.now()}`, imageurl: optimizeImageUrl(e.imageurl)})));
    } catch (err) { setError("AI failed. Try a different topic."); }
    finally { setLoading(false); }
  };

  // --- Cloud Actions ---
  const saveTimeline = async () => {
    if (!user || !saveName.trim() || events.length === 0) return;
    setLoading(true);
    try {
      const id = saveName.toLowerCase().replace(/\s+/g, '-').slice(0, 40) + '-' + Date.now();
      await setDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'timelines', id), {
        name: saveName,
        events,
        zoomLevel,
        topic: aiTopic || "Custom",
        updatedAt: serverTimestamp()
      });
      setShowSaveDialog(false);
      setSaveName('');
      setStatusMessage("Saved to Library");
      setTimeout(() => setStatusMessage(''), 3000);
    } catch (err) { setError("Cloud save failed."); }
    finally { setLoading(false); }
  };

  const deleteTimeline = async (id, e) => {
    e.stopPropagation();
    try { await deleteDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'timelines', id)); }
    catch (err) { setError("Delete failed."); }
  };

  const loadTimelineFromLibrary = (tl) => {
    setEvents(tl.events);
    setZoomLevel(tl.zoomLevel || 5);
    setAiTopic(tl.topic || '');
    setShowLibrary(false);
    setStatusMessage(`Loaded: ${tl.name}`);
    setTimeout(() => setStatusMessage(''), 3000);
  };

  // --- Layout Logic ---
  const visibleEvents = useMemo(() => 
    events.filter(e => (e.importance || 1) >= (11 - zoomLevel)), 
  [events, zoomLevel]);

  const layoutItems = useMemo(() => {
    const items = [];
    let lastYear = null;
    visibleEvents.forEach((event, idx) => {
      const year = new Date(event.date).getFullYear();
      if (lastYear !== null && year > lastYear) {
        const step = (year - lastYear) > 50 ? 25 : 5;
        for (let y = lastYear + step; y < year; y += step) 
          items.push({ type: 'marker', year: y, id: `m-${y}-${idx}` });
      }
      items.push({ type: 'event', data: event, id: event.id });
      lastYear = year;
    });
    return items;
  }, [visibleEvents]);

  // --- Share Logic ---
  const handleShare = () => {
    // Construct a production-safe URL
    const url = new URL(window.location.href);
    if (aiTopic) url.hash = `ai=${encodeURIComponent(aiTopic)}`;
    else if (sheetUrl) url.hash = `sheet=${encodeURIComponent(sheetUrl)}`;
    
    // Fallback for iFrame restrictions
    try {
      navigator.clipboard.writeText(url.toString());
      document.execCommand('copy'); 
      setShareSuccess(true);
      setTimeout(() => setShareSuccess(false), 2000);
    } catch (e) { setError("Sharing not supported in this browser."); }
  };

  // Image Fallback Component
  const ImageWithFallback = ({ src, alt }) => {
    const [failed, setFailed] = useState(false);
    if (failed || !src) return (
      <div className="h-full w-full bg-slate-50 flex flex-col items-center justify-center">
        <ImageIcon size={32} className="text-slate-200 mb-2" />
        <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">Image Loading...</span>
      </div>
    );
    return (
      <img src={src} alt={alt} referrerPolicy="no-referrer" 
        className="w-full h-full object-cover transition-all duration-700 group-hover:scale-105" 
        onError={() => setFailed(true)} />
    );
  };

  return (
    <div className="h-screen bg-[#fafaf9] text-slate-900 font-sans flex flex-col overflow-hidden selection:bg-blue-100">
      
      {/* Header */}
      <header className="bg-white/90 backdrop-blur-md border-b border-slate-200 px-6 py-4 z-50 shrink-0 shadow-sm">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row gap-4 items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="bg-slate-900 text-white p-2.5 rounded-2xl shadow-lg">
              <Layers size={24} />
            </div>
            <div>
              <h1 className="text-xl font-bold font-serif text-slate-900 tracking-tight">Timeline Pro</h1>
              <div className="flex items-center gap-2 text-[10px] text-slate-400 uppercase tracking-widest font-bold">
                <span className={`w-1.5 h-1.5 rounded-full ${user ? 'bg-green-500 animate-pulse' : 'bg-slate-300'}`} />
                {user ? `UID: ${user.uid.slice(0,8)}` : 'Connecting...'}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 w-full md:w-auto">
            <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-full mr-2">
              <button onClick={() => setZoomLevel(Math.max(1, zoomLevel - 1))} className="p-2 hover:bg-white rounded-full text-slate-500 transition-all"><ZoomOut size={16}/></button>
              <input type="range" min="1" max="10" value={zoomLevel} onChange={(e)=>setZoomLevel(parseInt(e.target.value))} className="w-16 md:w-24 accent-slate-800"/>
              <button onClick={() => setZoomLevel(Math.min(10, zoomLevel + 1))} className="p-2 hover:bg-white rounded-full text-slate-500 transition-all"><ZoomIn size={16}/></button>
            </div>

            <button onClick={() => setShowLibrary(!showLibrary)} className={`p-3 rounded-full border transition-all ${showLibrary ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`} title="Library"><FolderOpen size={18} /></button>
            <button onClick={() => setShowSaveDialog(true)} disabled={events.length === 0} className="p-3 rounded-full border bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-30 transition-all" title="Save"><Save size={18} /></button>
            <button onClick={handleShare} className="p-3 rounded-full border bg-white text-slate-600 hover:bg-slate-50 transition-all" title="Share Link">
              {shareSuccess ? <CheckCircle2 size={18} className="text-green-500" /> : <Share2 size={18} />}
            </button>
            <button onClick={() => setShowSettings(!showSettings)} className={`p-3 rounded-full border transition-all ${showSettings ? 'bg-slate-900 text-white' : 'bg-white text-slate-600'}`}><Search size={18} /></button>
          </div>
        </div>

        {/* Dynamic Navigation Panels */}
        <div className="max-w-7xl mx-auto overflow-hidden">
          {showSettings && (
            <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4 animate-in slide-in-from-top-4 duration-300">
              <div className="flex gap-2">
                <input type="text" placeholder="Google Sheet Link..." value={sheetUrl} onChange={(e)=>setSheetUrl(e.target.value)} className="flex-1 px-4 py-3 bg-slate-50 border rounded-2xl text-sm"/>
                <button onClick={()=>loadFromSheet(sheetUrl)} className="px-6 py-3 bg-slate-900 text-white rounded-2xl font-bold shadow-md">Sync</button>
              </div>
              <div className="flex gap-2">
                <input type="text" placeholder="AI Topic (e.g. History of Rome)" value={aiTopic} onChange={(e)=>setAiTopic(e.target.value)} onKeyDown={(e)=>e.key==='Enter'&&handleAIGeneration()} className="flex-1 px-4 py-3 bg-blue-50/30 border border-blue-100 rounded-2xl text-sm"/>
                <button onClick={handleAIGeneration} disabled={loading} className="px-6 py-3 bg-blue-600 text-white rounded-2xl font-bold shadow-md">Generate</button>
              </div>
            </div>
          )}

          {showLibrary && (
            <div className="mt-6 p-6 bg-slate-900 rounded-[2rem] shadow-2xl animate-in slide-in-from-top-4 duration-300">
              <div className="flex justify-between items-center mb-6 px-2">
                <h3 className="text-white font-bold flex items-center gap-2 font-serif text-lg"><FolderOpen size={20} className="text-blue-400"/> My Personal Library</h3>
                <button onClick={()=>setShowLibrary(false)} className="text-slate-500 hover:text-white"><X size={24}/></button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 max-h-[40vh] overflow-y-auto custom-scrollbar p-1">
                {savedTimelines.length === 0 ? (
                  <div className="col-span-full py-12 text-center text-slate-500 text-sm italic">You haven't saved any timelines to the cloud yet.</div>
                ) : savedTimelines.map(tl => (
                  <div key={tl.id} onClick={()=>loadTimelineFromLibrary(tl)} className="bg-slate-800 hover:bg-slate-700 p-5 rounded-2xl cursor-pointer transition-all border border-slate-700 group relative">
                    <div className="flex justify-between items-start mb-3">
                      <span className="text-white font-bold text-sm leading-tight">{tl.name}</span>
                      <button onClick={(e)=>deleteTimeline(tl.id, e)} className="text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all p-1"><Trash2 size={16}/></button>
                    </div>
                    <div className="text-[10px] text-slate-500 flex justify-between uppercase font-bold tracking-widest">
                      <span>{tl.events.length} Points</span>
                      <span>{new Date(tl.updatedAt?.seconds * 1000).toLocaleDateString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Status Bar */}
        {(error || statusMessage || loading) && (
          <div className="max-w-7xl mx-auto mt-4">
            {error && <div className="text-sm text-red-600 flex items-center gap-2 bg-red-50 p-4 rounded-2xl border border-red-100 animate-in fade-in"><AlertCircle size={18} /> {error}</div>}
            {statusMessage && <div className="text-sm text-blue-700 flex items-center gap-2 bg-blue-50 p-4 rounded-2xl border border-blue-100 shadow-sm animate-in fade-in"><CheckCircle2 size={18}/> {statusMessage}</div>}
            {loading && !error && !statusMessage && <div className="text-sm text-blue-700 flex items-center gap-3 bg-blue-50/50 p-4 rounded-2xl animate-pulse"><RefreshCw size={18} className="animate-spin"/> Crafting narrative...</div>}
          </div>
        )}
      </header>

      {/* Main Interactive Stage */}
      <main className="flex-1 relative overflow-hidden flex flex-col">
        <div className="absolute top-10 left-1/2 -translate-x-1/2 z-40 pointer-events-none">
          <div className="bg-slate-900/90 backdrop-blur-xl text-white px-10 py-3 rounded-full shadow-2xl flex items-center gap-4 border border-white/20">
            <Calendar size={18} className="text-slate-400" />
            <span ref={dateDisplayRef} className="font-serif font-black tracking-[0.2em] text-xl uppercase min-w-[160px] text-center">Narrative</span>
          </div>
        </div>

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
                  <div key={item.id} ref={el => eventRefs.current[item.id] = el} data-date={new Date(item.data.date).toLocaleDateString('en-US',{month:'short',year:'numeric'})} className="relative flex flex-col items-center justify-end w-[320px] md:w-[420px] shrink-0 snap-center group">
                    <div className="w-full bg-white rounded-[3rem] border border-slate-100 shadow-2xl transition-all duration-700 overflow-hidden flex flex-col mb-16 relative z-20 hover:-translate-y-8 hover:shadow-[0_40px_80px_rgba(0,0,0,0.1)]">
                      <div className="h-48 md:h-64 overflow-hidden relative bg-slate-100 flex items-center justify-center">
                        <ImageWithFallback src={item.data.imageurl} alt={item.data.title} />
                      </div>
                      <div className="p-10">
                        <div className="flex justify-between items-center mb-6">
                          <span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 bg-slate-50 px-4 py-2 rounded-full border border-slate-100">
                            {new Date(item.data.date).toLocaleDateString()}
                          </span>
                          <div className="flex gap-1 items-center">
                            {[...Array(Math.ceil((item.data.importance||1)/2))].map((_,i) => (
                              <div key={i} className="w-1.5 h-1.5 rounded-full bg-blue-500/30" />
                            ))}
                          </div>
                        </div>
                        <h3 className="font-serif font-bold text-2xl md:text-3xl text-slate-900 leading-[1.1] mb-6 group-hover:text-blue-600 transition-colors line-clamp-2">
                          {item.data.title}
                        </h3>
                        <p className="text-base text-slate-500 leading-relaxed line-clamp-4 font-medium italic">
                          "{item.data.description}"
                        </p>
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

        <div className="absolute bottom-8 left-10 right-10 pointer-events-none flex justify-between items-center z-40">
           <div className="bg-white/90 backdrop-blur p-4 rounded-2xl shadow-xl border border-slate-100 flex items-center gap-3 text-[10px] font-black tracking-widest text-slate-400 uppercase">
             <ChevronLeft size={16}/> Glide Through Time
           </div>
           <div className="bg-white/90 backdrop-blur p-4 rounded-2xl shadow-xl border border-slate-100 flex items-center gap-6 text-[10px] font-black tracking-widest text-slate-600 uppercase">
             <span>Narrative Points: {visibleEvents.length}</span>
             <ExternalLink size={16} className="text-slate-300" />
           </div>
        </div>
      </main>

      {/* Cloud Save Dialog */}
      {showSaveDialog && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/90 backdrop-blur-md p-6">
          <div className="bg-white rounded-[3rem] shadow-2xl max-w-lg w-full p-12 animate-in zoom-in-95 duration-300 border border-white/20">
            <div className="bg-blue-50 w-16 h-16 rounded-3xl flex items-center justify-center text-blue-600 mb-8">
              <Sparkles size={32} />
            </div>
            <h2 className="text-3xl font-serif font-bold text-slate-900 mb-4">Name Your Project</h2>
            <p className="text-slate-500 mb-10 leading-relaxed font-medium text-lg">Your work will be securely saved to your private cloud library and accessible from any device.</p>
            <input autoFocus type="text" placeholder="e.g. The Age of Discovery" value={saveName} onChange={(e)=>setSaveName(e.target.value)} onKeyDown={(e)=>e.key==='Enter'&&saveTimeline()} className="w-full px-8 py-5 bg-slate-50 border border-slate-200 rounded-[2rem] mb-10 text-xl font-medium focus:ring-4 focus:ring-blue-500/10 focus:outline-none transition-all" />
            <div className="flex gap-4">
              <button onClick={()=>setShowSaveDialog(false)} className="flex-1 py-5 text-slate-400 font-bold hover:bg-slate-50 rounded-[2rem] transition-all text-lg">Dismiss</button>
              <button onClick={saveTimeline} disabled={!saveName.trim() || loading} className="flex-[2] py-5 bg-blue-600 text-white font-bold rounded-[2rem] shadow-2xl hover:bg-blue-700 disabled:opacity-50 transition-all text-lg flex items-center justify-center gap-2">
                {loading ? 'Encrypting...' : 'Save Timeline'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global Aesthetics */}
      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar { height: 12px; background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background-color: #cbd5e1; border-radius: 30px; border: 4px solid #fafaf9; background-clip: content-box; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background-color: #94a3b8; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        .animate-in { animation: fadeIn 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
      `}} />
    </div>
  );
}
