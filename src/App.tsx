/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, RefreshCw, CheckCircle2, XCircle, Search, AlertCircle, Scan, History, LogIn, LogOut, User } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI } from "@google/genai";
import confetti from 'canvas-confetti';

// Firebase Imports
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, User as FirebaseUser } from 'firebase/auth';
import { getFirestore, doc, setDoc, collection, addDoc, serverTimestamp, query, orderBy, limit, onSnapshot, getDoc, where } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

// Types
interface CloverDevice {
  sn: string;
  cloverId: string;
  status: string;
  rmaDate: string;
}

interface ScanResult {
  sn: string;
  timestamp: string;
  status: 'matched' | 'not-found' | 'mismatch';
  expectedId?: string;
  enteredId?: string;
}

const GOOGLE_SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/1A3gDud_P68v-ezRpBAroEvX6Li11xbR2GpZF1H-Cew0/export?format=csv`;

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
const auth = getAuth(app);

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [devices, setDevices] = useState<CloverDevice[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isScanning, setIsScanning] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [lastScan, setLastScan] = useState<ScanResult | null>(null);
  const [enteredId, setEnteredId] = useState('');
  const [manualSn, setManualSn] = useState('');
  const [scanHistory, setScanHistory] = useState<ScanResult[]>([]);
  const [availableCloverIds, setAvailableCloverIds] = useState<string[]>([]);
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Initialize AI
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  // Update or Add device to Firestore
  const saveDeviceState = async (sn: string, cloverId: string, rmaRequested: boolean) => {
    if (!user) {
      setError('Authentication required to save changes.');
      return;
    }
    
    setIsUpdating(true);
    try {
      const deviceRef = doc(db, 'devices', sn);
      await setDoc(deviceRef, {
        sn,
        cloverId,
        rmaDate: rmaRequested ? new Date().toISOString().split('T')[0] : '',
        status: rmaRequested ? 'RMA REQUESTED' : 'UPDATED',
        updatedAt: serverTimestamp()
      }, { merge: true });
      
      // Update local state temporarily
      const updatedDevices = [...devices];
      const index = updatedDevices.findIndex(d => d.sn === sn);
      if (index > -1) {
        updatedDevices[index] = { ...updatedDevices[index], cloverId, rmaDate: rmaRequested ? 'YES' : '' };
      } else {
        updatedDevices.push({ sn, cloverId, status: 'ADDED', rmaDate: rmaRequested ? 'YES' : '' });
      }
      setDevices(updatedDevices);
      
      // Refresh current scan view
      if (lastScan && lastScan.sn === sn) {
        setLastScan({
          ...lastScan,
          expectedId: cloverId,
          status: 'matched'
        });
      }
      
      confetti({ particleCount: 50, spread: 60, colors: ['#4F46E5', '#10B981'] });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `devices/${sn}`);
    } finally {
      setIsUpdating(false);
    }
  };

  // Fetch data from Google Sheet
  const fetchData = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(GOOGLE_SHEET_CSV_URL);
      const text = await response.text();
      const rows = text.split('\n').slice(1); // Skip header
      
      const parsedDevices: CloverDevice[] = [];
      const availableIds: string[] = [];

      rows.forEach(row => {
        const columns = row.split(',');
        const sn = columns[0]?.trim();
        const id = columns[1]?.trim();
        const availableId = columns[5]?.trim();

        if (sn) {
          parsedDevices.push({
            sn,
            cloverId: id || '',
            status: columns[2]?.trim() || '',
            rmaDate: columns[4]?.trim() || '',
          });
        }

        if (availableId && !isNaN(Number(availableId))) {
          availableIds.push(availableId);
        }
      });

      setDevices(parsedDevices);
      setAvailableCloverIds(availableIds);
      setError(null);
      
      // Optionally sync to Firestore if specific devices are missing
      // (This would be a background task, skipped for now to avoid quota limits)
    } catch (err) {
      console.error('Failed to fetch sheet data:', err);
      setError('Could not sync with Google Sheets. Using offline mode.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();

    // Set up Auth listener
    const unsubscribeAuth = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });

    return () => unsubscribeAuth();
  }, []);

  // Listen to Scan History from Firestore if logged in
  useEffect(() => {
    if (!user) {
      setScanHistory([]);
      return;
    }

    const q = query(
      collection(db, 'scans'),
      where('userId', '==', user.uid),
      orderBy('timestamp', 'desc'),
      limit(20)
    );

    const unsubscribeScans = onSnapshot(q, (snapshot) => {
      const scans: ScanResult[] = snapshot.docs.map(doc => {
        const data = doc.data();
        return {
          sn: data.sn,
          timestamp: data.timestamp?.toDate()?.toLocaleTimeString() || '...',
          status: data.status,
          expectedId: data.expectedId,
          enteredId: data.enteredId
        };
      });
      setScanHistory(scans);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'scans');
    });

    return () => unsubscribeScans();
  }, [user]);

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error('Login failed:', err);
      setError('Login failed. Using guest mode.');
    }
  };

  const handleLogout = () => signOut(auth);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment' } 
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setCameraActive(true);
      }
    } catch (err) {
      console.error('Camera access denied:', err);
      setError('Camera access denied. Please enable camera permissions.');
    }
  };

  const stopCamera = () => {
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
      setCameraActive(false);
    }
  };

  const performOcr = async (imageData: string): Promise<string | null> => {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          {
            parts: [
              { text: "Extract the serial number (S/N) from this Clover device label. It usually starts with 'C04'. Return ONLY the serial number string with no extra text. If no serial number is found, return 'NOT_FOUND'." },
              { inlineData: { mimeType: "image/jpeg", data: imageData.split(',')[1] } }
            ]
          }
        ]
      });

      const text = response.text?.trim() || 'NOT_FOUND';
      return text === 'NOT_FOUND' ? null : text;
    } catch (err) {
      console.error('AI OCR failed:', err);
      return null;
    }
  };

  const handleScan = async () => {
    if (!videoRef.current || !canvasRef.current || isScanning) return;

    setIsScanning(true);
    const canvas = canvasRef.current;
    const video = videoRef.current;
    
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = canvas.toDataURL('image/jpeg', 0.8);

    const detectedSn = await performOcr(imageData);
    
    if (detectedSn) {
      setManualSn(detectedSn);
      // Trigger identification logic
      validateDevice(detectedSn, enteredId);
    } else {
      setError('Could not detect a serial number. Please try again or enter manually.');
    }
    
    setIsScanning(false);
  };

  const validateDevice = async (snToValidate: string, idToValidate: string) => {
    const device = devices.find(d => d.sn === snToValidate);
    let status: ScanResult['status'] = 'not-found';
    let expectedId = '';

    if (device) {
      expectedId = device.cloverId;
      if (!idToValidate) {
        status = 'matched'; 
      } else {
        status = device.cloverId === idToValidate ? 'matched' : 'mismatch';
      }
    }

    const result: ScanResult = {
      sn: snToValidate,
      timestamp: new Date().toLocaleTimeString(),
      status,
      expectedId,
      enteredId: idToValidate
    };

    setLastScan(result);
    // Local state fallback if not logged in
    if (!user) {
      setScanHistory(prev => [result, ...prev].slice(0, 10));
    }

    // Persist to Firestore if logged in
    if (user) {
      try {
        await addDoc(collection(db, 'scans'), {
          sn: result.sn,
          status: result.status,
          expectedId: result.expectedId || '',
          enteredId: result.enteredId || '',
          timestamp: serverTimestamp(),
          userId: user.uid
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, 'scans');
      }
    }

    if (status === 'matched') {
      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.6 }
      });
    }
  };

  const handleManualCheck = () => {
    if (!manualSn) return;
    validateDevice(manualSn, enteredId);
  };

  return (
    <div className="min-h-screen bg-[#0A0B0D] text-[#E0E0E0] font-sans p-4 md:p-6 flex flex-col gap-6 selection:bg-indigo-500/30">
      {/* Header Section */}
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <Scan className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white uppercase">CloverOps</h1>
            <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest">Inventory & Assignment Sync</p>
          </div>
        </div>
        <div className="flex gap-4">
          <div className="hidden lg:flex px-4 py-2 bg-zinc-900 border border-zinc-800 rounded-md items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isLoading ? 'bg-yellow-500 animate-pulse' : 'bg-green-500'}`}></div>
            <span className="text-[10px] font-mono text-zinc-400 uppercase tracking-widest">GS_LINK: {isLoading ? 'SYNCING' : 'ACTIVE'}</span>
          </div>

          <div className="flex gap-2">
            {!user ? (
              <button 
                onClick={handleLogin}
                className="flex items-center gap-2 px-4 py-2 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 transition-colors text-[10px] font-mono text-white"
              >
                <LogIn className="w-3 h-3" />
                LOGIN
              </button>
            ) : (
              <button 
                onClick={handleLogout}
                className="flex items-center gap-2 px-4 py-2 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 transition-colors text-[10px] font-mono text-zinc-400"
              >
                <LogOut className="w-3 h-3" />
                {user.email?.split('@')[0].toUpperCase()}
              </button>
            )}
            <button 
              onClick={fetchData}
              className="p-2 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 transition-colors text-zinc-400"
              title="Force Sync"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-indigo-400' : ''}`} />
            </button>
          </div>
        </div>
      </header>

      {/* Error Alert */}
      <AnimatePresence>
        {error && (
          <motion.div 
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="bg-red-500/10 border border-red-500/50 text-red-400 px-4 py-2 rounded-xl text-xs font-mono flex items-center gap-3 overflow-hidden"
          >
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
            <button className="ml-auto hover:text-white" onClick={() => setError(null)}>×</button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Bento Grid */}
      <div className="grid grid-cols-12 gap-4 flex-grow">
        
        {/* Camera View Finder - Span 5 columns on desktop */}
        <div className="col-span-12 lg:col-span-5 row-span-4 bg-zinc-900 border border-zinc-800 rounded-3xl relative overflow-hidden flex flex-col shadow-2xl">
          <div className="absolute top-4 left-4 z-20 bg-black/60 backdrop-blur-sm px-3 py-1 rounded-full text-[10px] font-mono text-indigo-400 border border-indigo-500/20">
            LIVE_FEED: {cameraActive ? 'CAMERA_01' : 'OFFLINE'}
          </div>
          
          <div className="flex-grow flex items-center justify-center relative bg-black">
            {!cameraActive ? (
              <div className="flex flex-col items-center gap-4 text-center">
                <div className="w-16 h-16 rounded-full bg-zinc-800 flex items-center justify-center mb-2">
                  <Camera className="w-8 h-8 text-zinc-600" />
                </div>
                <p className="text-zinc-500 font-mono text-xs uppercase tracking-widest">Initialization Required</p>
                <button 
                  onClick={startCamera}
                  className="px-6 py-2 bg-indigo-600 text-white rounded-xl font-bold text-xs hover:bg-indigo-500 transition-all active:scale-95 shadow-lg shadow-indigo-500/20"
                >
                  ACTIVATE SCANNER
                </button>
              </div>
            ) : (
              <>
                <video 
                  ref={videoRef} 
                  autoPlay 
                  playsInline 
                  className="w-full h-full object-cover opacity-80"
                />
                {/* Viewfinder overlay */}
                <div className="absolute inset-0 border-[30px] border-black/30 pointer-events-none">
                  <div className="w-full h-full border border-indigo-500/30 relative">
                     {/* Corner marks */}
                    <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-indigo-500" />
                    <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-indigo-500" />
                    <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-indigo-500" />
                    <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-indigo-500" />
                    
                    {/* Scanning line */}
                    {isScanning && (
                      <motion.div 
                        initial={{ top: 0 }}
                        animate={{ top: '100%' }}
                        transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                        className="absolute left-0 right-0 h-0.5 bg-indigo-500 shadow-[0_0_15px_rgba(79,70,229,0.8)] z-10"
                      />
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="p-4 bg-zinc-900 border-t border-zinc-800 grid grid-cols-2 gap-3">
             <button 
              onClick={handleScan}
              disabled={!cameraActive || isScanning}
              className="flex-grow bg-white text-black rounded-xl font-bold text-xs uppercase tracking-wider h-12 flex items-center justify-center gap-2 hover:bg-zinc-200 transition-all disabled:opacity-50 disabled:grayscale"
            >
              {isScanning ? <RefreshCw className="animate-spin w-4 h-4" /> : <Scan className="w-4 h-4" />}
              {isScanning ? 'Syncing...' : 'Capture S/N'}
            </button>
            <button 
              onClick={cameraActive ? stopCamera : startCamera}
              className="bg-zinc-800 text-white rounded-xl text-xs font-bold hover:bg-zinc-700 transition-all flex items-center justify-center border border-zinc-700"
            >
              {cameraActive ? 'TERMINATE' : 'INITIALIZE'}
            </button>
          </div>
        </div>

        {/* Verification Desk - Span 7 columns */}
        <div className="col-span-12 lg:col-span-7 row-span-2 bg-zinc-900/40 border border-zinc-800 rounded-3xl p-6 flex flex-col justify-between shadow-xl backdrop-blur-sm">
          <div className="flex justify-between items-start">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Verification Desk</h2>
            <div className="flex items-center gap-2">
              <span className="px-2 py-1 bg-zinc-800 rounded text-[10px] font-mono text-indigo-400">SESSION: {new Date().getHours()}{new Date().getMinutes()}</span>
            </div>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
            <div className="space-y-1.5">
              <label className="block text-[10px] uppercase text-zinc-500 font-mono tracking-tighter">Scanned Serial Number</label>
              <div className="relative">
                <input 
                  type="text" 
                  value={manualSn}
                  onChange={(e) => setManualSn(e.target.value.toUpperCase())}
                  placeholder="CLV-XXXXXXXX"
                  className="w-full bg-zinc-800/50 border border-zinc-700 rounded-xl p-3 font-mono text-base text-white focus:outline-none focus:border-indigo-500/50 transition-all"
                />
                {manualSn && <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 opacity-20" />}
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="block text-[10px] uppercase text-zinc-500 font-mono tracking-tighter">Label ID (On Device)</label>
              <input 
                type="text" 
                value={enteredId}
                onChange={(e) => setEnteredId(e.target.value)}
                placeholder="E.G. #14"
                className="w-full bg-black border border-indigo-500/30 rounded-xl p-3 font-mono text-base text-white outline-none focus:border-indigo-500 shadow-[0_0_15px_rgba(79,70,229,0.1)] transition-all"
              />
            </div>
          </div>

          <button 
            onClick={handleManualCheck}
            disabled={!manualSn}
            className="mt-4 w-full bg-indigo-600 rounded-xl py-3 font-bold text-xs uppercase tracking-widest hover:bg-indigo-500 transition-all active:scale-[0.99] disabled:opacity-30 flex items-center justify-center gap-2"
          >
            Run Integrity Check
          </button>

          {/* Conditional Actions */}
          <AnimatePresence>
            {lastScan && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-4 pt-4 border-t border-zinc-800 space-y-4"
              >
                {lastScan.status === 'mismatch' && (
                  <div className="bg-red-500/10 border border-red-500/30 p-4 rounded-2xl text-red-400 space-y-3">
                    <div className="flex items-center gap-2 font-bold text-xs uppercase tracking-wider">
                      <AlertCircle className="w-4 h-4" /> 
                      Assignment Conflict
                    </div>
                    <p className="text-[11px] opacity-80 font-mono">
                      Sheet says <span className="text-white">#{lastScan.expectedId}</span>. Label says <span className="text-white">#{lastScan.enteredId}</span>.
                    </p>
                    <button 
                      onClick={() => saveDeviceState(lastScan.sn, lastScan.enteredId || '', false)}
                      disabled={isUpdating || !lastScan.enteredId}
                      className="w-full bg-red-500 text-white rounded-xl py-2.5 text-[10px] font-bold uppercase transition-all hover:bg-red-600 active:scale-95 disabled:opacity-50"
                    >
                      {isUpdating ? 'SYNCING...' : 'REASSIGN DATABASE TO #' + lastScan.enteredId}
                    </button>
                  </div>
                )}

                {lastScan.status === 'not-found' && (
                  <div className="bg-orange-500/10 border border-orange-500/30 p-4 rounded-2xl text-orange-400 space-y-3">
                    <div className="flex items-center gap-2 font-bold text-xs uppercase tracking-wider">
                      <Search className="w-4 h-4" /> 
                      Asset Discovery
                    </div>
                    <p className="text-[11px] opacity-80 font-mono">
                      Serial <span className="text-white">{lastScan.sn}</span> is not registered in central database.
                    </p>
                    <button 
                      onClick={() => saveDeviceState(lastScan.sn, lastScan.enteredId || 'NEW', false)}
                      disabled={isUpdating}
                      className="w-full bg-orange-500 text-white rounded-xl py-2.5 text-[10px] font-bold uppercase transition-all hover:bg-orange-600 active:scale-95 disabled:opacity-50"
                    >
                      {isUpdating ? 'COMMITTING...' : 'REGISTER AS #' + (lastScan.enteredId || 'NEW')}
                    </button>
                  </div>
                )}

                {/* RMA Management for any found device */}
                {(lastScan.status === 'matched' || lastScan.status === 'mismatch') && (
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-[10px] uppercase font-bold text-zinc-500 tracking-widest font-mono">Inventory Cycle</span>
                    <div className="flex gap-2">
                       <button 
                         onClick={() => saveDeviceState(lastScan.sn, lastScan.expectedId || lastScan.enteredId || '', true)}
                         disabled={isUpdating}
                         className="px-4 py-2 bg-zinc-800 text-white border border-zinc-700 rounded-xl text-[9px] font-bold uppercase hover:bg-zinc-700 transition-all"
                       >
                         INITIATE RMA
                       </button>
                       <button 
                         onClick={() => saveDeviceState(lastScan.sn, lastScan.expectedId || lastScan.enteredId || '', false)}
                         disabled={isUpdating}
                         className="px-4 py-2 bg-green-500/10 text-green-500 border border-green-500/20 rounded-xl text-[9px] font-bold uppercase hover:bg-green-500/20 transition-all"
                       >
                         HEALTHY / CLEAR
                       </button>
                    </div>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Status Indicator - Compact */}
        <div className="col-span-12 md:col-span-4 lg:col-span-3 row-span-2 bg-zinc-900/40 border border-zinc-800 rounded-3xl p-6 flex flex-col items-center justify-center gap-3 text-center shadow-xl">
          <div className={`w-14 h-14 rounded-full border-[6px] flex items-center justify-center transition-colors ${
            !lastScan ? 'border-zinc-800' : 
            lastScan.status === 'matched' ? 'border-green-500/30 shadow-[0_0_20px_rgba(34,197,94,0.2)]' : 
            lastScan.status === 'not-found' ? 'border-orange-500/30' : 'border-red-500/30 shadow-[0_0_20px_rgba(239,68,68,0.2)]'
          }`}>
             {(!lastScan) && <div className="w-3 h-3 rounded-full bg-zinc-700" />}
             {lastScan?.status === 'matched' && <CheckCircle2 className="w-6 h-6 text-green-500" />}
             {lastScan?.status === 'mismatch' && <XCircle className="w-6 h-6 text-red-500" />}
             {lastScan?.status === 'not-found' && <AlertCircle className="w-6 h-6 text-orange-500" />}
          </div>
          <div className="space-y-1">
            <span className="text-[10px] font-bold uppercase text-zinc-500 tracking-widest block">System Status</span>
            <span className={`text-xl font-mono block ${
              !lastScan ? 'text-zinc-600' : 
              lastScan.status === 'matched' ? 'text-green-500' : 
              lastScan.status === 'not-found' ? 'text-orange-500' : 'text-red-500'
            }`}>
              {lastScan ? lastScan.status.toUpperCase().replace('-', ' ') : 'STDBY'}
            </span>
          </div>
        </div>

        {/* Available Counts - Compact */}
        <div className="col-span-12 md:col-span-8 lg:col-span-4 row-span-2 bg-zinc-900/40 border border-zinc-800 rounded-3xl p-6 flex flex-col shadow-xl">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-4">Availability Loop</h2>
          <div className="flex-grow flex items-end justify-between">
            <div>
              <span className="text-5xl font-light text-white leading-none">{availableCloverIds.length}</span>
              <span className="text-[10px] text-zinc-500 block uppercase tracking-wider mt-1 font-mono">Unassigned Units</span>
            </div>
            <div className="flex flex-col items-end gap-2">
               {availableCloverIds.slice(0, 3).map((id, idx) => (
                 <span key={idx} className="text-[10px] bg-indigo-500/10 text-indigo-400 px-2.5 py-1 rounded-lg border border-indigo-500/20 font-mono">
                   {idx === 0 ? 'NEXT: ' : ''}#{id}
                 </span>
               ))}
               {availableCloverIds.length > 3 && <span className="text-[9px] text-zinc-600 font-mono">+{availableCloverIds.length - 3} MORE</span>}
            </div>
          </div>
        </div>

        {/* Sheet Table Module */}
        <div className="col-span-12 row-span-2 bg-zinc-900/60 border border-zinc-800 rounded-3xl overflow-hidden flex flex-col shadow-xl">
          <div className="bg-zinc-800/40 px-4 py-2.5 border-b border-zinc-800 flex justify-between items-center">
            <h3 className="text-[10px] font-bold uppercase text-zinc-400 tracking-widest font-mono">Sheet Mirror: CLOVER_TRACKING_DB</h3>
            <div className="flex items-center gap-1.5 px-2 py-0.5 bg-green-500/10 border border-green-500/20 rounded-full">
              <div className="w-1.5 h-1.5 bg-green-500 rounded-full"></div>
              <span className="text-[9px] text-green-400 font-mono uppercase">LIVE</span>
            </div>
          </div>
          <div className="flex-grow font-mono text-[11px] overflow-auto no-scrollbar">
            <table className="w-full text-left border-collapse">
              <thead className="text-zinc-500 border-b border-zinc-800 sticky top-0 bg-zinc-900 z-10">
                <tr className="bg-zinc-900/80">
                  <th className="p-3 font-normal uppercase tracking-tighter">S/N REFERENCE</th>
                  <th className="p-3 font-normal uppercase tracking-tighter">OFFICIAL #</th>
                  <th className="p-3 font-normal uppercase tracking-tighter">STATE</th>
                  <th className="p-3 font-normal uppercase tracking-tighter">TIMESTAMP</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {scanHistory.length > 0 ? (
                  scanHistory.map((scan, idx) => (
                    <tr key={idx} className={`border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors ${scan.status === 'mismatch' ? 'bg-red-500/5' : ''}`}>
                      <td className="p-3 text-white font-bold">{scan.sn}</td>
                      <td className="p-3">{scan.expectedId || '---'}</td>
                      <td className="p-3">
                        <span className={`uppercase text-[10px] font-bold ${scan.status === 'matched' ? 'text-green-500' : 'text-red-500'}`}>
                          {scan.status}
                        </span>
                      </td>
                      <td className="p-3 text-zinc-500">{scan.timestamp}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="p-8 text-center text-zinc-600 italic">No entry in current session history</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Footer Bar */}
      <footer className="flex justify-between items-center text-[9px] text-zinc-600 uppercase font-mono tracking-widest">
        <div className="flex gap-4">
          <span className="flex items-center gap-1">
            <div className="w-1.5 h-1.5 bg-indigo-500 rounded-full"></div>
            SYNC_ENGINE: V3.4
          </span>
          <span>RECORDS: {devices.length}</span>
        </div>
        <div className="flex gap-4 items-center">
          <span className="text-indigo-400">GEMINI_VISION PROXY ACTIVE</span>
          <span className="opacity-30">© 2024 CLOVEROPS</span>
        </div>
      </footer>

      {/* Grid background effect */}
      <div className="fixed inset-0 pointer-events-none opacity-[0.01] z-[-1]">
        <div className="absolute inset-0" style={{ 
          backgroundImage: `linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)`,
          backgroundSize: '40px 40px'
        }} />
      </div>

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}

