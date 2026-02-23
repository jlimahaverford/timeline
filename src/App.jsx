import './index.css';
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
    isSandbox: false
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
  const [zoomLevel, setZoomLevel] = useState(10); 
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

  // Auth Initialization
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

  const parseCSV =