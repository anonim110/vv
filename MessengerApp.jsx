import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, query, orderBy, onSnapshot, addDoc, serverTimestamp, doc, setDoc } from 'firebase/firestore';
import { Send, User, MessageSquare, Sparkles, Volume2, Loader2 } from 'lucide-react';

// === LLM API UTILITIES (Used for TTS) ===

// Вспомогательная функция для преобразования Base64 в ArrayBuffer
const base64ToArrayBuffer = (base64) => {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
};

// Вспомогательная функция для преобразования PCM (сырые аудиоданные от API) в WAV Blob
const pcmToWav = (pcm16, sampleRate) => {
    const buffer = new ArrayBuffer(44 + pcm16.length * 2);
    const view = new DataView(buffer);
    
    // RIFF identifier 'RIFF'
    view.setUint32(0, 0x52494646, false);
    // file length
    view.setUint32(4, 36 + pcm16.length * 2, true);
    // RIFF type 'WAVE'
    view.setUint32(8, 0x57415645, false);
    // format chunk identifier 'fmt '
    view.setUint32(12, 0x666d7420, false);
    // format chunk length
    view.setUint32(16, 16, true);
    // sample format (1 - PCM)
    view.setUint16(20, 1, true);
    // channel count
    view.setUint16(22, 1, true); 
    // sample rate
    view.setUint32(24, sampleRate, true);
    // byte rate (SampleRate * Channels * BitsPerSample / 8)
    view.setUint32(28, sampleRate * 1 * 2, true);
    // block align (Channels * BitsPerSample / 8)
    view.setUint16(32, 1 * 2, true);
    // bits per sample
    view.setUint16(34, 16, true);
    // data chunk identifier 'data'
    view.setUint32(36, 0x64615441, false);
    // data chunk length
    view.setUint32(40, pcm16.length * 2, true);

    // Write PCM data
    for (let i = 0; i < pcm16.length; i++) {
        view.setInt16(44 + i * 2, pcm16[i], true);
    }

    return new Blob([view], { type: 'audio/wav' });
};
// === END LLM API UTILITIES ===


// === FIREBASE & ENVIRONMENT SETUP ===

// 1. КОНФИГУРАЦИЯ ДЛЯ ВНЕШНЕГО РАЗВЕРТЫВАНИЯ (НАПРИМЕР, VERCEL)
// !!! ВАЖНО: ЭТИ ПАРАМЕТРЫ БЫЛИ ОБНОВЛЕНЫ ВАШИМИ ДАННЫМИ FIREBASE !!!
const VERCEL_FIREBASE_CONFIG = {
    apiKey: "AIzaSyAemRqS-QxuehmOvpKfZaUqEvY0vEANH_o",
    authDomain: "mesengergrok.firebaseapp.com",
    databaseURL: "https://mesengergrok-default-rtdb.firebaseio.com",
    projectId: "mesengergrok",
    storageBucket: "mesengergrok.firebasestorage.app",
    messagingSenderId: "610820074834",
    appId: "1:610820074834:web:49c2279bf53f9338f01e8b",
    measurementId: "G-B0NMTXH6HK"
};

// Переменные из текущей среды Canvas (будут undefined на Vercel)
const canvasFirebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null;
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
const canvasAppId = typeof __app_id !== 'undefined' ? __app_id : 'messenger-app-v1';
const apiKey = ""; // API Key for Gemini is handled by the environment

// Utility function to deterministically generate a chat ID from two user IDs
const getChatId = (u1, u2) => [u1, u2].sort().join('___');

// Main App Component
const App = () => {
    // Firebase States
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [loadingMessage, setLoadingMessage] = useState('Подключение к сервисам...');

    // Messenger States
    const [currentChatId, setCurrentChatId] = useState(null);
    const [recipientId, setRecipientId] = useState('');
    const [messages, setMessages] = useState([]);
    const [newMessageText, setNewMessageText] = useState('');
    const [contacts, setContacts] = useState([]); // List of user IDs you have chatted with
    const messagesEndRef = useRef(null);
    const [chatError, setChatError] = useState(null);

    // LLM States
    const [isDrafting, setIsDrafting] = useState(false); // Для кнопки AI Draft
    const [ttsStatus, setTtsStatus] = useState({ id: null, loading: false }); // Для TTS

    // --- 1. INITIALIZATION AND AUTHENTICATION ---
    useEffect(() => {
        const configToUse = canvasFirebaseConfig || VERCEL_FIREBASE_CONFIG;
        const finalAppId = canvasAppId;

        if (!configToUse.apiKey || configToUse.apiKey.includes('ВАШ_')) {
            setLoadingMessage('Ошибка: Необходима конфигурация Firebase. Заполните VERCEL_FIREBASE_CONFIG.');
            return;
        }

        const app = initializeApp(configToUse);
        const firestore = getFirestore(app);
        const firebaseAuth = getAuth(app);
        setDb(firestore);
        setAuth(firebaseAuth);

        const unsubscribeAuth = onAuthStateChanged(firebaseAuth, async (user) => {
            if (user) {
                setUserId(user.uid);
                setIsAuthReady(true);
                setLoadingMessage('Авторизация успешна. Загрузка чатов...');
                
                const userDocRef = doc(firestore, `artifacts/${finalAppId}/public/data/users`, user.uid);
                try {
                     await setDoc(userDocRef, { 
                        lastActive: serverTimestamp(),
                        displayName: `Пользователь ${user.uid.substring(0, 6)}`
                    }, { merge: true });
                } catch (error) {
                    console.error("Firestore Write Error (Check Security Rules):", error);
                    setLoadingMessage('Ошибка. Не удалось записать данные пользователя. Проверьте Правила безопасности.');
                }
               
            } else {
                try {
                    if (initialAuthToken) {
                        await signInWithCustomToken(firebaseAuth, initialAuthToken);
                    } else {
                        await signInAnonymously(firebaseAuth);
                    }
                } catch (error) {
                    console.error("Firebase Auth Error:", error);
                    setLoadingMessage('Ошибка авторизации. Проверьте консоль.');
                }
            }
        });

        return () => unsubscribeAuth();
    }, [canvasFirebaseConfig, initialAuthToken]);

    // --- 2. CONTACTS / THREADS LISTENER (Simplified) ---
    useEffect(() => {
        if (userId && recipientId && !contacts.includes(recipientId)) {
            setContacts(prev => [...new Set([...prev, recipientId])]);
        }
    }, [userId, recipientId, contacts]);

    // --- 3. MESSAGES REAL-TIME LISTENER ---
    useEffect(() => {
        const finalAppId = canvasAppId;
        
        if (!isAuthReady || !db || !currentChatId) return;

        setMessages([]);
        setLoadingMessage('Загрузка сообщений...');

        const chatPath = `artifacts/${finalAppId}/public/data/threads/${currentChatId}/messages`;
        const messagesRef = collection(db, chatPath);
        
        const messagesQuery = query(messagesRef, orderBy('timestamp', 'asc'));

        const unsubscribeMessages = onSnapshot(messagesQuery, (snapshot) => {
            const newMessages = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
            }));
            setMessages(newMessages);
            setLoadingMessage(null);
        }, (error) => {
            console.error("Firestore Snapshot Error:", error);
            setLoadingMessage('Ошибка загрузки сообщений. Проверьте правила безопасности.');
        });

        return () => unsubscribeMessages();
    }, [isAuthReady, db, currentChatId]);

    // --- 4. SCROLL TO BOTTOM ---
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // --- 5. HANDLERS ---
    const handleSelectChat = (friendId) => {
        if (friendId === userId) return;
        setRecipientId(friendId);
        setCurrentChatId(getChatId(userId, friendId));
        setChatError(null);
    };

    const handleStartNewChat = () => {
        if (!recipientId || recipientId.trim() === userId) {
            const errorMessage = recipientId.trim() === userId 
                ? 'Вы не можете начать чат с самим собой.' 
                : 'Пожалуйста, введите корректный ID друга.';
                
            setChatError(errorMessage);
            setTimeout(() => setChatError(null), 3000); 
            return;
        }
        handleSelectChat(recipientId.trim());
    };

    const handleSendMessage = async (e) => {
        const finalAppId = canvasAppId;
        e.preventDefault();
        const text = newMessageText.trim();
        
        if (!text || !currentChatId || !db) {
             if (!currentChatId) {
                setChatError('Пожалуйста, сначала выберите или начните чат с другом.');
                setTimeout(() => setChatError(null), 3000); 
             }
             return;
        }

        const chatPath = `artifacts/${finalAppId}/public/data/threads/${currentChatId}/messages`;

        try {
            await addDoc(collection(db, chatPath), {
                senderId: userId,
                text: text,
                timestamp: serverTimestamp(),
            });
            setNewMessageText('');
        } catch (error) {
            console.error("Error sending message:", error);
            setChatError('Ошибка отправки сообщения. Проверьте правила на создание (create).');
            setTimeout(() => setChatError(null), 3000); 
        }
    };
    
    // --- 6. GEMINI API HANDLERS ---

    // 6.1. AI DRAFTING FEATURE
    const handleAIDrafting = async (mode = 'expand') => {
        if (!newMessageText.trim() || isDrafting) return;

        setIsDrafting(true);
        setChatError(null);
        
        let systemPrompt = "Выступай в роли помощника по переписыванию текста. Ты должен перефразировать или расширить предоставленный текст, делая его более выразительным или длинным. Отвечай только переписанным текстом, без лишних комментариев.";
        
        if (mode === 'professional') {
             systemPrompt = "Выступай в роли помощника по переписыванию текста. Ты должен перефразировать предоставленный текст, делая его более вежливым и профессиональным. Отвечай только переписанным текстом, без лишних комментариев.";
        }

        const userQuery = `Текст для ${mode === 'professional' ? 'профессионального перефразирования' : 'расширения'}: "${newMessageText.trim()}"`;
        
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

        const payload = {
            contents: [{ parts: [{ text: userQuery }] }],
            systemInstruction: {
                parts: [{ text: systemPrompt }]
            },
        };

        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            
            const result = await response.json();
            const text = result.candidates?.[0]?.content?.parts?.[0]?.text;

            if (text) {
                setNewMessageText(text.trim());
            } else {
                setChatError('Ошибка Gemini: Не удалось сгенерировать черновик.');
                setTimeout(() => setChatError(null), 3000);
            }

        } catch (error) {
            console.error("Gemini API Error (Drafting):", error);
            setChatError('Ошибка API Gemini: Проблема с соединением.');
            setTimeout(() => setChatError(null), 3000);
        } finally {
            setIsDrafting(false);
        }
    };
    
    // 6.2. TEXT-TO-SPEECH (TTS) FEATURE
    const handleTTS = async (messageId, text) => {
        if (ttsStatus.loading || ttsStatus.id === messageId) return;

        setTtsStatus({ id: messageId, loading: true });
        
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`;
        
        const payload = {
            contents: [{
                parts: [{ text: `Скажи в дружелюбной манере: ${text}` }]
            }],
            generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: "Puck" } // Выбираем веселый голос
                    }
                }
            },
            model: "gemini-2.5-flash-preview-tts"
        };
        
        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const result = await response.json();
            const part = result?.candidates?.[0]?.content?.parts?.[0];
            const audioData = part?.inlineData?.data;
            const mimeType = part?.inlineData?.mimeType;

            if (audioData && mimeType && mimeType.startsWith("audio/L16")) {
                const sampleRateMatch = mimeType.match(/rate=(\d+)/);
                const sampleRate = sampleRateMatch ? parseInt(sampleRateMatch[1], 10) : 16000;
                
                const pcmData = base64ToArrayBuffer(audioData);
                // API возвращает подписанные 16-битные PCM данные
                const pcm16 = new Int16Array(pcmData); 
                const wavBlob = pcmToWav(pcm16, sampleRate);
                const audioUrl = URL.createObjectURL(wavBlob);
                
                const audio = new Audio(audioUrl);
                audio.play();

                audio.onended = () => {
                    setTtsStatus({ id: null, loading: false });
                    URL.revokeObjectURL(audioUrl);
                };
                
            } else {
                setChatError('TTS Error: Не удалось получить аудиоданные.');
                setTimeout(() => setChatError(null), 3000);
            }
        } catch (error) {
            console.error("Gemini API Error (TTS):", error);
            setChatError('Ошибка API Gemini: Проблема с генерацией речи.');
            setTimeout(() => setChatError(null), 3000);
        } finally {
            if (ttsStatus.id === messageId) {
                 setTtsStatus({ id: null, loading: false }); // Сбросить, если проигрывание не началось
            }
        }
    };


    // --- 7. RENDER COMPONENTS ---

    // Loading/Error Screen
    if (!isAuthReady || !userId) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-gray-900 text-white p-4">
                <div className="text-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500 mx-auto"></div>
                    <p className="mt-4 text-lg">{loadingMessage}</p>
                </div>
            </div>
        );
    }

    const currentRecipient = contacts.find(c => getChatId(userId, c) === currentChatId);

    const ChatSidebar = () => (
        <div className="w-full md:w-1/3 lg:w-1/4 bg-gray-800 border-r border-gray-700 flex flex-col">
            <div className="p-4 border-b border-gray-700">
                <h2 className="text-xl font-bold text-white mb-1 flex items-center">
                    <MessageSquare className="mr-2 h-5 w-5 text-blue-400" />
                    Мессенджер
                </h2>
                <div className="text-sm text-gray-400 truncate">Ваш ID: <span className="font-mono text-blue-300 select-all">{userId}</span></div>
            </div>

            {/* New Chat Input */}
            <div className="p-4 bg-gray-900">
                {/* Визуальное отображение ошибки чата */}
                {chatError && (
                    <div className="p-2 mb-2 text-sm font-medium text-red-100 bg-red-600 rounded-lg transition duration-300 animate-pulse">
                        {chatError}
                    </div>
                )}
                <input
                    type="text"
                    placeholder="ID друга для чата..."
                    value={recipientId}
                    onChange={(e) => setRecipientId(e.target.value)}
                    className="w-full p-2 mb-2 bg-gray-700 text-white rounded-lg focus:ring-blue-500 focus:border-blue-500 placeholder-gray-400"
                />
                <button
                    onClick={handleStartNewChat}
                    className="w-full p-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg shadow-md transition duration-150"
                >
                    <div className='flex items-center justify-center'>
                      <User className="mr-2 h-4 w-4" /> Начать Чат
                    </div>
                </button>
            </div>

            {/* Contacts List */}
            <div className="flex-grow overflow-y-auto">
                <div className="p-4 text-gray-400 font-semibold uppercase text-xs tracking-wider">
                    Активные чаты
                </div>
                {contacts.filter(c => c !== userId).map((contact) => (
                    <div
                        key={contact}
                        onClick={() => handleSelectChat(contact)}
                        className={`p-3 mx-2 rounded-xl cursor-pointer transition duration-150 ${currentChatId === getChatId(userId, contact) 
                            ? 'bg-blue-600 shadow-lg text-white font-semibold' 
                            : 'hover:bg-gray-700 text-gray-300'
                        }`}
                    >
                        <div className="font-medium truncate">
                            {/* Display friend's ID */}
                            <span className="text-sm">Чат с: {contact.substring(0, 8)}...</span>
                        </div>
                        {currentChatId === getChatId(userId, contact) && (
                            <div className="text-xs opacity-80">Активен</div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );

    const ChatWindow = () => (
        <div className="flex-grow flex flex-col bg-gray-900">
            {/* Header */}
            <div className="p-4 border-b border-gray-700 bg-gray-800 shadow-md">
                <h3 className="text-xl font-semibold text-white">
                    {currentChatId ? `Чат с: ${currentRecipient?.substring(0, 10)}...` : 'Выберите чат'}
                </h3>
            </div>

            {/* Messages Area */}
            <div className="flex-grow overflow-y-auto p-4 space-y-4">
                {!currentChatId ? (
                    <div className="flex items-center justify-center h-full text-gray-500 text-lg">
                        <p>Выберите друга в меню слева или введите его ID, чтобы начать переписку.</p>
                    </div>
                ) : loadingMessage ? (
                    <div className="text-center text-gray-500 mt-10">{loadingMessage}</div>
                ) : (
                    messages.map((msg) => {
                        const isMyMessage = msg.senderId === userId;
                        const time = msg.timestamp?.toDate ? msg.timestamp.toDate().toLocaleTimeString('ru-RU', {hour: '2-digit', minute:'2-digit'}) : '...';
                        
                        // Check if the current message is playing or loading TTS
                        const isTtsPlaying = ttsStatus.id === msg.id;
                        const isTtsLoading = ttsStatus.loading && ttsStatus.id === msg.id;

                        return (
                            <div key={msg.id} className={`flex ${isMyMessage ? 'justify-end' : 'justify-start'}`}>
                                <div className={`max-w-xs sm:max-w-md p-3 rounded-2xl shadow-lg relative flex items-start ${isMyMessage 
                                    ? 'bg-blue-600 text-white rounded-br-none' 
                                    : 'bg-gray-700 text-white rounded-tl-none'
                                }`}>
                                    
                                    {/* TTS Button (Only for received messages) */}
                                    {!isMyMessage && (
                                        <button 
                                            onClick={() => handleTTS(msg.id, msg.text)}
                                            disabled={ttsStatus.loading && !isTtsLoading}
                                            className={`flex-shrink-0 p-1 mr-2 rounded-full transition duration-150 ${isTtsLoading 
                                                ? 'text-yellow-400 animate-spin' 
                                                : isTtsPlaying ? 'text-green-400' : 'text-gray-400 hover:text-white'
                                            }`}
                                        >
                                            {isTtsLoading ? <Loader2 className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                                        </button>
                                    )}

                                    {/* Message Content */}
                                    <div>
                                        <p className="text-sm break-words">{msg.text}</p>
                                        <div className={`text-xs mt-1 ${isMyMessage ? 'text-blue-200' : 'text-gray-400'} text-right`}>
                                            {time}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })
                )}
                <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            {currentChatId && (
                <div className="p-4 border-t border-gray-700 bg-gray-800">
                    <form onSubmit={handleSendMessage} className="flex space-x-3">
                        {/* AI Draft Button Group */}
                        {newMessageText.trim() && (
                             <div className="flex flex-col space-y-1">
                                <button
                                    type="button"
                                    onClick={() => handleAIDrafting('expand')}
                                    disabled={isDrafting}
                                    className={`bg-indigo-500 hover:bg-indigo-600 p-2 rounded-full text-white font-semibold shadow-xl transition duration-150 text-xs flex items-center justify-center disabled:bg-indigo-700 w-full min-w-[100px]`}
                                >
                                    {isDrafting ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Sparkles className="h-4 w-4 mr-1" /> AI Расширить</>}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => handleAIDrafting('professional')}
                                    disabled={isDrafting}
                                    className={`bg-indigo-500 hover:bg-indigo-600 p-2 rounded-full text-white font-semibold shadow-xl transition duration-150 text-xs flex items-center justify-center disabled:bg-indigo-700 w-full min-w-[100px]`}
                                >
                                    {isDrafting ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Sparkles className="h-4 w-4 mr-1" /> AI Профи</>}
                                </button>
                            </div>
                        )}
                        
                        <input
                            type="text"
                            value={newMessageText}
                            onChange={(e) => setNewMessageText(e.target.value)}
                            placeholder="Введите сообщение..."
                            className="flex-grow p-3 bg-gray-700 text-white rounded-full focus:ring-blue-500 focus:border-blue-500 placeholder-gray-400 border-none outline-none transition duration-150"
                            disabled={!currentChatId || isDrafting}
                        />
                        <button
                            type="submit"
                            disabled={!currentChatId || !newMessageText.trim() || isDrafting}
                            className="bg-blue-600 hover:bg-blue-700 p-3 rounded-full text-white font-semibold shadow-xl transition duration-150 disabled:bg-gray-600 disabled:cursor-not-allowed"
                        >
                            <Send className="h-5 w-5" />
                        </button>
                    </form>
                </div>
            )}
        </div>
    );


    return (
        <div className="flex h-screen bg-gray-900 text-white font-sans">
            <style>{`
                /* Стилизация полосы прокрутки для Webkit */
                ::-webkit-scrollbar {
                    width: 8px;
                }
                ::-webkit-scrollbar-thumb {
                    background: #3B82F6; /* Синий цвет Tailwind-blue-500 */
                    border-radius: 10px;
                }
                ::-webkit-scrollbar-track {
                    background: #1F2937; /* Темный цвет Tailwind-gray-800 */
                }
            `}</style>
            
            {/* Sidebar (Contacts) */}
            <ChatSidebar />

            {/* Main Chat Window */}
            <ChatWindow />
        </div>
    );
};

export default App;
