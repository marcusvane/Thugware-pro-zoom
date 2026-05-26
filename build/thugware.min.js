// ==UserScript==
// @name Thugware - Zoom Tools
// @namespace http://tampermonkey.net/
// @version 2.0
// @description Zoom meeting utility tools
// @author marcus vane
// @homepage https://github.com/marcusvane/Thugware-pro-zoom
// @supportURL https://github.com/marcusvane/Thugware-pro-zoom
// @match ://app.zoom.us/
// @match ://zoom.us/
// @grant none
// ==/UserScript==

(function() {
'use strict';

// Prevent multiple instances
if (window.ThugwareLoaded) return;
window.ThugwareLoaded = true;

// ==================== CONFIGURATION ====================
const CONFIG = {
    defaultSpeed: 1000,
    maxBots: 10,
    safeMode: true  // Prevents browser crashes
};

// ==================== STATE ====================
const state = {
    bots: [],
    intervals: {},
    toggles: {},
    spammerSpeed: CONFIG.defaultSpeed,
    meetingURL: location.href
};

// ==================== UTILITY FUNCTIONS ====================

const Utils = {
    // Safe interval setter (prevents infinite loops)
    setInterval(name, callback, delay) {
        if (state.intervals[name]) {
            clearInterval(state.intervals[name]);
        }
        state.intervals[name] = setInterval(callback, Math.max(delay, 100));
    },

    clearInterval(name) {
        if (state.intervals[name]) {
            clearInterval(state.intervals[name]);
            delete state.intervals[name];
        }
    },

    // Safe prompt with validation
    promptNumber(message, defaultVal = 1, max = CONFIG.maxBots) {
        const input = prompt(message, defaultVal);
        const num = parseInt(input, 10);
        return isNaN(num) ? defaultVal : Math.min(Math.max(num, 1), max);
    },

    promptString(message, defaultVal = '') {
        const input = prompt(message, defaultVal);
        return input || defaultVal;
    }
};

// ==================== MODULE LOADER ====================

class ZoomModule {
    constructor(win = window) {
        this.scope = win;
        this.hooks = this.initHooks();
        this.actions = this.initActions();
        this.loaded = false;
    }

    initHooks() {
        const scope = this.scope;
        
        return {
            // Get webpack require
            get wpRequire() {
                const chunk = scope.webpackChunkwebclient;
                if (!chunk) return null;
                
                // Find existing or create new
                let req = chunk.find?.(n => n[2])?.[2];
                if (!req) {
                    const sym = Symbol();
                    chunk.push([[sym], {}, n => { req = n; }]);
                }
                return req;
            },

            // Get Redux store
            get store() {
                const root = scope.document?.getElementById("root");
                if (!root) return null;
                const vals = Object.values(root);
                return vals[0]?.memoizedState?.element?.props?.store;
            },

            // Get current state
            get state() {
                return this.store?.getState();
            },

            // Find module by string content
            findModule(str) {
                const req = this.wpRequire;
                if (!req || !req.m) return null;
                
                const keys = Object.keys(req.m);
                const idx = Object.values(req.m).findIndex(m => 
                    m.toString().includes(str)
                );
                return idx >= 0 ? req(keys[idx]) : null;
            },

            // Find specific function in module
            findModuleFn(str) {
                const mod = this.findModule(str);
                if (!mod) return null;
                return Object.values(mod).find(f => 
                    typeof f === 'function' && f.toString().includes(str)
                );
            },

            // Get packet definitions
            get packets() {
                return this.findModule("WS_CONF_RENAME_REQ");
            },

            // Get action packets
            get actionPackets() {
                return this.findModule("USER_NODE_AUDIO_STATUS_LIST");
            },

            // Send WebSocket message
            get sendSocketMessage() {
                return this.findModuleFn(".WS_AUDIO_DIALOUT_REQ:");
            },

            // Dispatch action to store
            dispatchSocketMessage(data) {
                if (this.store && this.sendSocketMessage) {
                    this.store.dispatch(this.sendSocketMessage(data));
                }
            },

            // Send chat message
            get sendChatMessage() {
                return this.findModuleFn("mention,localXmppMsgId");
            }
        };
    }

    initActions() {
        const hooks = this.hooks;
        const self = this;
        
        return {
            // Change display name
            changeUsername(name) {
                const user = hooks.state?.meeting?.currentUser;
                if (!user) return;
                
                hooks.dispatchSocketMessage({
                    evt: hooks.packets?.WS_CONF_RENAME_REQ,
                    body: {
                        id: user.userId,
                        dn2: btoa(name),
                        olddn2: btoa(user.displayName)
                    }
                });
            },

            // Toggle microphone
            toggleMute(forceState) {
                const user = hooks.state?.meeting?.currentUser;
                if (!user) return;
                
                const newState = forceState !== undefined ? forceState : !user.muted;
                
                hooks.dispatchSocketMessage({
                    evt: hooks.actionPackets?.USER_NODE_AUDIO_STATUS_LIST,
                    body: {
                        add: null,
                        remove: null,
                        update: [{
                            id: user.userId,
                            muted: newState
                        }]
                    }
                });
                
                hooks.dispatchSocketMessage({
                    evt: hooks.packets?.WS_AUDIO_MUTE_REQ,
                    body: {
                        id: user.userId,
                        bMute: newState
                    }
                });
            },

            // Toggle hand raise
            toggleHand(forceState) {
                const user = hooks.state?.meeting?.currentUser;
                if (!user) return;
                
                const newState = forceState !== undefined ? forceState : !user.bRaiseHand;
                
                hooks.dispatchSocketMessage({
                    evt: hooks.packets?.WS_CONF_RAISE_LOWER_HAND_REQ,
                    body: {
                        id: user.userId,
                        bOn: newState
                    }
                });
            },

            // Toggle video
            toggleVideo(forceState) {
                const user = hooks.state?.meeting?.currentUser;
                if (!user) return;
                
                const newState = forceState !== undefined ? forceState : !user.bVideoOn;
                
                if (newState) {
                    // Start video
                    const startFn = hooks.findModuleFn("user start capture video");
                    if (startFn) startFn()(hooks.store.dispatch, hooks.store.getState);
                } else {
                    // Stop video
                    hooks.dispatchSocketMessage({
                        evt: hooks.packets?.WS_VIDEO_MUTE_VIDEO_REQ,
                        body: {
                            id: user.userId,
                            bOn: false
                        }
                    });
                }
            },

            // Send reaction emoji
            sendReaction(emoji) {
                const user = hooks.state?.meeting?.currentUser;
                if (!user) return;
                
                hooks.dispatchSocketMessage({
                    evt: hooks.packets?.WS_CONF_SEND_REACTION_REQ,
                    body: {
                        uNodeID: user.userId,
                        strEmojiContent: emoji
                    }
                });
            },

            // Send chat message
            sendMessage(text, mention = [], style = [], recipient = 0) {
                const sendFn = hooks.sendChatMessage;
                if (sendFn) {
                    sendFn({ text, styleItems: style, mention }, recipient)(
                        hooks.store.dispatch,
                        hooks.store.getState
                    );
                }
            },

            // Request AI companion
            requestAI() {
                hooks.dispatchSocketMessage({
                    evt: hooks.packets?.WS_CONF_QUERY_OP_REQ,
                    body: { type: "reqAICStart" }
                });
            },

            // Request screenshare control
            requestScreenshare(userId) {
                hooks.dispatchSocketMessage({
                    evt: hooks.packets?.WS_SHARING_REMOTE_CONTROL_REQ,
                    body: { id: userId, bOn: true }
                });
            }
        };
    }
}

// ==================== BOT MANAGEMENT ====================

const BotManager = {
    createContainer() {
        const container = document.createElement('div');
        container.style.display = 'none';
        document.body.appendChild(container);
        return container;
    },

    createBot(container, visible = false) {
        const iframe = document.createElement('iframe');
        iframe.src = state.meetingURL;
        
        if (visible) {
            iframe.style.cssText = `
                width: 400px;
                height: 300px;
                border: 1px solid #333;
                margin: 5px;
                resize: both;
            `;
        } else {
            iframe.style.display = 'none';
        }
        
        container.appendChild(iframe);
        
        const bot = new ZoomModule(iframe.contentWindow);
        bot.iframe = iframe;
        
        // Set unique ID
        iframe.onload = () => {
            try {
                const wcMod = bot.hooks.findModule("webClient_meetingUqiueId:");
                if (wcMod) {
                    const wcObj = Object.values(wcMod).find(x => x?.webClient_meetingUqiueId);
                    if (wcObj) {
                        wcObj.webClient_meetingUqiueId = Math.random().toString(36).substring(2, 8);
                    }
                }
                bot.loaded = true;
            } catch (e) {
                console.error('Bot init error:', e);
            }
        };
        
        state.bots.push(bot);
        return bot;
    },

    clear() {
        state.bots.forEach(bot => {
            if (bot.iframe) bot.iframe.remove();
        });
        state.bots = [];
    }
};

// ==================== FEATURES ====================

const Features = {
    // Auto unmute and enable video
    autoMedia() {
        const key = 'autoMedia';
        if (state.intervals[key]) {
            Utils.clearInterval(key);
            return;
        }
        
        Utils.setInterval(key, () => {
            const main = window.Thugware;
            if (!main) return;
            
            const user = main.hooks.state?.meeting?.currentUser;
            if (!user) return;
            
            if (user.muted) main.actions.toggleMute(false);
            if (!user.bVideoOn) main.actions.toggleVideo(true);
            
            // Apply to bots
            state.bots.forEach(bot => {
                if (!bot.loaded) return;
                const botUser = bot.hooks.state?.meeting?.currentUser;
                if (botUser?.muted) bot.actions.toggleMute(false);
                if (!botUser?.bVideoOn) bot.actions.toggleVideo(true);
            });
        }, state.spammerSpeed);
    },

    // Chat spammer
    chatSpam() {
        const key = 'chatSpam';
        if (state.intervals[key]) {
            Utils.clearInterval(key);
            return;
        }
        
        const message = Utils.promptString("Message to spam?");
        const recipient = Utils.promptString("Recipient name? (blank for all)");
        
        Utils.setInterval(key, () => {
            const main = window.Thugware;
            if (!main) return;
            
            // Find recipient ID if specified
            let recipientId = 0;
            if (recipient) {
                const attendees = main.hooks.state?.attendeesList?.attendeesList;
                const found = Object.values(attendees || {}).find(a => 
                    a?.displayName === recipient
                );
                if (found) recipientId = found.userId;
            }
            
            main.actions.sendMessage(message, [], [], recipientId);
            
            state.bots.forEach(bot => {
                if (bot.loaded) bot.actions.sendMessage(message, [], [], recipientId);
            });
        }, state.spammerSpeed);
    },

    // Hand raise spam
    handSpam() {
        const key = 'handSpam';
        if (state.intervals[key]) {
            Utils.clearInterval(key);
            return false;
        }
        
        let raised = false;
        Utils.setInterval(key, () => {
            raised = !raised;
            const main = window.Thugware;
            if (!main) return;
            
            main.actions.toggleHand(raised);
            state.bots.forEach(bot => {
                if (bot.loaded) bot.actions.toggleHand(raised);
            });
        }, 1000 + state.spammerSpeed);
        
        return true;
    },

    // Name changer
    nameSpam() {
        const key = 'nameSpam';
        if (state.intervals[key]) {
            Utils.clearInterval(key);
            return;
        }
        
        const names = [
            "James", "Mary", "John", "Patricia", "Robert", "Jennifer",
            "Michael", "Linda", "William", "Elizabeth", "David", "Barbara"
        ];
        
        let index = 0;
        Utils.setInterval(key, () => {
            index = (index + 1) % names.length;
            const name = names[index];
            
            const main = window.Thugware;
            if (!main) return;
            
            main.actions.changeUsername(name);
            state.bots.forEach(bot => {
                if (bot.loaded) {
                    index = (index + 1) % names.length;
                    bot.actions.changeUsername(names[index]);
                }
            });
        }, state.spammerSpeed);
    },

    // Reaction spam
    reactionSpam() {
        const key = 'reactionSpam';
        if (state.intervals[key]) {
            Utils.clearInterval(key);
            return;
        }
        
        const reactions = ['👍', '❤️', '😂', '😮', '🎉', '👏', '🔥', '💯'];
        let index = 0;
        
        Utils.setInterval(key, () => {
            index = (index + 1) % reactions.length;
            const main = window.Thugware;
            if (!main) return;
            
            main.actions.sendReaction(reactions[index]);
            state.bots.forEach(bot => {
                if (bot.loaded) {
                    index = (index + 1) % reactions.length;
                    bot.actions.sendReaction(reactions[index]);
                }
            });
        }, state.spammerSpeed);
    },

    // Create visible bots
    botPanel() {
        const count = Utils.promptNumber("How many bots?", 1, 5);
        const container = BotManager.createContainer();
        
        // Open popup window
        const popup = window.open("", "BotPanel", "width=500,height=400");
        if (!popup) {
            alert("Popup blocked! Allow popups for this site.");
            return;
        }
        
        popup.document.title = "Bot Control Panel";
        popup.document.body.style.cssText = `
            background: #1a1a1a;
            margin: 0;
            padding: 10px;
        `;
        
        for (let i = 0; i < count; i++) {
            BotManager.createBot(popup.document.body, true);
        }
    },

    // Create hidden bots
    floodBots() {
        const count = Utils.promptNumber("How many hidden bots?", 1, CONFIG.maxBots);
        const container = BotManager.createContainer();
        
        for (let i = 0; i < count; i++) {
            BotManager.createBot(container, false);
        }
    },

    // Auto rejoin on kick
    autoRejoin() {
        const key = 'autoRejoin';
        if (state.intervals[key]) {
            Utils.clearInterval(key);
            return;
        }
        
        Utils.setInterval(key, () => {
            // Check for "Exit" or "Leave" buttons indicating kicked state
            const buttons = document.querySelectorAll('.zm-btn');
            const isKicked = Array.from(buttons).some(btn => {
                const text = btn.innerText?.trim();
                return text === "Exit" || text === "Leave";
            });
            
            if (isKicked) {
                // Clear storage and reload
                localStorage.clear();
                sessionStorage.clear();
                location.reload();
            }
        }, 500);
    },

    // Request AI spam
    aiSpam() {
        const key = 'aiSpam';
        if (state.intervals[key]) {
            Utils.clearInterval(key);
            return;
        }
        
        Utils.setInterval(key, () => {
            const main = window.Thugware;
            if (!main) return;
            
            main.actions.requestAI();
            state.bots.forEach(bot => {
                if (bot.loaded) bot.actions.requestAI();
            });
        }, state.spammerSpeed);
    },

    // Screenshare request spam
    screenshareSpam() {
        const key = 'screenshareSpam';
        if (state.intervals[key]) {
            Utils.clearInterval(key);
            return;
        }
        
        const main = window.Thugware;
        const sharer = main?.hooks?.state?.attendeesList?.attendeesList?.find?.(
            a => a?.sharerOn
        );
        
        if (!sharer) {
            alert("No one is screensharing!");
            return;
        }
        
        Utils.setInterval(key, () => {
            main.actions.requestScreenshare(sharer.userId);
            state.bots.forEach(bot => {
                if (bot.loaded) bot.actions.requestScreenshare(sharer.userId);
            });
        }, state.spammerSpeed);
    }
};

// ==================== UI ====================

class Panel {
    constructor(title) {
        this.panel = document.createElement('div');
        this.panel.className = 'thugware-panel';
        
        const style = document.createElement('style');
        style.textContent = `
            .thugware-panel {
                position: fixed;
                top: 100px;
                left: 100px;
                width: 280px;
                max-height: 80vh;
                background: rgba(20, 20, 25, 0.95);
                border: 1px solid #444;
                border-radius: 10px;
                color: white;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                z-index: 999999;
                overflow: hidden;
                box-shadow: 0 10px 40px rgba(0,0,0,0.5);
            }
            .thugware-header {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                padding: 15px;
                cursor: grab;
                user-select: none;
                font-weight: bold;
                font-size: 16px;
                text-align: center;
            }
            .thugware-header:active {
                cursor: grabbing;
            }
            .thugware-content {
                max-height: 60vh;
                overflow-y: auto;
                padding: 10px;
            }
            .thugware-btn {
                width: 100%;
                padding: 10px;
                margin: 5px 0;
                border: none;
                border-radius: 5px;
                background: rgba(255,255,255,0.1);
                color: white;
                cursor: pointer;
                transition: all 0.2s;
                font-size: 13px;
            }
            .thugware-btn:hover {
                background: rgba(255,255,255,0.2);
            }
            .thugware-btn.active {
                background: #48bb78;
            }
            .thugware-toggle {
                position: fixed;
                top: 50px;
                left: 0;
                padding: 10px;
                background: #667eea;
                color: white;
                border-radius: 0 5px 5px 0;
                cursor: pointer;
                z-index: 999999;
                font-size: 20px;
            }
        `;
        document.head.appendChild(style);
        
        // Header
        const header = document.createElement('div');
        header.className = 'thugware-header';
        header.textContent = title;
        this.panel.appendChild(header);
        
        // Content
        this.content = document.createElement('div');
        this.content.className = 'thugware-content';
        this.panel.appendChild(this.content);
        
        // Toggle button
        this.toggleBtn = document.createElement('div');
        this.toggleBtn.className = 'thugware-toggle';
        this.toggleBtn.textContent = '⚡';
        this.toggleBtn.onclick = () => this.toggle();
        
        document.body.appendChild(this.panel);
        document.body.appendChild(this.toggleBtn);
        
        this.makeDraggable(header);
    }

    makeDraggable(handle) {
        let isDragging = false;
        let offset = { x: 0, y: 0 };
        
        handle.addEventListener('mousedown', (e) => {
            isDragging = true;
            offset.x = e.clientX - this.panel.offsetLeft;
            offset.y = e.clientY - this.panel.offsetTop;
        });
        
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            this.panel.style.left = (e.clientX - offset.x) + 'px';
            this.panel.style.top = (e.clientY - offset.y) + 'px';
        });
        
        document.addEventListener('mouseup', () => {
            isDragging = false;
        });
    }

    toggle() {
        this.panel.style.display = 
            this.panel.style.display === 'none' ? 'block' : 'none';
    }

    addButton(text, callback) {
        const btn = document.createElement('button');
        btn.className = 'thugware-btn';
        btn.textContent = text;
        
        let isActive = false;
        btn.onclick = () => {
            isActive = !isActive;
            btn.classList.toggle('active', isActive);
            callback();
        };
        
        this.content.appendChild(btn);
        return btn;
    }

    addSlider(text, min, max, callback) {
        const container = document.createElement('div');
        container.style.cssText = 'margin: 10px 0;';
        
        const label = document.createElement('div');
        label.textContent = text;
        label.style.marginBottom = '5px';
        
        const input = document.createElement('input');
        input.type = 'range';
        input.min = min;
        input.max = max;
        input.value = state.spammerSpeed;
        input.style.width = '100%';
        
        const value = document.createElement('div');
        value.textContent = state.spammerSpeed + 'ms';
        value.style.textAlign = 'center';
        value.style.fontSize = '12px';
        value.style.color = '#aaa';
        
        input.oninput = (e) => {
            state.spammerSpeed = parseInt(e.target.value);
            value.textContent = state.spammerSpeed + 'ms';
            callback(state.spammerSpeed);
        };
        
        container.appendChild(label);
        container.appendChild(input);
        container.appendChild(value);
        this.content.appendChild(container);
    }
}

// ==================== INITIALIZATION ====================

function init() {
    // Check if we're in a meeting
    if (!location.pathname.includes('/wc/')) {
        // Auto-redirect if on join page
        if (location.pathname.startsWith('/j/')) {
            const id = location.pathname.replace('/j/', '');
            location.href = location.origin + '/wc/join/' + id + location.search;
        }
        return;
    }
    
    // Initialize main module
    const mainModule = new ZoomModule();
    window.Thugware = mainModule;
    
    // Create UI
    const panel = new Panel('THUGWARE v2.0');
    
    // Speed control
    panel.addSlider('Speed', 100, 5000, (val) => {
        state.spammerSpeed = val;
    });
    
    // Feature buttons
    panel.addButton('Auto Unmute/Video', Features.autoMedia);
    panel.addButton('Chat Spammer', Features.chatSpam);
    panel.addButton('Hand Raise Spam', Features.handSpam);
    panel.addButton('Name Changer', Features.nameSpam);
    panel.addButton('Reaction Spam', Features.reactionSpam);
    panel.addButton('AI Request Spam', Features.aiSpam);
    panel.addButton('Screenshare Spam', Features.screenshareSpam);
    panel.addButton('Auto Rejoin', Features.autoRejoin);
    panel.addButton('Visible Bots', Features.botPanel);
    panel.addButton('Hidden Bots', Features.floodBots);
    
    console.log('[Thugware] Loaded successfully');
}

// Wait for page to be ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}