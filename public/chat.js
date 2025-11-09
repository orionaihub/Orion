<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="theme-color" content="#10a37f">
    <title>Suna-Lite - AI Assistant</title>
    
    <!-- Tailwind CSS CDN -->
    <script src="https://cdn.tailwindcss.com"></script>
    
    <!-- Google Fonts: Inter -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    
    <!-- Markdown & Code Highlighting -->
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
    
    <link rel="stylesheet" href="styles.css">
</head>
<body class="text-gray-200">

    <div class="flex h-screen">
        <!-- Sidebar -->
        <aside id="sidebar" class="bg-black/90 w-72 p-3 flex flex-col fixed inset-y-0 left-0 transform -translate-x-full md:relative md:translate-x-0 transition-transform duration-300 ease-in-out z-30 backdrop-blur-sm border-r border-white/10">
            <!-- Header -->
            <div class="flex items-center justify-between mb-6">
                <div class="flex items-center gap-2">
                    <div class="bg-gradient-to-br from-teal-500 to-blue-600 p-1.5 rounded-lg">
                        <svg class="w-6 h-6" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                        </svg>
                    </div>
                    <span class="font-semibold text-lg">Suna-Lite</span>
                </div>
                <button onclick="clearChat()" class="p-2 rounded-lg hover:bg-white/10" title="New Chat">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125" />
                    </svg>
                </button>
            </div>

            <!-- Capabilities -->
            <div>
                <h3 class="px-3 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Capabilities</h3>
                <div class="grid grid-cols-2 gap-2 mb-4">
                    <div class="flex flex-col items-center justify-center p-3 rounded-lg bg-white/5 hover:bg-white/10 transition-colors cursor-pointer">
                        <span class="text-2xl mb-1">🔍</span>
                        <span class="text-xs text-gray-400">Search</span>
                    </div>
                    <div class="flex flex-col items-center justify-center p-3 rounded-lg bg-white/5 hover:bg-white/10 transition-colors cursor-pointer">
                        <span class="text-2xl mb-1">💻</span>
                        <span class="text-xs text-gray-400">Code</span>
                    </div>
                    <div class="flex flex-col items-center justify-center p-3 rounded-lg bg-white/5 hover:bg-white/10 transition-colors cursor-pointer">
                        <span class="text-2xl mb-1">📄</span>
                        <span class="text-xs text-gray-400">Files</span>
                    </div>
                    <div class="flex flex-col items-center justify-center p-3 rounded-lg bg-white/5 hover:bg-white/10 transition-colors cursor-pointer">
                        <span class="text-2xl mb-1">👁️</span>
                        <span class="text-xs text-gray-400">Vision</span>
                    </div>
                </div>
            </div>

            <!-- Chat History -->
            <div class="flex-grow overflow-y-auto custom-scrollbar -mr-3 pr-3">
                <h3 class="px-3 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Recent</h3>
                <nav id="history-list" class="flex flex-col gap-1">
                    <!-- Dynamic history items will appear here -->
                </nav>
            </div>

            <!-- Connection Status -->
            <div class="border-t border-white/10 mt-auto pt-3">
                <div class="flex items-center gap-3 p-3 rounded-lg bg-white/5">
                    <div id="status-indicator" class="w-2 h-2 rounded-full bg-gray-500"></div>
                    <span id="status-text" class="text-xs text-gray-400">Connecting...</span>
                </div>
            </div>
        </aside>

        <!-- Main Content -->
        <main class="flex-1 flex flex-col relative bg-[#1C1C1C]">
            <!-- Mobile Header -->
            <header class="md:hidden flex items-center justify-between p-2 bg-black/80 backdrop-blur-sm border-b border-white/10 sticky top-0 z-10">
                <button id="menu-btn" class="p-2 rounded-lg hover:bg-white/10">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
                    </svg>
                </button>
                <h1 class="text-lg font-semibold">Suna-Lite</h1>
                <button onclick="clearChat()" class="p-2 rounded-lg hover:bg-white/10">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                    </svg>
                </button>
            </header>

            <!-- Chat Area -->
            <div id="chat-container" class="flex-1 overflow-y-auto custom-scrollbar">
                <div class="max-w-4xl mx-auto">
                    <!-- Welcome Message -->
                    <div id="welcome-message" class="text-center py-20 px-4">
                        <div class="inline-block bg-gradient-to-br from-teal-500 to-blue-600 rounded-full p-3 mb-6 shadow-lg">
                             <svg class="w-10 h-10 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                            </svg>
                        </div>
                        <h2 class="text-3xl md:text-4xl font-bold text-white mb-4">How can I help you today?</h2>
                        <p class="text-gray-400 mb-8">I can search the web, execute code, analyze files, and help with complex tasks</p>
                        
                        <!-- Suggestion Chips -->
                        <div class="flex flex-wrap gap-2 justify-center max-w-2xl mx-auto">
                            <button onclick="useSuggestion(this)" class="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-full text-sm transition-colors">
                                What's Bitcoin's price? 💰
                            </button>
                            <button onclick="useSuggestion(this)" class="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-full text-sm transition-colors">
                                Analyze this dataset 📊
                            </button>
                            <button onclick="useSuggestion(this)" class="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-full text-sm transition-colors">
                                Write Python code 💻
                            </button>
                            <button onclick="useSuggestion(this)" class="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-full text-sm transition-colors">
                                Latest AI news 🔍
                            </button>
                        </div>
                    </div>

                    <!-- Messages will be appended here -->
                    <div id="messages-wrapper"></div>

                    <!-- Typing Indicator -->
                    <div id="typing-indicator" class="hidden w-full">
                        <div class="max-w-4xl mx-auto p-4 md:p-6 flex items-start gap-5">
                            <div class="w-8 h-8 flex-shrink-0 rounded-full flex items-center justify-center bg-teal-600">
                                <svg class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                                </svg>
                            </div>
                            <div class="text-gray-200 pt-0.5">
                                <div class="flex items-center gap-2">
                                    <div class="flex gap-1">
                                        <span class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay: 0s"></span>
                                        <span class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay: 0.2s"></span>
                                        <span class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay: 0.4s"></span>
                                    </div>
                                    <span id="typing-text" class="text-sm text-gray-400">Thinking...</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Input Area -->
            <div class="w-full bg-gradient-to-t from-black/50 to-transparent pt-4">
                <div class="max-w-4xl mx-auto px-4">
                    <!-- File Preview -->
                    <div id="file-preview" class="mb-3 flex flex-wrap gap-2"></div>
                    
                    <div class="relative">
                        <!-- Tools Popup -->
                        <div id="tools-popup" class="tools-popup absolute bottom-full mb-3 w-full bg-[#2a2a2a] rounded-xl shadow-2xl p-2 opacity-0 transform scale-95 pointer-events-none">
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                                <button onclick="document.getElementById('file-input').click()" class="flex items-center gap-3 p-3 rounded-lg hover:bg-white/10 text-left transition-colors">
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6">
                                        <path stroke-linecap="round" stroke-linejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 0119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
                                    </svg>
                                    <div>
                                        <p class="font-semibold">Upload file</p>
                                        <p class="text-xs text-gray-400">Attach documents, images, data</p>
                                    </div>
                                </button>
                                <button class="flex items-center gap-3 p-3 rounded-lg hover:bg-white/10 text-left transition-colors">
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6">
                                        <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                                    </svg>
                                    <div>
                                        <p class="font-semibold">Web Search</p>
                                        <p class="text-xs text-gray-400">Search for current information</p>
                                    </div>
                                </button>
                                <button class="flex items-center gap-3 p-3 rounded-lg hover:bg-white/10 text-left transition-colors">
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6">
                                        <path stroke-linecap="round" stroke-linejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
                                    </svg>
                                    <div>
                                        <p class="font-semibold">Execute Code</p>
                                        <p class="text-xs text-gray-400">Run Python for calculations</p>
                                    </div>
                                </button>
                                <button class="flex items-center gap-3 p-3 rounded-lg hover:bg-white/10 text-left transition-colors">
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6">
                                        <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                                        <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                    </svg>
                                    <div>
                                        <p class="font-semibold">Vision Analysis</p>
                                        <p class="text-xs text-gray-400">Analyze images and charts</p>
                                    </div>
                                </button>
                            </div>
                        </div>

                        <form id="chat-form" class="flex items-end gap-2">
                            <input type="file" id="file-input" multiple accept="*/*" class="hidden">
                            
                            <button type="button" id="tools-btn" class="p-3 bg-[#2a2a2a] border border-white/10 rounded-xl shadow-lg hover:bg-white/10 transition-colors flex-shrink-0">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                                </svg>
                            </button>
                            
                            <div class="w-full flex relative">
                                <textarea id="chat-input" rows="1" class="w-full bg-[#2a2a2a] border border-white/10 rounded-xl shadow-lg py-3.5 pl-4 pr-14 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 custom-scrollbar" placeholder="Message Suna-Lite..."></textarea>
                                <button type="submit" id="send-button" class="absolute right-3 top-1/2 -translate-y-1/2 p-2 bg-teal-600 rounded-lg hover:bg-teal-700 disabled:bg-gray-700 disabled:cursor-not-allowed transition-colors">
                                    <svg class="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                                        <path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M12 5l7 7-7 7" />
                                    </svg>
                                </button>
                            </div>
                        </form>
                    </div>
                    <p class="text-xs text-center text-gray-600 pt-3 pb-3">Suna-Lite can make mistakes. Consider checking important information.</p>
                </div>
            </div>
        </main>
    </div>

    <!-- Overlay for mobile sidebar -->
    <div id="overlay" class="fixed inset-0 bg-black bg-opacity-60 z-20 hidden md:hidden"></div>

    <script src="chat.js"></script>
</body>
</html>
